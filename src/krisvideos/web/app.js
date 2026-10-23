/* KrisVideos — minimal editor UI.
   State lives in P (project JSON). Every edit round-trips through the API, which rewrites project.yaml.
   The player plays the timeline live from clip proxies (instant scrubbing) and switches to the
   rendered preview automatically whenever one exists and is up to date. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (t, d = 1) => { t = Math.max(0, +t || 0); const m = Math.floor(t / 60); const s = t - m * 60; return `${m}:${s.toFixed(d).padStart(d ? 3 + d : 2, '0')}`; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

let P = null, sel = null, selVo = null, selMusic = false;
let T = 0, playing = false, job = null, pollTimer = null, lastYaml = '';
const clock = { t0: 0, wall: 0 };

// ------------------------------------------------------------------ api / ui helpers
async function api(method, url, body, raw = false) {
  const opts = { method, headers: {} };
  if (body instanceof FormData || body instanceof Blob) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (body instanceof Blob) opts.headers['Content-Type'] = 'application/octet-stream';
  const r = await fetch(url, opts);
  if (!r.ok) { let msg = r.statusText; try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { } const e = new Error(msg); e.status = r.status; throw e; }
  return raw ? r : r.json();
}
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 2200); }
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, true); console.error(e); } }
function sheet(html, { wide = false } = {}) {
  $('#sheetBody').innerHTML = html; $('#sheet').classList.remove('hidden'); $('.sheetbox').classList.toggle('wide', wide);
  const f = $('#sheetBody input[type=text], #sheetBody input:not([type=checkbox]), #sheetBody textarea'); if (f) setTimeout(() => f.focus(), 30);
  $$('[data-close]').forEach(b => b.onclick = closeSheet);
  $('#sheetBody').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && $('#s_ok')) { e.preventDefault(); $('#s_ok').click(); } };
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBody').innerHTML = ''; }
$('#sheet').onclick = e => { if (e.target.id === 'sheet' && !$('#recBox')) closeSheet(); };
function popover(anchor, items) {
  const el = $('#popover');
  el.innerHTML = items.map(it => it === '-' ? '<div class="sep"></div>' : `<button class="item ${it.sel ? 'sel' : ''}" data-i="${items.indexOf(it)}">${esc(it.label)}${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}</button>`).join('');
  const r = anchor.getBoundingClientRect(); el.style.left = `${Math.min(r.left, innerWidth - 260)}px`; el.style.top = `${r.bottom + 6}px`;
  el.classList.remove('hidden');
  $$('.item', el).forEach(b => b.onclick = () => { closePopover(); items[+b.dataset.i].fn(); });
  setTimeout(() => document.addEventListener('mousedown', closePopover, { once: true }), 0);
}
function closePopover() { $('#popover').classList.add('hidden'); }
const field = (label, inner) => `<div class="field"><label>${label}</label>${inner}</div>`;

// ------------------------------------------------------------------ projects
async function loadProjects(selectName) {
  const list = await api('GET', '/api/projects');
  if (!list.length) { $('#welcome').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#projTitle').textContent = 'KrisVideos'; return; }
  $('#welcome').classList.add('hidden'); $('#app').classList.remove('hidden');
  const name = selectName || localStorage.getItem('kv.project') || list[0].name;
  await openProject(list.some(p => p.name === name) ? name : list[0].name);
}
async function openProject(name) {
  localStorage.setItem('kv.project', name);
  sel = selVo = null; selMusic = false; T = 0; stop();
  VP.reset();
  setProject(await api('GET', `/api/projects/${name}`));
  checkRecoverable();
}
function setProject(p) {
  P = p;
  if (sel && !P.timeline.some(s => s.id === sel)) sel = null;
  if (selVo && !(P.voiceovers || []).some(v => v.id === selVo)) selVo = null;
  $('#projTitle').textContent = P.title || P.name;
  $('#projMeta').textContent = P.layout ? `${fmt(P.layout.total)} · ${P.layout.orientation}` : '';
  lastYaml = P.yaml;
  renderTimeline(); renderInspector();
  VP.projectChanged();
  if (P.final && !P.final.stale) { $('#doneBar').classList.remove('hidden'); $('#doneBar .msg').textContent = `Exported ${P.final.path.split('/').pop()} · ${(P.final.size / 1e6).toFixed(1)} MB`; }
  else $('#doneBar').classList.add('hidden');
  const pending = P.timeline.some(s => s.kind === 'clip' && !s.missing && (!s.proxy_url || !s.thumb_url));
  clearTimeout(setProject._t); if (pending) setProject._t = setTimeout(refresh, 2000);
}
async function refresh() { if (P) setProject(await api('GET', `/api/projects/${P.name}`)); }
setInterval(async () => { if (!P || job || $('#sheetBody').children.length) return; try { const p = await api('GET', `/api/projects/${P.name}`); if (p.yaml !== lastYaml) setProject(p); } catch { } }, 3000);
const seg = () => P && P.timeline.find(s => s.id === sel);
const total = () => (P && P.layout) ? P.layout.total : 0;
function locate(t) {
  if (!P) return null;
  const segs = P.timeline.filter(s => s.placed);
  for (const s of segs) if (t >= s.placed.start && t < s.placed.end) return { seg: s, off: t - s.placed.start };
  const last = segs[segs.length - 1];
  return last && t >= last.placed.end ? { seg: last, off: last.placed.duration } : (segs[0] ? { seg: segs[0], off: 0 } : null);
}

// ------------------------------------------------------------------ virtual player
const VP = (() => {
  const vA = $('#vA'), vB = $('#vB');
  let cur = vA, nxt = vB, rendered = false, lastSeg = null;
  const show = v => { v.classList.remove('hidden'); (v === vA ? vB : vA).classList.add('hidden'); };
  function useRendered() { return !!(P && P.preview && !P.preview.stale); }
  function setSrc(v, url) { if (v.dataset.url !== url) { v.dataset.url = url; v.src = url; v.load(); } }
  function reset() { for (const v of [vA, vB]) { v.pause(); v.removeAttribute('src'); v.dataset.url = ''; v.load(); } lastSeg = null; }
  function projectChanged() {
    const r = useRendered();
    if (r !== rendered) { rendered = r; lastSeg = null; }
    $('#modeChip').textContent = !P.timeline.length ? '' : rendered ? 'Rendered preview' : (P.preview ? 'Live · render preview for transitions & audio mix' : 'Live · proxies');
    $('#stageEmpty').classList.toggle('hidden', !!P.timeline.length);
    const L = P.layout; $('#canvas').style.aspectRatio = L ? `${L.width} / ${L.height}` : '16 / 9';
    // height:100% only works when the box is taller than the aspect allows; otherwise width-bound
    const box = $('#playerBox'); const ar = L ? L.width / L.height : 16 / 9;
    $('#canvas').style.height = (box.clientWidth / box.clientHeight > ar) ? '100%' : 'auto';
    $('#canvas').style.width = (box.clientWidth / box.clientHeight > ar) ? 'auto' : '100%';
    $('#stageEmpty').innerHTML = 'Nothing here yet.<br><small>Add clips or record something.</small>';
    sync(T, true);
  }
  function card(s) {
    const c = $('#card'); c.classList.remove('hidden'); c.style.background = P.style.title_bg; c.style.color = P.style.title_fg;
    $('.t', c).textContent = s.title; $('.s', c).textContent = s.subtitle || ''; $('.s', c).style.color = P.style.title_accent; $('.rule', c).style.background = P.style.title_accent;
    $('.t', c).style.fontFamily = `"${P.style.font}", -apple-system, sans-serif`;
    vA.classList.add('hidden'); vB.classList.add('hidden');
  }
  function captions(s, off) {
    const L = $('#capLayer'); L.innerHTML = '';
    if (!s || s.kind !== 'clip') return;
    const items = [];
    if (s.caption) items.push({ text: s.caption, position: 'bottom', style: 'caption' });
    for (const o of s.overlays || []) { const a = o.at || 0, b = o.for == null ? Infinity : a + o.for; if (off >= a && off < b) items.push(o); }
    for (const o of items) { const d = document.createElement('div'); d.className = (o.style === 'big' ? 'capBig ' : 'capPill ') + (o.position || 'bottom'); d.textContent = o.text; L.appendChild(d); }
  }
  // Show the frame for timeline time t. If `hard`, always reseek.
  function sync(t, hard = false) {
    if (!P || !P.timeline.length) { reset(); $('#card').classList.add('hidden'); captions(null); return; }
    if (rendered) {
      $('#card').classList.add('hidden'); captions(null);
      setSrc(vA, P.preview.url); show(vA); cur = vA;
      if (hard || Math.abs(vA.currentTime - t) > 0.25) vA.currentTime = t;
      vA.muted = false;
      return;
    }
    const L = locate(t); if (!L) return;
    const s = L.seg;
    if (s.kind === 'title') { card(s); captions(null); cur.pause(); lastSeg = s.id; return; }
    $('#card').classList.add('hidden');
    const url = s.proxy_url || s.src_url;
    if (!url || s.missing) { $('#card').classList.add('hidden'); captions(null); return; }
    const want = (s.in || 0) + L.off * (s.speed || 1);
    if (cur.dataset.url !== url) {
      if (nxt.dataset.url === url) { [cur, nxt] = [nxt, cur]; } else setSrc(cur, url);
    }
    show(cur);
    cur.playbackRate = clamp(s.speed || 1, 0.25, 4);
    cur.style.objectFit = s.fit === 'cover' ? 'cover' : 'contain';
    cur.muted = !!s.mute || !playing;
    const drift = Math.abs(cur.currentTime - want);
    if (hard || lastSeg !== s.id || drift > (playing ? 0.3 : 0.04)) { try { cur.currentTime = want; } catch { } }
    if (playing && cur.paused) cur.play().catch(() => { });
    if (!playing && !cur.paused) cur.pause();
    lastSeg = s.id;
    captions(s, L.off);
    // preload the next clip into the spare element
    const i = P.timeline.indexOf(s); const n = P.timeline[i + 1];
    if (n && n.kind === 'clip' && (n.proxy_url || n.src_url) && s.placed.duration - L.off < 2) {
      const nu = n.proxy_url || n.src_url;
      if (nxt.dataset.url !== nu && cur.dataset.url !== nu) { setSrc(nxt, nu); nxt.muted = true; nxt.addEventListener('loadedmetadata', () => { try { nxt.currentTime = n.in || 0; } catch { } }, { once: true }); }
    }
  }
  function showSource(s, srcTime) {  // used while dragging trim handles
    const url = s.proxy_url || s.src_url; if (!url) return;
    $('#card').classList.add('hidden'); if (cur.dataset.url !== url) setSrc(cur, url); show(cur); cur.pause(); cur.muted = true; cur.style.objectFit = s.fit === 'cover' ? 'cover' : 'contain';
    try { cur.currentTime = srcTime; } catch { } lastSeg = null;
  }
  function pauseAll() { vA.pause(); vB.pause(); }
  return { sync, showSource, pauseAll, reset, projectChanged, isRendered: () => rendered, video: () => cur };
})();

function play() {
  if (!P || !P.timeline.length) return;
  if (T >= total() - 0.05) T = 0;
  playing = true; clock.t0 = T; clock.wall = performance.now();
  if (VP.isRendered()) { VP.sync(T, true); VP.video().play().catch(() => { }); }
  $('#playIcon').setAttribute('d', 'M3 2h4v12H3zM9 2h4v12H9z');
  requestAnimationFrame(tick);
}
function stop() { playing = false; VP.pauseAll(); $('#playIcon').setAttribute('d', 'M4 2.5v11l9-5.5z'); }
function togglePlay() { playing ? stop() : play(); }
function tick() {
  if (!playing) return;
  if (VP.isRendered()) T = VP.video().currentTime; else T = clock.t0 + (performance.now() - clock.wall) / 1000;
  if (T >= total()) { T = total(); stop(); }
  VP.sync(T); updatePlayhead();
  if (playing) requestAnimationFrame(tick);
}
function seek(t, hard = false) { T = clamp(t, 0, total()); if (playing) { clock.t0 = T; clock.wall = performance.now(); if (VP.isRendered()) VP.video().currentTime = T; } VP.sync(T, hard); updatePlayhead(); }
$('#playBtn').onclick = togglePlay;
$('#vA').addEventListener('ended', () => { if (playing && VP.isRendered()) { T = total(); stop(); updatePlayhead(); } });

// ------------------------------------------------------------------ timeline
let pxPerSec = 20;
const trackPad = 0;
function renderTimeline() {
  const track = $('#track'), ruler = $('#ruler');
  $$('.block', track).forEach(b => b.remove());
  $('#tlEmpty').classList.toggle('hidden', !!P.timeline.length);
  const tot = Math.max(total(), 1);
  const avail = $('#tl').clientWidth - 24;
  pxPerSec = Math.max(12, avail / tot);
  const W = tot * pxPerSec;
  track.style.width = ruler.style.width = `${W}px`;
  // ruler
  const step = pxPerSec > 80 ? 1 : pxPerSec > 30 ? 5 : pxPerSec > 12 ? 10 : 30;
  let html = '';
  for (let t = 0; t <= tot; t += step / 5) { const major = Math.abs(t / step - Math.round(t / step)) < 1e-6; html += `<div class="tick ${major ? '' : 'minor'}" style="left:${t * pxPerSec}px">${major ? fmt(t, 0) : ''}</div>`; }
  ruler.innerHTML = html;
  for (const s of P.timeline) {
    if (!s.placed) continue;
    const b = document.createElement('div');
    const w = Math.max(6, s.placed.duration * pxPerSec);
    b.className = `block ${s.kind}${s.missing ? ' missing' : ''}${s.id === sel ? ' selected' : ''}`;
    b.style.left = `${s.placed.start * pxPerSec}px`; b.style.width = `${w}px`; b.dataset.id = s.id; b.draggable = true;
    if (s.kind === 'title') {
      b.innerHTML = `<div class="lbl">${esc(s.title)}</div>`;
    } else {
      const m = s.media || {}; const ar = m.width && m.height ? m.width / m.height : 16 / 9;
      const n = clamp(Math.ceil(w / (64 * ar)), 1, 40);
      const strip = s.proxy_url ? `<img class="strip" src="/api/projects/${P.name}/strip?src=${encodeURIComponent(s.clip)}&n=${n}&start=${s.placed.src_in}&end=${s.placed.src_out}&h=64" draggable="false">` : (s.thumb_url ? `<img class="strip" src="${s.thumb_url}" draggable="false">` : '');
      b.innerHTML = `${strip}${s.placed.transition !== 'cut' ? '<div class="xf"></div>' : ''}<div class="meta">${fmt(s.placed.duration)}${s.speed && s.speed !== 1 ? ` ×${s.speed}` : ''}${s.mute ? ' 🔇' : ''}</div>${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ''}<div class="lbl">${esc(s.clip.replace(/^clips\//, ''))}</div><div class="handle l"></div><div class="handle r"></div>`;
    }
    b.onclick = e => { if (e.target.classList.contains('handle')) return; select(s.id); seek(s.placed.start + clamp((e.clientX - b.getBoundingClientRect().left) / pxPerSec, 0, s.placed.duration), true); };
    b.ondblclick = () => openInspector();
    b.ondragstart = e => { e.dataTransfer.setData('text/seg', s.id); e.dataTransfer.effectAllowed = 'move'; };
    b.ondragover = e => { e.preventDefault(); b.classList.add('dragover'); };
    b.ondragleave = () => b.classList.remove('dragover');
    b.ondrop = e => { e.preventDefault(); b.classList.remove('dragover'); onDrop(e, s.id); };
    if (s.kind === 'clip') { $('.handle.l', b).onpointerdown = e => trimDrag(e, s, 'in'); $('.handle.r', b).onpointerdown = e => trimDrag(e, s, 'out'); }
    track.appendChild(b);
  }
  track.ondragover = e => e.preventDefault(); track.ondrop = e => { if (e.target === track) onDrop(e, null); };
  renderLanes(); updatePlayhead(); updateCtx();
}
function renderLanes() {
  const lanes = $('#lanes'); lanes.innerHTML = '';
  const tot = Math.max(total(), 1), W = tot * pxPerSec;
  const vos = P.voiceovers || [];
  if (vos.length) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`; l.innerHTML = '<span class="lanelbl">voice</span>';
    for (const v of vos) { const d = document.createElement('div'); d.className = 'vo' + (v.id === selVo ? ' selected' : ''); d.style.left = `${v.at * pxPerSec}px`; d.style.width = `${Math.max(14, (v.duration || 1) * pxPerSec)}px`; d.textContent = `${fmt(v.at)} · ${fmt(v.duration || 0)}`; d.onclick = e => { e.stopPropagation(); selVo = v.id; sel = null; selMusic = false; renderTimeline(); renderInspector(); seek(v.at, true); }; l.appendChild(d); }
    lanes.appendChild(l);
  }
  if (P.music && P.music.file) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`;
    const d = document.createElement('div'); d.className = 'mu' + (selMusic ? ' selected' : ''); d.textContent = `♫ ${P.music.file.split('/').pop()} · ${Math.round(P.music.volume * 100)}%${P.music.duck ? ' · ducked' : ''}`;
    d.onclick = e => { e.stopPropagation(); selMusic = true; sel = selVo = null; renderTimeline(); renderInspector(); }; l.appendChild(d); lanes.appendChild(l);
  }
}
function updatePlayhead() {
  const ph = $('#playhead'); ph.style.left = `${12 + T * pxPerSec - $('#tl').scrollLeft}px`; ph.classList.toggle('hidden', !P.timeline.length);
  const tot = total() || 1; $('#scrubber .fill').style.width = `${T / tot * 100}%`; $('#scrubber .knob').style.left = `${T / tot * 100}%`;
  $('#tNow').textContent = fmt(T); $('#tTotal').textContent = fmt(tot === 1 && !total() ? 0 : tot);
  // keep playhead visible while playing
  const tl = $('#tl'); const x = T * pxPerSec; if (playing && (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 40)) tl.scrollLeft = x - 40;
  updateCtx();
}
function updateCtx() {
  const L = locate(T); const overClip = L && L.seg.kind === 'clip' && L.off > 0.2 && L.seg.placed.duration - L.off > 0.2;
  for (const a of ['split', 'trimStart', 'trimEnd']) $(`[data-act=${a}]`).disabled = !overClip;
  $('[data-act=title]').disabled = !P.timeline.length;
}
$('#tl').addEventListener('scroll', updatePlayhead);
// scrubbing on the ruler (and the scrubber bar)
function scrubSurface(el, toTime) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); const wasPlaying = playing; stop();
    const move = ev => seek(toTime(ev)); move(e);
    el.setPointerCapture(e.pointerId);
    el.onpointermove = move;
    el.onpointerup = () => { el.onpointermove = el.onpointerup = null; if (wasPlaying) play(); };
  });
}
scrubSurface($('#ruler'), ev => (ev.clientX - $('#ruler').getBoundingClientRect().left) / pxPerSec);
scrubSurface($('#scrubber'), ev => { const r = $('#scrubber').getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * total(); });
$('#track').addEventListener('pointerdown', e => { if (e.target === $('#track') || e.target.id === 'tlEmpty') { select(null); } });

function trimDrag(e, s, which) {
  e.preventDefault(); e.stopPropagation(); stop(); select(s.id);
  const b = e.currentTarget.closest('.block'); const x0 = e.clientX; const m = s.media || {}; const dur = m.duration || (s.placed.src_out);
  const in0 = s.placed.src_in, out0 = s.placed.src_out; let nin = in0, nout = out0;
  const h = e.currentTarget; h.setPointerCapture(e.pointerId);
  h.onpointermove = ev => {
    const ds = (ev.clientX - x0) / pxPerSec * (s.speed || 1);
    if (which === 'in') { nin = clamp(in0 + ds, 0, out0 - 0.2); VP.showSource(s, nin); b.style.left = `${(s.placed.start + (nin - in0) / (s.speed || 1)) * pxPerSec}px`; b.style.width = `${(out0 - nin) / (s.speed || 1) * pxPerSec}px`; }
    else { nout = clamp(out0 + ds, in0 + 0.2, dur); VP.showSource(s, nout); b.style.width = `${(nout - in0) / (s.speed || 1) * pxPerSec}px`; }
    $('.meta', b).textContent = fmt((nout - nin) / (s.speed || 1));
  };
  h.onpointerup = () => {
    h.onpointermove = h.onpointerup = null;
    if (Math.abs(nin - in0) < 0.01 && Math.abs(nout - out0) < 0.01) { renderTimeline(); return; }
    patchSeg(s.id, which === 'in' ? { in: nin } : { out: nout }).then(() => { const ns = seg(); if (ns) seek(which === 'in' ? ns.placed.start : ns.placed.end - 0.05, true); });
  };
}
async function onDrop(e, targetId) {
  const segId = e.dataTransfer.getData('text/seg'); if (!segId) return;
  const ids = P.timeline.map(s => s.id); let at = targetId ? ids.indexOf(targetId) : ids.length;
  if (targetId) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX > r.left + r.width / 2) at++; }
  const from = ids.indexOf(segId); if (from < 0) return; ids.splice(from, 1); if (at > from) at--; ids.splice(at, 0, segId);
  await guard(async () => setProject(await api('POST', `/api/projects/${P.name}/reorder`, { ids })));
}
function select(id) { sel = id; selVo = null; selMusic = false; $$('#track .block').forEach(b => b.classList.toggle('selected', b.dataset.id === id)); $$('#lanes .selected').forEach(x => x.classList.remove('selected')); renderInspector(); }

// ------------------------------------------------------------------ edits
async function patchSeg(id, body) { return guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/segments/${id}`, body)); }); }
async function patchProject(body) { return guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}`, body)); }); }
const ctxActions = {
  split: () => guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/split`, { time: T })); }),
  title: () => titleAt(T),
  trimStart: () => { const L = locate(T); if (L && L.seg.kind === 'clip') patchSeg(L.seg.id, { in: L.seg.placed.src_in + L.off * (L.seg.speed || 1) }).then(() => seek(L.seg.placed.start, true)); },
  trimEnd: () => { const L = locate(T); if (L && L.seg.kind === 'clip') patchSeg(L.seg.id, { out: L.seg.placed.src_in + L.off * (L.seg.speed || 1) }); },
  addTitle: () => addTitleSheet(),
  record: () => openRecorder('clip'),
  music: () => { selMusic = true; sel = selVo = null; renderInspector(); if (!(P.music && P.music.file)) pickMusic(); },
};
$$('#ctx [data-act]').forEach(b => b.onclick = () => ctxActions[b.dataset.act]());
function titleAt(t) {
  sheet(`<h2>Cut to a title card at ${fmt(t)}</h2>
    ${field('Title', '<input id="m_t" type="text" placeholder="Lunch">')}${field('Subtitle', '<input id="m_s" type="text" placeholder="optional">')}
    ${field('Seconds on screen', '<input id="m_d" type="number" value="2.5" step="0.5" min="0.5">')}
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Insert</button></div>`);
  $('#s_ok').onclick = () => guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/title-at`, { time: t, text: $('#m_t').value || 'Title', subtitle: $('#m_s').value, duration: +$('#m_d').value })); closeSheet(); });
}
function addTitleSheet() {
  sheet(`<h2>Add a title card</h2>
    ${field('Title', '<input id="m_t" type="text" placeholder="Lunch">')}${field('Subtitle', '<input id="m_s" type="text" placeholder="optional">')}
    ${field('Seconds on screen', '<input id="m_d" type="number" value="3" step="0.5" min="0.5">')}
    ${field('Place', `<select id="m_at"><option value="">at the end</option><option value="0">at the beginning</option>${sel ? '<option value="after" selected>after the selected segment</option>' : ''}</select>`)}
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Add</button></div>`);
  $('#s_ok').onclick = () => guard(async () => { let at = $('#m_at').value; at = at === 'after' ? P.timeline.findIndex(s => s.id === sel) + 1 : at === '' ? null : +at; setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'title', text: $('#m_t').value || 'Title', subtitle: $('#m_s').value, duration: +$('#m_d').value, at })); closeSheet(); });
}
async function pickMusic() { await guard(async () => { const r = await api('POST', '/api/pick', { kind: 'music' }); if (r.paths[0]) await patchProject({ music: { file: r.paths[0] } }); }); }

// ------------------------------------------------------------------ inspector
function openInspector() { $('#app').classList.add('with-inspector'); $('#inspector').classList.remove('hidden'); }
function closeInspector() { $('#app').classList.remove('with-inspector'); $('#inspector').classList.add('hidden'); }
function renderInspector() {
  const el = $('#inspBody'); const s = seg(); const v = (P.voiceovers || []).find(x => x.id === selVo);
  if (!s && !v && !selMusic) { closeInspector(); return; }
  openInspector();
  const close = '<button class="close" id="inspClose">✕</button>';
  if (selMusic) { renderMusicInspector(el, close); return; }
  if (v) { renderVoInspector(el, v, close); return; }
  const trOpts = ['', 'cut', 'fade', 'dip'].map(x => `<option value="${x}" ${(s.transition || '') === x ? 'selected' : ''}>${x || `default (${P.style.transition})`}</option>`).join('');
  let html;
  if (s.kind === 'title') {
    html = `<h3>Title card ${close}</h3>` + field('Title', `<input type="text" data-k="text" value="${esc(s.title)}">`) + field('Subtitle', `<input type="text" data-k="subtitle" value="${esc(s.subtitle || '')}">`) + field('Seconds', `<input type="number" data-k="duration" step="0.5" min="0.5" value="${s.duration}">`);
  } else {
    const m = s.media || {};
    html = `<h3>Clip <span class="sub" title="${esc(s.clip)}">${esc(s.clip.replace(/^clips\//, ''))}</span>${close}</h3>` +
      `<div class="muted" style="margin:-6px 0 12px">${m.width ? `${m.width}×${m.height}${m.hdr ? ' HDR' : ''} · ${fmt(m.duration)}` : ''}${s.lufs != null ? ` · ${s.lufs.toFixed(0)} LUFS` : ''}${s.missing ? ' · <b style="color:var(--danger)">file missing</b>' : ''}</div>` +
      field('In → out (source time)', `<div class="inline"><input type="text" data-k="in" value="${fmt(s.in || 0, 2)}"><span class="muted">→</span><input type="text" data-k="out" value="${s.out == null ? 'end' : fmt(s.out, 2)}"></div>`) +
      field('Caption', `<input type="text" data-k="caption" value="${esc(s.caption || '')}" placeholder="lower third for the whole clip">`) +
      `<div class="field"><label>Text overlays</label><div id="ovList"></div><button class="link" id="ovAdd" style="align-self:flex-start">+ Add overlay at playhead</button></div>` +
      field('Speed', `<div class="inline"><input type="range" data-k="speed" min="0.25" max="4" step="0.25" value="${s.speed || 1}"><span id="speedLbl" style="width:34px">${s.speed || 1}×</span></div>`) +
      field('Fit', `<select data-k="fit"><option value="contain" ${s.fit !== 'cover' ? 'selected' : ''}>Letterbox (show everything)</option><option value="cover" ${s.fit === 'cover' ? 'selected' : ''}>Crop to fill</option></select>`) +
      `<div class="check"><input type="checkbox" id="muteChk" ${s.mute ? 'checked' : ''}><label for="muteChk">Mute</label></div>` +
      field('Volume', `<input type="range" data-k="volume" min="0" max="2" step="0.1" value="${s.volume ?? 1}">`);
  }
  html += field('Transition in', `<div class="inline"><select data-k="transition">${trOpts}</select><input type="number" data-k="transition_duration" step="0.1" min="0.1" max="3" value="${s.transition_duration ?? ''}" placeholder="${P.style.transition_duration}s" style="flex:0 0 64px"></div>`);
  html += `<div class="sep"></div><div class="actions"><button class="link" id="segUp">← Move</button><button class="link" id="segDown">Move →</button><button class="link" id="segDup">Duplicate</button><span class="spacer"></span><button class="link danger" id="segDelete">Delete</button></div>`;
  el.innerHTML = html;
  $('#inspClose').onclick = () => select(null);
  $$('[data-k]', el).forEach(inp => {
    const k = inp.dataset.k;
    const commit = () => patchSeg(s.id, { [k]: inp.type === 'number' || inp.type === 'range' ? (inp.value === '' ? '' : +inp.value) : inp.value });
    if (inp.type === 'range') { inp.oninput = () => { if (k === 'speed') $('#speedLbl').textContent = inp.value + '×'; }; inp.onchange = commit; }
    else { inp.onchange = commit; inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); }; }
  });
  if ($('#muteChk')) $('#muteChk').onchange = e => patchSeg(s.id, { mute: e.target.checked });
  $('#segDelete').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/segments/${s.id}`)); });
  const move = d => { const ids = P.timeline.map(x => x.id); const i = ids.indexOf(s.id); const j = clamp(i + d, 0, ids.length - 1); if (i === j) return; ids.splice(i, 1); ids.splice(j, 0, s.id); guard(async () => setProject(await api('POST', `/api/projects/${P.name}/reorder`, { ids }))); };
  $('#segUp').onclick = () => move(-1); $('#segDown').onclick = () => move(1);
  $('#segDup').onclick = () => guard(async () => {
    const at = P.timeline.findIndex(x => x.id === s.id) + 1;
    const p = await api('POST', `/api/projects/${P.name}/segments`, s.kind === 'title' ? { kind: 'title', text: s.title, subtitle: s.subtitle, duration: s.duration, at } : { kind: 'clip', src: s.clip, at });
    if (s.kind === 'clip') await api('PATCH', `/api/projects/${P.name}/segments/${p.timeline[at].id}`, { in: s.in, out: s.out ?? '', speed: s.speed, mute: s.mute, caption: s.caption || '', fit: s.fit });
    await refresh();
  });
  if (s.kind === 'clip') renderOverlays(s);
}
function renderOverlays(s) {
  const box = $('#ovList');
  box.innerHTML = s.overlays.map(o => `<div class="ov"><input type="text" class="ov-text" value="${esc(o.text)}" placeholder="text" style="width:100%">
      <div class="inline"><span class="muted">at</span><input type="number" class="ov-at" step="0.5" min="0" value="${o.at}"><span class="muted">for</span><input type="number" class="ov-for" step="0.5" min="0.5" value="${o.for ?? ''}" placeholder="rest">
        <select class="ov-pos"><option ${o.position === 'bottom' || !o.position ? 'selected' : ''}>bottom</option><option ${o.position === 'top' ? 'selected' : ''}>top</option><option ${o.position === 'center' ? 'selected' : ''}>center</option></select>
        <select class="ov-style"><option value="caption" ${o.style !== 'big' ? 'selected' : ''}>pill</option><option value="big" ${o.style === 'big' ? 'selected' : ''}>big</option></select>
        <button class="link muted ov-del">✕</button></div></div>`).join('');
  const commit = () => patchSeg(s.id, { overlays: $$('.ov', box).map(d => { const o = { text: $('.ov-text', d).value, at: +$('.ov-at', d).value || 0, position: $('.ov-pos', d).value, style: $('.ov-style', d).value }; if ($('.ov-for', d).value !== '') o.for = +$('.ov-for', d).value; return o; }) });
  $$('input, select', box).forEach(i => { i.onchange = commit; i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
  $$('.ov-del', box).forEach(b => b.onclick = () => { b.closest('.ov').remove(); commit(); });
  $('#ovAdd').onclick = () => { const L = locate(T); const at = L && L.seg.id === s.id ? +L.off.toFixed(2) : 0; patchSeg(s.id, { overlays: [...s.overlays, { text: 'new overlay', at, for: 3 }] }); };
}
function renderVoInspector(el, v, close) {
  el.innerHTML = `<h3>Narration ${close}</h3><div class="muted" style="margin:-6px 0 12px">${fmt(v.duration || 0)}${v.lufs != null ? ` · ${v.lufs.toFixed(0)} LUFS` : ''}</div>` +
    field('Starts at', `<div class="inline"><input type="text" id="voAt" value="${fmt(v.at, 2)}"><button class="link" id="voAtPh" title="move to playhead">← playhead</button></div>`) +
    field('Volume', `<input type="range" id="voVol" min="0" max="2" step="0.1" value="${v.volume}">`) +
    `<div class="check"><input type="checkbox" id="voDuck" ${v.duck_clips ? 'checked' : ''}><label for="voDuck">Lower clip audio while this plays</label></div>` +
    `<div class="sep"></div><div class="actions"><button class="link" id="voPlay">▶ Listen</button><span class="spacer"></span><button class="link danger" id="voDel">Delete</button></div><audio id="voAudio" src="${v.url || ''}"></audio>`;
  $('#inspClose').onclick = () => { selVo = null; renderTimeline(); renderInspector(); };
  const patch = body => guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/voiceovers/${v.id}`, body)); });
  $('#voAt').onchange = e => patch({ at: e.target.value }); $('#voAt').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#voAtPh').onclick = () => patch({ at: T });
  $('#voVol').onchange = e => patch({ volume: +e.target.value });
  $('#voDuck').onchange = e => patch({ duck_clips: e.target.checked });
  $('#voPlay').onclick = () => { const a = $('#voAudio'); a.paused ? a.play() : a.pause(); };
  $('#voDel').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/voiceovers/${v.id}`)); selVo = null; renderInspector(); });
}
function renderMusicInspector(el, close) {
  const m = P.music;
  el.innerHTML = `<h3>Music ${close}</h3>` +
    field('File', `<div class="inline"><input type="text" id="muFile" value="${esc(m.file || '')}" placeholder="none"><button class="link" id="muPick">Choose…</button></div>`) +
    (m.file ? field('Volume', `<input type="range" id="muVol" min="0" max="1" step="0.02" value="${m.volume}">`) +
      `<div class="check"><input type="checkbox" id="muDuck" ${m.duck ? 'checked' : ''}><label for="muDuck">Duck under speech</label></div>` +
      field('Start offset (s)', `<input type="number" id="muStart" step="1" min="0" value="${m.start}">`) +
      `<div class="sep"></div><div class="actions"><span class="spacer"></span><button class="link danger" id="muRm">Remove music</button></div>` : '<p class="muted">Music loops under the whole vlog, ducks under speech, and fades out at the end.</p>');
  $('#inspClose').onclick = () => { selMusic = false; renderTimeline(); renderInspector(); };
  $('#muFile').onchange = e => patchProject({ music: { file: e.target.value } }); $('#muPick').onclick = pickMusic;
  if (m.file) { $('#muVol').onchange = e => patchProject({ music: { volume: +e.target.value } }); $('#muDuck').onchange = e => patchProject({ music: { duck: e.target.checked } }); $('#muStart').onchange = e => patchProject({ music: { start: +e.target.value } }); $('#muRm').onclick = () => patchProject({ music: { file: '' } }).then(() => { selMusic = false; renderInspector(); }); }
}

// ------------------------------------------------------------------ add menu / library
$('#addBtn').onclick = e => popover(e.currentTarget, [
  { label: 'From Immich…', fn: () => openLibrary('immich') },
  { label: 'From files…', fn: () => openLibrary('files') },
  { label: 'Record camera…', k: 'R', fn: () => openRecorder('clip') },
  { label: 'Record voiceover…', fn: () => openRecorder('voiceover') },
  '-',
  { label: 'Title card', fn: addTitleSheet },
  { label: 'Music…', fn: () => ctxActions.music() },
]);
let immichVids = [], picked = new Set();
function openLibrary(tab) {
  sheet(`<div class="tabs"><button class="tab ${tab === 'immich' ? 'active' : ''}" data-t="immich">Immich</button><button class="tab ${tab === 'files' ? 'active' : ''}" data-t="files">Files</button><button class="tab ${tab === 'clips' ? 'active' : ''}" data-t="clips">In this project</button></div>
    <div id="libBody"></div>`, { wide: true });
  $$('.tabs .tab').forEach(b => b.onclick = () => { $$('.tabs .tab').forEach(x => x.classList.toggle('active', x === b)); renderLib(b.dataset.t); });
  renderLib(tab);
}
function renderLib(tab) {
  const b = $('#libBody');
  if (tab === 'files') {
    b.innerHTML = `<div class="actions"><button class="pill" id="pickFiles">Choose files…</button><button class="pill" id="pickFolder">Choose a folder…</button></div><div class="drop" id="dropZone">…or drop videos here</div>`;
    $('#pickFiles').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'files' }); if (r.paths.length) importPaths(r.paths); });
    $('#pickFolder').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'folder' }); if (r.paths.length) importPaths(r.paths); });
    const dz = $('#dropZone');
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); }; dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); const fd = new FormData(); for (const f of e.dataTransfer.files) fd.append('files', f); toast('Uploading…'); guard(async () => { const r = await api('POST', `/api/projects/${P.name}/upload`, fd); setProject(r.project); toast(`Imported ${r.added.length} clip(s)`); closeSheet(); }); };
  } else if (tab === 'clips') {
    b.innerHTML = P.clips.length ? `<div class="cards">${P.clips.map(c => `<div class="card ${c.in_timeline ? 'inproj' : ''}" data-src="${esc(c.src)}">${c.thumb_url ? `<img src="${c.thumb_url}">` : '<div class="noimg">…</div>'}<div class="ci">${esc(c.name)}${c.media ? ` · ${fmt(c.media.duration)}` : ''}</div>${c.in_timeline ? '<span class="badge">in timeline</span>' : ''}</div>`).join('')}</div><p class="muted">Click a clip to add it to the end of the timeline.</p>` : '<div class="hint">No clips in this project yet.</div>';
    $$('.card', b).forEach(c => c.onclick = () => guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'clip', src: c.dataset.src })); toast('Added'); }));
  } else {
    b.innerHTML = `<div class="inline" style="margin-bottom:10px"><input type="date" id="immichDate" value="${P.date || new Date().toISOString().slice(0, 10)}" style="flex:0 0 150px"><select id="immichDays" style="flex:0 0 90px"><option value="1">1 day</option><option value="2">2 days</option><option value="7">week</option></select><span class="spacer"></span><button class="pill sm" id="immichAddSel" disabled>Add selected</button><button class="pill sm primary" id="immichAddAll">Add all</button></div><div id="immichList"><div class="hint">Loading…</div></div>`;
    $('#immichDate').onchange = $('#immichDays').onchange = loadImmich;
    $('#immichAddAll').onclick = () => { const have = new Set(P.clips.map(c => c.name)); importImmich(immichVids.filter(v => !have.has(v.filename))); };
    $('#immichAddSel').onclick = () => importImmich(immichVids.filter(v => picked.has(v.id)));
    loadImmich();
  }
}
async function loadImmich() {
  const box = $('#immichList'); if (!box) return; picked.clear();
  try { immichVids = await api('GET', `/api/immich/videos?date=${$('#immichDate').value}&days=${$('#immichDays').value}`); }
  catch (e) { box.innerHTML = `<div class="hint">${esc(e.message)}<br><br><button class="pill" onclick="openSettings('app')">Set up Immich</button></div>`; return; }
  if (!immichVids.length) { box.innerHTML = '<div class="hint">No videos on that day.</div>'; return; }
  const have = new Set(P.clips.map(c => c.name));
  box.innerHTML = `<div class="cards">${immichVids.map(v => `<div class="card ${have.has(v.filename) ? 'inproj' : ''}" data-id="${v.id}"><img src="${v.thumb_url}" loading="lazy"><div class="ci">${esc((v.taken_at || '').slice(11, 16))} · ${esc((v.duration || '').replace(/^0?0:|\.\d+$/g, ''))}</div>${have.has(v.filename) ? '<span class="badge">✓</span>' : ''}</div>`).join('')}</div><p class="muted">Click to select, then <b>Add selected</b> — or <b>Add all</b>.</p>`;
  $$('.card', box).forEach(c => c.onclick = () => { if (c.classList.contains('inproj')) return; c.classList.toggle('picked'); c.classList.contains('picked') ? picked.add(c.dataset.id) : picked.delete(c.dataset.id); $('#immichAddSel').disabled = !picked.size; });
}
async function importPaths(paths) { await guard(async () => { const r = await api('POST', `/api/projects/${P.name}/import`, { paths }); setProject(r.project); toast(`Imported ${r.added.length} clip(s)`); closeSheet(); }); }
async function importImmich(assets) {
  if (!assets.length) return toast('Nothing to add');
  closeSheet();
  await guard(async () => { const j = await api('POST', `/api/projects/${P.name}/import-immich`, { assets: assets.map(a => ({ id: a.id, filename: a.filename })) }); watchJob(j, async () => { await refresh(); toast(`Added ${assets.length} clip(s)`); }); });
}

// ------------------------------------------------------------------ jobs / render
function watchJob(j, onDone) {
  job = j; const bar = $('#jobBar'); bar.classList.remove('hidden'); $('#doneBar').classList.add('hidden');
  $('#renderPreviewBtn').disabled = $('#exportBtn').disabled = true; clearInterval(pollTimer);
  const label = { preview: 'Rendering preview', render: 'Exporting', import: 'Importing' }[j.kind] || j.kind;
  pollTimer = setInterval(async () => {
    try { j = await api('GET', `/api/jobs/${j.id}`); } catch { return; }
    $('#jobBar .fill').style.width = `${Math.round(j.progress * 100)}%`;
    $('#jobBar .msg').textContent = `${label} · ${Math.round(j.progress * 100)}%${j.message ? ' · ' + j.message : ''}`;
    if (j.status !== 'running') {
      clearInterval(pollTimer); job = null; bar.classList.add('hidden'); $('#renderPreviewBtn').disabled = $('#exportBtn').disabled = false;
      if (j.status === 'error') toast(`${label} failed: ${j.error.split('\n').slice(-2).join(' ')}`, true);
      else if (j.status === 'cancelled') toast('Cancelled');
      else { (j.warnings || []).forEach(w => toast(w, true)); if (onDone) await onDone(j); }
    }
  }, 400);
}
$('#jobCancel').onclick = () => job && api('POST', `/api/jobs/${job.id}/cancel`);
function startRender(kind) {
  if (!P.timeline.length) return toast('Nothing to render yet');
  guard(async () => { const j = await api('POST', `/api/projects/${P.name}/${kind}`); const t = T; watchJob(j, async () => { await refresh(); if (kind === 'preview') { seek(t, true); toast('Preview ready'); } else toast('Export complete'); }); });
}
$('#renderPreviewBtn').onclick = () => startRender('preview');
$('#exportBtn').onclick = () => startRender('render');
$('#revealBtn').onclick = () => P.final && api('POST', '/api/reveal', { path: P.final.path });
$('#openBtn').onclick = () => P.final && api('POST', '/api/open', { path: P.final.path });
$('#doneClose').onclick = () => $('#doneBar').classList.add('hidden');

// ------------------------------------------------------------------ script / settings / projects
$('#scriptBtn').onclick = () => {
  sheet(`<h2>Script <span class="muted" style="font-weight:400;font-size:12px">project.yaml · ⌘⏎ to apply</span></h2><textarea id="script" spellcheck="false">${esc(P.yaml)}</textarea>
    <div class="foot"><button class="link muted" id="showCmd">ffmpeg command</button><span class="spacer"></span><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Apply</button></div>`, { wide: true });
  $('#s_ok').onclick = () => guard(async () => { setProject(await api('PUT', `/api/projects/${P.name}/yaml`, { yaml: $('#script').value })); closeSheet(); toast('Applied'); });
  $('#script').onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#s_ok').click(); } if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } };
  $('#showCmd').onclick = () => guard(async () => { const r = await api('GET', `/api/projects/${P.name}/command`); sheet(`<h2>ffmpeg command</h2><pre>${esc(r.command)}</pre><div class="foot"><button class="pill" data-close>Close</button></div>`, { wide: true }); });
};
$('#gearBtn').onclick = () => openSettings('vlog');
async function openSettings(tab) {
  const s = await api('GET', '/api/settings');
  const opt = (vals, cur) => vals.map(v => `<option ${String(v) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const o = P ? P.output : {}, st = P ? P.style : {}, a = P ? P.audio : {};
  sheet(`<div class="tabs"><button class="tab ${tab === 'vlog' ? 'active' : ''}" data-t="vlog" ${P ? '' : 'disabled'}>This vlog</button><button class="tab ${tab === 'app' ? 'active' : ''}" data-t="app">App & Immich</button></div>
    <div id="setVlog" class="${tab === 'vlog' ? '' : 'hidden'}">
      ${field('Title', `<input type="text" id="v_title" value="${esc(P ? P.title : '')}">`)}
      <div class="inline">${field('Orientation', `<select id="v_or">${opt(['auto', 'portrait', 'landscape', 'square'], o.orientation)}</select>`)}${field('Transitions', `<select id="v_tr">${opt(['cut', 'fade', 'dip'], st.transition)}</select>`)}${field('Length (s)', `<input type="number" id="v_trd" step="0.1" min="0.1" value="${st.transition_duration}">`)}</div>
      <div class="inline">${field('Fade in (s)', `<input type="number" id="v_fi" step="0.1" min="0" value="${st.fade_in}">`)}${field('Fade out (s)', `<input type="number" id="v_fo" step="0.1" min="0" value="${st.fade_out}">`)}</div>
      ${field('Title cards', `<div class="inline"><input type="color" id="v_bg" value="${st.title_bg}" title="background"><input type="color" id="v_fg" value="${st.title_fg}" title="text"><input type="text" id="v_font" value="${esc(st.font)}" placeholder="font family"></div>`)}
      <div class="inline">${field('Codec', `<select id="v_codec">${opt(['h264', 'hevc'], o.codec)}</select>`)}${field('Quality', `<select id="v_q">${opt(['high', 'medium'], o.quality)}</select>`)}${field('FPS', `<select id="v_fps">${opt([24, 30, 60], o.fps)}</select>`)}</div>
      <div class="check"><input type="checkbox" id="v_norm" ${a.normalize ? 'checked' : ''}><label for="v_norm">Normalize final loudness</label></div>
      <div class="check"><input type="checkbox" id="v_match" ${a.match_levels ? 'checked' : ''}><label for="v_match">Match clip & voice levels</label></div>
      <div class="actions"><button class="link" id="openFolder">Open project folder</button><span class="spacer"></span><button class="link danger" id="delProj">Delete this vlog…</button></div>
    </div>
    <div id="setApp" class="${tab === 'app' ? '' : 'hidden'}">
      ${field('Immich URL', `<input id="s_url" type="text" value="${esc(s.immich_url)}" placeholder="http://immich.local:2283">`)}
      ${field('Immich API key', `<input id="s_key" type="password" value="${esc(s.immich_api_key)}" placeholder="Immich → Account settings → API keys">`)}
      ${field('Vlogs folder', `<input id="s_dir" type="text" value="${esc(s.vlogs_dir)}">`)}
      ${field('Opening card subtitle', `<input id="s_sub" type="text" value="${esc(s.default_title_subtitle)}" placeholder="e.g. a daily vlog">`)}
      ${field('Default music', `<input id="s_music" type="text" value="${esc(s.default_music)}" placeholder="optional path">`)}
      <div class="inline">${field('Default orientation', `<select id="s_or">${opt(['auto', 'portrait', 'landscape', 'square'], s.default_orientation)}</select>`)}${field('Default transition', `<select id="s_tr">${opt(['cut', 'fade', 'dip'], s.default_transition)}</select>`)}</div>
      <p class="muted">${esc(s.config_file)}</p>
    </div>
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Save</button></div>`);
  $$('.tabs .tab').forEach(b => b.onclick = () => { $$('.tabs .tab').forEach(x => x.classList.toggle('active', x === b)); $('#setVlog').classList.toggle('hidden', b.dataset.t !== 'vlog'); $('#setApp').classList.toggle('hidden', b.dataset.t !== 'app'); });
  if (P) { $('#openFolder').onclick = () => api('POST', '/api/open', { path: P.folder }); $('#delProj').onclick = () => { if (!confirm(`Move “${P.name}” to the Trash?`)) return; guard(async () => { await api('DELETE', `/api/projects/${P.name}`); closeSheet(); localStorage.removeItem('kv.project'); P = null; await loadProjects(); }); }; }
  $('#s_ok').onclick = () => guard(async () => {
    await api('PUT', '/api/settings', { immich_url: $('#s_url').value, immich_api_key: $('#s_key').value, vlogs_dir: $('#s_dir').value, default_title_subtitle: $('#s_sub').value, default_music: $('#s_music').value, default_orientation: $('#s_or').value, default_transition: $('#s_tr').value });
    if (P) await api('PATCH', `/api/projects/${P.name}`, { title: $('#v_title').value, output: { orientation: $('#v_or').value, codec: $('#v_codec').value, quality: $('#v_q').value, fps: +$('#v_fps').value }, style: { transition: $('#v_tr').value, transition_duration: +$('#v_trd').value, fade_in: +$('#v_fi').value, fade_out: +$('#v_fo').value, title_bg: $('#v_bg').value, title_fg: $('#v_fg').value, font: $('#v_font').value }, audio: { normalize: $('#v_norm').checked, match_levels: $('#v_match').checked } });
    closeSheet(); await loadProjects(P && P.name); toast('Saved');
  });
}
$('#projBtn').onclick = async e => {
  const list = await api('GET', '/api/projects');
  popover(e.currentTarget, [...list.slice(0, 12).map(p => ({ label: `${p.name}${p.title && p.title !== p.name ? ' · ' + p.title : ''}`, sel: P && p.name === P.name, fn: () => openProject(p.name) })), '-', { label: 'New vlog…', k: '⌘N', fn: newProjectSheet }]);
};
$('#welcomeNew').onclick = newProjectSheet;
function newProjectSheet() {
  const today = new Date().toISOString().slice(0, 10);
  sheet(`<h2>New vlog</h2>${field('Date / folder', `<input id="m_n" type="text" value="${today}">`)}${field('Title', `<input id="m_t" type="text" placeholder="${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}">`)}
    <div class="check"><input type="checkbox" id="m_o" checked><label for="m_o">Start with an opening title card</label></div>
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Create</button></div>`);
  $('#s_ok').onclick = () => guard(async () => { const p = await api('POST', '/api/projects', { name: $('#m_n').value, title: $('#m_t').value || null, opening: $('#m_o').checked }); closeSheet(); await loadProjects(p.name); });
}

// ------------------------------------------------------------------ recorder (streams chunks to disk as it goes)
const REC = { stream: null, recorder: null, mode: 'clip', ctx: null, raf: 0, start: 0, playFrom: 0, timer: 0, session: null, seq: 0, queue: Promise.resolve(), bytes: 0, failed: 0, chunks: [] };
function pickMime(kind) {
  const c = kind === 'voiceover' ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => MediaRecorder.isTypeSupported(m)) || '';
}
async function openRecorder(mode = 'clip') {
  if (!navigator.mediaDevices) return toast('Recording needs a secure context (localhost is fine)', true);
  stop();
  const portrait = P.layout && P.layout.orientation === 'portrait';
  REC.mode = mode;
  sheet(`<div id="recBox">
    <div class="inline" style="margin-bottom:12px"><h2 style="margin:0">Record</h2><span class="spacer"></span><div class="tabs" style="margin:0"><button class="tab ${mode === 'clip' ? 'active' : ''}" data-rm="clip">Camera clip</button><button class="tab ${mode === 'voiceover' ? 'active' : ''}" data-rm="voiceover">Voiceover</button></div></div>
    <video id="recPreview" autoplay muted playsinline class="${portrait ? 'portrait' : ''}"></video>
    <div class="meter"><div class="lvl" id="recLvl"></div></div>
    <div class="recgrid">
      ${field('Camera', '<select id="recCam"></select>')}${field('Microphone', '<select id="recMic"></select>')}
      ${field('Quality', '<select id="recQ"><option value="1080">1080p</option><option value="720">720p</option><option value="2160">4K (if supported)</option></select>')}
      ${field('Options', `<div class="inline"><label class="check" style="margin:0"><input type="checkbox" id="recMirror" checked> mirror</label><label class="check" style="margin:0"><input type="checkbox" id="recCover" ${portrait ? 'checked' : ''}> crop to fill</label></div>`)}
    </div>
    <p id="recVoHint" class="muted hidden">The preview plays from <b id="recVoAt">${fmt(T)}</b> while you talk. Wear headphones. Clip audio is ducked under your voice.</p>
    <div class="recctl"><button class="recbtn" id="recGo"><i></i></button><span id="recTime">0:00.0</span><span id="recStatus" class="muted"></span><span class="spacer"></span><button class="pill" id="recClose">Close</button></div>
  </div>`, { wide: true });
  $('#recClose').onclick = closeRecorder;
  $$('[data-rm]').forEach(b => b.onclick = () => { if (REC.recorder && REC.recorder.state === 'recording') return; $$('[data-rm]').forEach(x => x.classList.toggle('active', x === b)); REC.mode = b.dataset.rm; applyRecMode(); startPreview(); });
  $('#recQ').onchange = startPreview; $('#recMirror').onchange = e => $('#recPreview').classList.toggle('nomirror', !e.target.checked);
  $('#recGo').onclick = () => REC.recorder && REC.recorder.state === 'recording' ? stopRecording() : startRecording();
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    tmp.getTracks().forEach(t => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, key) => { const list = devs.filter(d => d.kind === kind); sel.innerHTML = list.map(d => `<option value="${d.deviceId}">${esc(d.label || kind)}</option>`).join('') || '<option value="">none</option>'; const saved = localStorage.getItem(key); if (saved && list.some(d => d.deviceId === saved)) sel.value = saved; sel.onchange = () => { localStorage.setItem(key, sel.value); startPreview(); }; };
    fill($('#recCam'), 'videoinput', 'kv.cam'); fill($('#recMic'), 'audioinput', 'kv.mic');
  } catch (e) { toast('Camera/microphone permission denied: ' + e.message, true); }
  applyRecMode(); startPreview();
}
function applyRecMode() { const vo = REC.mode === 'voiceover'; $('#recPreview').classList.toggle('hidden', vo); $('#recCam').closest('.field').classList.toggle('hidden', vo); $('#recQ').closest('.field').classList.toggle('hidden', vo); $('#recVoHint').classList.toggle('hidden', !vo); $('#recVoAt').textContent = fmt(T); }
async function startPreview() {
  stopStream(); const q = +$('#recQ').value;
  const constraints = { audio: { deviceId: $('#recMic').value ? { exact: $('#recMic').value } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    video: REC.mode === 'voiceover' ? false : { deviceId: $('#recCam').value ? { exact: $('#recCam').value } : undefined, width: { ideal: q === 2160 ? 3840 : q === 720 ? 1280 : 1920 }, height: { ideal: q === 2160 ? 2160 : q }, frameRate: { ideal: 30 } } };
  try { REC.stream = await navigator.mediaDevices.getUserMedia(constraints); } catch (e) { $('#recStatus').textContent = 'cannot open device: ' + e.message; return; }
  $('#recPreview').srcObject = REC.stream;
  const vt = REC.stream.getVideoTracks()[0];
  $('#recStatus').textContent = vt ? `${vt.getSettings().width}×${vt.getSettings().height}` : 'audio only';
  try {
    REC.ctx = REC.ctx || new AudioContext(); const src = REC.ctx.createMediaStreamSource(REC.stream); const an = REC.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an); const buf = new Float32Array(an.fftSize);
    const tickM = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; const db = 20 * Math.log10(Math.sqrt(s / buf.length) || 1e-6); const el = $('#recLvl'); if (el) el.style.width = `${clamp((db + 60) / 60 * 100, 0, 100)}%`; REC.raf = requestAnimationFrame(tickM); };
    cancelAnimationFrame(REC.raf); tickM();
  } catch { }
}
function stopStream() { cancelAnimationFrame(REC.raf); if (REC.stream) { REC.stream.getTracks().forEach(t => t.stop()); REC.stream = null; } }
function closeRecorder() { if (REC.recorder && REC.recorder.state === 'recording') return toast('Stop the recording first'); stopStream(); closeSheet(); }
window.addEventListener('beforeunload', e => { if (REC.recorder && REC.recorder.state === 'recording') { e.preventDefault(); e.returnValue = ''; } });

async function startRecording() {
  if (!REC.stream) return toast('No input device', true);
  const mime = pickMime(REC.mode);
  REC.playFrom = T;
  try { const r = await api('POST', `/api/projects/${P.name}/record/start`, { kind: REC.mode, at: REC.playFrom, fit: $('#recCover').checked ? 'cover' : 'contain', mime }); REC.session = r.id; }
  catch (e) { return toast('Could not start a recording session: ' + e.message, true); }
  REC.seq = 0; REC.bytes = 0; REC.failed = 0; REC.chunks = []; REC.queue = Promise.resolve();
  REC.recorder = new MediaRecorder(REC.stream, { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
  REC.recorder.ondataavailable = e => { if (!e.data.size) return; REC.chunks.push(e.data); const seq = REC.seq++; REC.queue = REC.queue.then(() => sendChunk(seq, e.data)); };
  REC.recorder.onstop = finishRecording;
  REC.start = performance.now();
  if (REC.mode === 'voiceover') { seek(REC.playFrom, true); play(); }
  REC.recorder.start(500);
  $('#recGo').classList.add('on');
  REC.timer = setInterval(() => { const el = $('#recTime'); if (!el) return; el.textContent = fmt((performance.now() - REC.start) / 1000); $('#recStatus').textContent = REC.failed ? `⚠ ${REC.failed} chunk(s) not saved yet` : `saved ${(REC.bytes / 1e6).toFixed(1)} MB`; if (REC.mode === 'voiceover' && !playing) stopRecording(); }, 250);
}
async function sendChunk(seq, blob, attempt = 0) {
  try { const r = await api('POST', `/api/projects/${P.name}/record/${REC.session}/chunk?seq=${seq}`, blob); REC.bytes = r.bytes; REC.failed = 0; }
  catch (e) { if (attempt < 5 && e.status !== 409) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); return sendChunk(seq, blob, attempt + 1); } REC.failed++; }
}
function stopRecording() { clearInterval(REC.timer); $('#recGo') && $('#recGo').classList.remove('on'); if (REC.mode === 'voiceover') stop(); if (REC.recorder && REC.recorder.state === 'recording') REC.recorder.stop(); }
async function finishRecording() {
  const secs = (performance.now() - REC.start) / 1000;
  if ($('#recStatus')) $('#recStatus').textContent = 'finishing…';
  await REC.queue;
  if (secs < 0.5) { await api('DELETE', `/api/projects/${P.name}/recordings/${REC.session}`).catch(() => { }); return toast('Too short, discarded'); }
  try {
    const r = await api('POST', `/api/projects/${P.name}/record/${REC.session}/finish`);
    setProject(r.project);
    toast(REC.mode === 'voiceover' ? `Voiceover added at ${fmt(REC.playFrom)}` : 'Recording added to the timeline');
    if (r.id && REC.mode === 'clip') { select(r.id); const s = seg(); if (s && s.placed) seek(s.placed.start, true); }
    if ($('#recStatus')) { $('#recStatus').textContent = 'saved'; $('#recTime').textContent = '0:00.0'; }
  } catch (e) {
    // the chunks are on disk; fall back to a one-shot upload of what we have in memory, else offer recovery
    toast('Save failed: ' + e.message + ' — trying again', true);
    try {
      const fd = new FormData(); fd.append('file', new Blob(REC.chunks, { type: REC.recorder.mimeType || 'video/webm' }), 'rec'); fd.append('kind', REC.mode); fd.append('at', REC.playFrom); fd.append('fit', $('#recCover') && $('#recCover').checked ? 'cover' : 'contain');
      const r = await api('POST', `/api/projects/${P.name}/record`, fd); setProject(r.project); toast('Recording saved');
    } catch (e2) { toast('Recording kept on disk; use Recover after restarting the app', true); checkRecoverable(); }
  }
}
async function checkRecoverable() {
  const bar = $('#recoverBar');
  try {
    const list = (await api('GET', `/api/projects/${P.name}/recordings`)).filter(m => m.recoverable);
    if (!list.length) { bar.classList.add('hidden'); return; }
    const m = list[0];
    $('#recoverBar .msg').textContent = `Unfinished ${m.kind === 'voiceover' ? 'voiceover' : 'recording'} from ${m.started.slice(11, 16)} · ${(m.bytes / 1e6).toFixed(1)} MB${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`;
    bar.classList.remove('hidden');
    $('#recoverBtn').onclick = () => guard(async () => { bar.classList.add('hidden'); const r = await api('POST', `/api/projects/${P.name}/record/${m.id}/finish`); setProject(r.project); toast('Recovered'); checkRecoverable(); });
    $('#discardBtn').onclick = () => guard(async () => { await api('DELETE', `/api/projects/${P.name}/recordings/${m.id}`); checkRecoverable(); });
  } catch { bar.classList.add('hidden'); }
}

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', e => {
  if (!P) return;
  const inSheet = $('#sheetBody').children.length > 0; const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape') { if (inSheet && !$('#recBox')) closeSheet(); else if (sel || selVo || selMusic) select(null); return; }
  if (inSheet) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); startRender(e.shiftKey ? 'render' : 'preview'); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); newProjectSheet(); return; }
  if (e.metaKey || e.ctrlKey) return;
  const s = seg(); const fr = 1 / ((P.layout && P.layout.fps) || 30);
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': ctxActions.trimStart(); break;
    case 'o': ctxActions.trimEnd(); break;
    case 's': ctxActions.split(); break;
    case 't': ctxActions.title(); break;
    case 'r': openRecorder('clip'); break;
    case 'Backspace': case 'Delete': if (s) { e.preventDefault(); $('#segDelete').click(); } break;
    case 'ArrowLeft': e.preventDefault(); stop(); seek(T - (e.shiftKey ? 1 : fr), true); break;
    case 'ArrowRight': e.preventDefault(); stop(); seek(T + (e.shiftKey ? 1 : fr), true); break;
    case 'Home': seek(0, true); break;
    case 'End': seek(total(), true); break;
    case 'ArrowUp': case 'ArrowDown': { if (!P.timeline.length) break; e.preventDefault(); const i = P.timeline.findIndex(x => x.id === sel); const n = clamp(i + (e.key === 'ArrowUp' ? -1 : 1), 0, P.timeline.length - 1); select(P.timeline[n].id); seek(P.timeline[n].placed.start, true); break; }
    case '[': if (s) $('#segUp').click(); break;
    case ']': if (s) $('#segDown').click(); break;
  }
});
window.addEventListener('resize', () => { if (P) { renderTimeline(); VP.projectChanged(); } });

// ------------------------------------------------------------------ boot
(async () => { await guard(loadProjects); })();
