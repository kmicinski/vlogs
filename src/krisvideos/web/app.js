/* KrisVideos editor UI.
   State lives in P (project JSON from the server); every edit round-trips through the API, which
   rewrites project.yaml (and records undo history). The player plays the timeline live from clip
   proxies with HTML title cards, captions, crossfades, music and narration approximated in the
   browser; when a rendered preview is newer than the project it is used instead. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (t, d = 1) => { t = Math.max(0, +t || 0); const m = Math.floor(t / 60); const s = t - m * 60; return `${m}:${s.toFixed(d).padStart(d ? 3 + d : 2, '0')}`; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isMac = navigator.platform.includes('Mac');

let P = null, sel = null, selVo = null, selMusic = false;
let T = 0, playing = false, job = null, pollTimer = null, lastYaml = '';
const clock = { t0: 0, wall: 0 };

// ================================================================== helpers
async function api(method, url, body, raw = false) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body instanceof Blob) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) { let msg = r.statusText; try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { } const e = new Error(msg); e.status = r.status; throw e; }
  return raw ? r : r.json();
}
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 2200); }
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, true); console.error(e); } }
function sheet(html, { wide = false } = {}) {
  $('#sheetBody').innerHTML = html; $('#sheet').classList.remove('hidden'); $('.sheetbox').classList.toggle('wide', wide);
  const f = $('#sheetBody input[type=text], #sheetBody input:not([type=checkbox]):not([type=color]), #sheetBody textarea'); if (f) setTimeout(() => f.focus(), 30);
  $$('[data-close]').forEach(b => b.onclick = closeSheet);
  $('#sheetBody').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && $('#s_ok')) { e.preventDefault(); $('#s_ok').click(); } };
}
const sheetOpen = () => $('#sheetBody').children.length > 0;
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBody').innerHTML = ''; }
$('#sheet').onclick = e => { if (e.target.id === 'sheet' && !$('#recBox')) closeSheet(); };
function popover(anchor, items) {
  const el = $('#popover');
  el.innerHTML = items.map((it, i) => it === '-' ? '<div class="sep"></div>' : `<button class="item ${it.sel ? 'sel' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}</button>`).join('');
  const r = anchor.getBoundingClientRect(); el.classList.remove('hidden');
  el.style.left = `${clamp(r.left, 8, innerWidth - el.offsetWidth - 8)}px`; el.style.top = `${r.bottom + 6}px`;
  $$('.item', el).forEach(b => b.onclick = () => { closePopover(); items[+b.dataset.i].fn(); });
  setTimeout(() => document.addEventListener('mousedown', closePopover, { once: true }), 0);
}
function closePopover() { $('#popover').classList.add('hidden'); }
const field = (label, inner) => `<div class="field"><label>${label}</label>${inner}</div>`;
const gainFactor = s => { if (!P.match_levels || s.lufs == null) return 1; return Math.pow(10, clamp(P.target_lufs - s.lufs, -12, 12) / 20); };

// ================================================================== projects
async function loadProjects(selectName) {
  const list = await api('GET', '/api/projects');
  if (!list.length) { $('#welcome').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#projTitle').textContent = 'KrisVideos'; return; }
  $('#welcome').classList.add('hidden'); $('#app').classList.remove('hidden');
  const name = selectName || localStorage.getItem('kv.project') || list[0].name;
  await openProject(list.some(p => p.name === name) ? name : list[0].name);
}
async function openProject(name) {
  localStorage.setItem('kv.project', name);
  sel = selVo = null; selMusic = false; T = 0; stop(); zoom = null;
  VP.reset(); AUD.reset();
  setProject(await api('GET', `/api/projects/${name}`));
  checkRecoverable();
}
function setProject(p) {
  P = p;
  if (sel && !P.timeline.some(s => s.id === sel)) sel = null;
  if (selVo && !(P.voiceovers || []).some(v => v.id === selVo)) selVo = null;
  $('#projTitle').textContent = P.title || P.name;
  $('#projMeta').textContent = P.layout ? `${fmt(P.layout.total)} · ${P.layout.width}×${P.layout.height}` : '';
  $('#undoBtn').disabled = !P.can_undo; $('#redoBtn').disabled = !P.can_redo;
  lastYaml = P.yaml;
  T = clamp(T, 0, total());
  renderTimeline(); renderInspector();
  AUD.projectChanged(); VP.projectChanged();
  if (P.final && !P.final.stale) { $('#doneBar').classList.remove('hidden'); $('#doneBar .msg').textContent = `Exported ${P.final.path.split('/').pop()} · ${(P.final.size / 1e6).toFixed(1)} MB`; }
  else $('#doneBar').classList.add('hidden');
  const pending = P.timeline.filter(s => s.kind === 'clip' && !s.missing && (!s.proxy_url || !s.thumb_url)).length;
  clearTimeout(setProject._t); if (pending) setProject._t = setTimeout(refresh, 2000);
}
async function refresh() { if (P) setProject(await api('GET', `/api/projects/${P.name}`)); }
setInterval(async () => { if (!P || job || sheetOpen() || playing) return; try { const p = await api('GET', `/api/projects/${P.name}`); if (p.yaml !== lastYaml) setProject(p); } catch { } }, 3000);
const seg = () => P && P.timeline.find(s => s.id === sel);
const total = () => (P && P.layout) ? P.layout.total : 0;
function locate(t) {
  if (!P) return null;
  const segs = P.timeline.filter(s => s.placed);
  for (const s of segs) if (t >= s.placed.start && t < s.placed.end) return { seg: s, off: t - s.placed.start };
  const last = segs[segs.length - 1];
  return last && t >= last.placed.end ? { seg: last, off: last.placed.duration } : (segs[0] ? { seg: segs[0], off: 0 } : null);
}
const nextSeg = s => P.timeline[P.timeline.indexOf(s) + 1];

// ================================================================== audio layers (music + narration) for live mode
const AUD = (() => {
  let music = null, vos = [];
  function reset() { if (music) { music.pause(); music.remove(); music = null; } vos.forEach(v => { v.el.pause(); v.el.remove(); }); vos = []; }
  function projectChanged() {
    reset();
    if (P.music && P.music.file) { music = document.createElement('audio'); music.src = `/api/projects/${P.name}/music`; music.loop = true; music.preload = 'auto'; document.body.appendChild(music); }
    for (const v of P.voiceovers || []) { if (!v.url) continue; const el = document.createElement('audio'); el.src = v.url; el.preload = 'auto'; document.body.appendChild(el); vos.push({ v, el }); }
  }
  // returns duck factors for the current clip: {clip, music}
  function sync(t, play) {
    let voActive = false, anyVoDuck = false;
    for (const { v, el } of vos) {
      const active = t >= v.at && t < v.at + (v.duration || 0);
      if (active) { voActive = true; if (v.duck_clips) anyVoDuck = true; }
      const want = t - v.at;
      if (play && active) { el.volume = clamp(v.volume * gainFactor(v), 0, 1); if (el.paused || Math.abs(el.currentTime - want) > 0.35) { try { el.currentTime = Math.max(0, want); } catch { } el.play().catch(() => { }); } }
      else if (!el.paused) el.pause();
    }
    const L = locate(t); const speech = L && L.seg.kind === 'clip' && !L.seg.mute && L.seg.media && L.seg.media.has_audio;
    if (music) {
      const duck = (P.music.duck && (speech || voActive)) ? 0.35 : 1;
      music.volume = clamp(P.music.volume * duck, 0, 1);
      if (play) { const want = (t + (P.music.start || 0)); if (music.paused || (music.duration && Math.abs(((music.currentTime - want) % music.duration)) > 0.5)) { try { music.currentTime = music.duration ? want % music.duration : want; } catch { } music.play().catch(() => { }); } }
      else if (!music.paused) music.pause();
    }
    return { clip: anyVoDuck ? 0.35 : 1 };
  }
  function pause() { if (music) music.pause(); vos.forEach(x => x.el.pause()); }
  return { reset, projectChanged, sync, pause };
})();

// ================================================================== virtual player
const VP = (() => {
  const videos = [$('#vA'), $('#vB')], cards = [$('#cardA'), $('#cardB')];
  cards.forEach(c => c.classList.add('tcard'));
  const owner = new Map();   // element -> segment id it currently shows
  let rendered = false;
  const useRendered = () => !!(P && P.preview && !P.preview.stale);
  const setSrc = (v, url) => { if (v.dataset.url !== url) { v.dataset.url = url; v.src = url; v.load(); } };
  function reset() { for (const v of videos) { v.pause(); v.removeAttribute('src'); v.dataset.url = ''; v.load(); v.classList.add('hidden'); } cards.forEach(c => c.classList.add('hidden')); owner.clear(); }
  function projectChanged() {
    const r = useRendered();
    if (r !== rendered) { rendered = r; owner.clear(); }
    const pending = P.timeline.filter(s => s.kind === 'clip' && !s.missing && !s.proxy_url).length;
    $('#modeChip').textContent = !P.timeline.length ? '' : rendered ? 'Rendered preview' : pending ? `Preparing ${pending} clip${pending > 1 ? 's' : ''}…` : 'Live';
    $('#stageEmpty').classList.toggle('hidden', !!P.timeline.length);
    $('#stageEmpty').innerHTML = 'Nothing here yet.<br><small>Use <b>+ Add</b>, or press <b>R</b> to record.</small>';
    fitCanvas();
    sync(T, true);
  }
  function fitCanvas() {
    const L = P && P.layout; const ar = L ? L.width / L.height : 16 / 9; const box = $('#playerBox'), c = $('#canvas');
    c.style.aspectRatio = `${ar}`; const boxAr = box.clientWidth / Math.max(1, box.clientHeight);
    c.style.height = boxAr > ar ? '100%' : 'auto'; c.style.width = boxAr > ar ? 'auto' : '100%';
  }
  // ---- layer assignment: a segment gets a video or card element; two active at once during a fade
  function layerFor(s, other) {
    const pool = s.kind === 'title' ? cards : videos;
    let el = pool.find(e => owner.get(e) === s.id);
    if (!el) el = pool.find(e => owner.get(e) !== (other && other.id)) || pool[0];
    owner.set(el, s.id);
    return el;
  }
  function paintCard(el, s) {
    el.style.background = s.bg || P.style.title_bg; el.style.color = s.fg || P.style.title_fg;
    el.classList.toggle('lower', s.layout === 'lower');
    $('.t', el).textContent = s.title; $('.s', el).textContent = s.subtitle || ''; $('.s', el).style.color = P.style.title_accent; $('.rule', el).style.background = P.style.title_accent;
    $('.t', el).style.fontFamily = `"${P.style.font}", -apple-system, sans-serif`;
  }
  function captions(s, off) {
    const L = $('#capLayer'); L.innerHTML = '';
    if (!s || s.kind !== 'clip') return;
    const items = [];
    if (s.caption) items.push({ text: s.caption, position: 'bottom', style: 'caption' });
    for (const o of s.overlays || []) { const a = o.at || 0, b = o.for == null ? Infinity : a + o.for; if (off >= a && off < b) items.push(o); }
    for (const o of items) { const d = document.createElement('div'); d.className = (o.style === 'big' ? 'capBig ' : 'capPill ') + (o.position || 'bottom'); d.textContent = o.text; L.appendChild(d); }
  }
  // show one segment on its layer at timeline time t with the given opacity / audio weight
  function present(s, t, opacity, weight, other, duck) {
    const el = layerFor(s, other);
    el.classList.remove('hidden'); el.style.opacity = opacity;
    if (s.kind === 'title') { paintCard(el, s); return el; }
    const url = s.proxy_url || s.src_url;
    if (!url || s.missing) { el.classList.add('hidden'); return el; }
    setSrc(el, url);
    const want = (s.in || 0) + (t - s.placed.start) * (s.speed || 1);
    el.playbackRate = clamp(s.speed || 1, 0.25, 4);
    el.style.objectFit = s.fit === 'cover' ? 'cover' : 'contain';
    el.muted = !!s.mute || !playing;
    el.volume = clamp((s.volume ?? 1) * gainFactor(s) * weight * duck, 0, 1);
    const drift = Math.abs(el.currentTime - want);
    if (drift > (playing ? 0.3 : 0.04) || el.dataset.seg !== s.id) { try { el.currentTime = want; } catch { } el.dataset.seg = s.id; }
    if (playing && el.paused) el.play().catch(() => { });
    if (!playing && !el.paused) el.pause();
    return el;
  }
  function sync(t, hard = false) {
    if (!P || !P.timeline.length) { reset(); captions(null); return; }
    if (rendered) {
      cards.forEach(c => c.classList.add('hidden')); captions(null); videos[1].classList.add('hidden');
      const v = videos[0]; setSrc(v, P.preview.url); v.classList.remove('hidden'); v.style.opacity = 1; v.style.objectFit = 'contain'; v.muted = false; v.volume = 1; v.playbackRate = 1;
      if (hard || Math.abs(v.currentTime - t) > 0.25) { try { v.currentTime = t; } catch { } }
      return;
    }
    const L = locate(t); if (!L) return;
    const s = L.seg, n = nextSeg(s);
    const duck = AUD.sync(t, playing).clip;
    const overlap = n && n.placed && n.placed.transition !== 'cut' && t >= n.placed.start;
    const active = [];
    if (overlap) {
      const d = n.placed.transition_duration || 0.5, frac = clamp((t - n.placed.start) / d, 0, 1);
      let oA = 1, oB = frac;
      if (n.placed.transition === 'dip') { oA = 1 - clamp(frac * 2, 0, 1); oB = clamp(frac * 2 - 1, 0, 1); }
      const a = present(s, t, oA, 1 - frac, n, duck), b = present(n, t, oB, frac, s, duck);
      b.classList.add('top'); a.classList.remove('top'); active.push(a, b);
      captions(frac < 0.5 ? s : n, frac < 0.5 ? L.off : t - n.placed.start);
    } else {
      const a = present(s, t, 1, 1, null, duck); a.classList.remove('top'); active.push(a);
      captions(s, L.off);
      // preload the next clip into the spare video element
      if (n && n.kind === 'clip' && (n.proxy_url || n.src_url) && s.placed.end - t < 2.5) {
        const spare = videos.find(v => v !== a); const nu = n.proxy_url || n.src_url;
        if (spare && owner.get(spare) !== n.id) { owner.set(spare, n.id); setSrc(spare, nu); spare.muted = true; spare.dataset.seg = ''; spare.addEventListener('loadedmetadata', () => { try { spare.currentTime = n.in || 0; } catch { } }, { once: true }); }
      }
    }
    for (const el of [...videos, ...cards]) if (!active.includes(el)) { el.classList.add('hidden'); if (el.tagName === 'VIDEO' && !el.paused) el.pause(); }
  }
  function showSource(s, srcTime) {   // trim-handle drag: show an arbitrary source frame
    const el = layerFor(s, null); const url = s.proxy_url || s.src_url; if (!url) return;
    cards.forEach(c => c.classList.add('hidden')); videos.forEach(v => v.classList.toggle('hidden', v !== el));
    setSrc(el, url); el.pause(); el.muted = true; el.style.opacity = 1; el.style.objectFit = s.fit === 'cover' ? 'cover' : 'contain';
    try { el.currentTime = srcTime; } catch { } el.dataset.seg = '';
  }
  function pauseAll() { videos.forEach(v => v.pause()); AUD.pause(); }
  const mainVideo = () => videos[0];
  return { sync, showSource, pauseAll, reset, projectChanged, fitCanvas, isRendered: () => rendered, mainVideo };
})();

function play() {
  if (!P || !P.timeline.length) return;
  if (T >= total() - 0.05) T = 0;
  playing = true; clock.t0 = T; clock.wall = performance.now();
  if (VP.isRendered()) { VP.sync(T, true); VP.mainVideo().play().catch(() => { }); }
  $('#playIcon').setAttribute('d', 'M3 2h4v12H3zM9 2h4v12H9z');
  requestAnimationFrame(tick);
}
function stop() { playing = false; VP.pauseAll(); $('#playIcon').setAttribute('d', 'M4 2.5v11l9-5.5z'); if (P) VP.sync(T); }
function togglePlay() { playing ? stop() : play(); }
function tick() {
  if (!playing) return;
  T = VP.isRendered() ? VP.mainVideo().currentTime : clock.t0 + (performance.now() - clock.wall) / 1000;
  if (T >= total()) { T = total(); stop(); }
  else VP.sync(T);
  updatePlayhead();
  if (playing) requestAnimationFrame(tick);
}
function seek(t, hard = false) { T = clamp(t, 0, total()); if (playing) { clock.t0 = T; clock.wall = performance.now(); if (VP.isRendered()) VP.mainVideo().currentTime = T; } VP.sync(T, hard); updatePlayhead(); }
$('#playBtn').onclick = togglePlay;
$('#vA').addEventListener('ended', () => { if (playing && VP.isRendered()) { T = total(); stop(); updatePlayhead(); } });

// ================================================================== timeline
let pxPerSec = 20, zoom = null;   // zoom: null = fit to width
const TL_PAD = 12;
function fitPx() { return Math.max(4, ($('#tl').clientWidth - 2 * TL_PAD) / Math.max(total(), 1)); }
function renderTimeline() {
  const track = $('#track'), ruler = $('#ruler');
  $$('.block', track).forEach(b => b.remove());
  $('#tlEmpty').classList.toggle('hidden', !!P.timeline.length);
  const tot = Math.max(total(), 1);
  pxPerSec = zoom || fitPx();
  const W = tot * pxPerSec;
  track.style.width = ruler.style.width = `${W}px`;
  const step = pxPerSec > 160 ? 0.5 : pxPerSec > 70 ? 1 : pxPerSec > 28 ? 5 : pxPerSec > 10 ? 10 : pxPerSec > 4 ? 30 : 60;
  let html = '';
  for (let t = 0; t <= tot + 1e-6; t += step / 5) { const major = Math.abs(t / step - Math.round(t / step)) < 1e-6; html += `<div class="tick ${major ? '' : 'minor'}" style="left:${t * pxPerSec}px">${major ? fmt(t, step < 1 ? 1 : 0) : ''}</div>`; }
  ruler.innerHTML = html;
  for (const s of P.timeline) {
    if (!s.placed) continue;
    const b = document.createElement('div');
    const w = Math.max(6, s.placed.duration * pxPerSec);
    b.className = `block ${s.kind}${s.missing ? ' missing' : ''}${s.id === sel ? ' selected' : ''}${s.kind === 'clip' && !s.missing && !s.proxy_url ? ' pending' : ''}`;
    b.style.left = `${s.placed.start * pxPerSec}px`; b.style.width = `${w}px`; b.dataset.id = s.id; b.draggable = true;
    if (s.kind === 'title') {
      b.style.background = s.bg ? s.bg : ''; b.style.color = s.fg ? s.fg : '';
      b.innerHTML = `<div class="lbl">${esc(s.title)}</div>`;
    } else {
      const m = s.media || {}; const ar = m.width && m.height ? m.width / m.height : 16 / 9;
      const n = clamp(Math.ceil(w / (64 * ar)), 1, 60);
      const q = `src=${encodeURIComponent(s.clip)}&start=${s.placed.src_in}&end=${s.placed.src_out}`;
      const strip = s.proxy_url ? `<img class="strip" src="/api/projects/${P.name}/strip?${q}&n=${n}&h=64" draggable="false">` : (s.thumb_url ? `<img class="strip" src="${s.thumb_url}" draggable="false">` : '');
      const wave = (s.proxy_url && m.has_audio && !s.mute && w > 24) ? `<img class="wave" src="/api/projects/${P.name}/wave?${q}&w=${Math.ceil(w / 50) * 50}&h=20&color=ffffff" draggable="false">` : '';
      b.innerHTML = `${strip}${wave}${s.placed.transition !== 'cut' ? '<div class="xf"></div>' : ''}<div class="meta">${fmt(s.placed.duration)}${s.speed && s.speed !== 1 ? ` ×${s.speed}` : ''}${s.mute ? ' 🔇' : ''}${s.fit === 'cover' ? ' ⤢' : ''}</div>${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ''}<div class="lbl">${esc(s.clip.replace(/^clips\//, ''))}</div><div class="handle l"></div><div class="handle r"></div>`;
    }
    b.onclick = e => { if (e.target.classList.contains('handle')) return; select(s.id); seek(s.placed.start + clamp((e.clientX - b.getBoundingClientRect().left) / pxPerSec, 0, s.placed.duration - 0.01), true); };
    b.ondragstart = e => { e.dataTransfer.setData('text/seg', s.id); e.dataTransfer.effectAllowed = 'move'; };
    b.ondragover = e => { e.preventDefault(); b.classList.add('dragover'); };
    b.ondragleave = () => b.classList.remove('dragover');
    b.ondrop = e => { e.preventDefault(); b.classList.remove('dragover'); onDrop(e, s.id); };
    if (s.kind === 'clip') { $('.handle.l', b).onpointerdown = e => trimDrag(e, s, 'in'); $('.handle.r', b).onpointerdown = e => trimDrag(e, s, 'out'); }
    track.appendChild(b);
  }
  track.ondragover = e => e.preventDefault(); track.ondrop = e => { if (e.target === track) onDrop(e, null); };
  renderLanes(); updatePlayhead();
}
function renderLanes() {
  const lanes = $('#lanes'); lanes.innerHTML = '';
  const tot = Math.max(total(), 1), W = tot * pxPerSec;
  const vos = P.voiceovers || [];
  if (vos.length) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`; l.innerHTML = '<span class="lanelbl">voice</span>';
    for (const v of vos) {
      const d = document.createElement('div'); d.className = 'vo' + (v.id === selVo ? ' selected' : ''); const w = Math.max(14, (v.duration || 1) * pxPerSec);
      d.style.left = `${v.at * pxPerSec}px`; d.style.width = `${w}px`;
      d.innerHTML = `${v.url ? `<img src="/api/projects/${P.name}/wave?src=${encodeURIComponent(v.file)}&w=${Math.ceil(w / 50) * 50}&h=16&color=ffffff">` : ''}<span>${fmt(v.duration || 0)}</span>`;
      d.onclick = e => { e.stopPropagation(); selVo = v.id; sel = null; selMusic = false; renderTimeline(); renderInspector(); seek(v.at, true); }; l.appendChild(d);
    }
    lanes.appendChild(l);
  }
  if (P.music && P.music.file) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`;
    const d = document.createElement('div'); d.className = 'mu' + (selMusic ? ' selected' : '');
    d.innerHTML = `<img src="/api/projects/${P.name}/wave?src=music&start=${P.music.start || 0}&end=${(P.music.start || 0) + tot}&w=${Math.ceil(W / 100) * 100}&h=16&color=ffffff"><span>♫ ${esc(P.music.file.split('/').pop())} · ${Math.round(P.music.volume * 100)}%${P.music.duck ? ' · ducks under speech' : ''}</span>`;
    d.onclick = e => { e.stopPropagation(); selMusic = true; sel = selVo = null; renderTimeline(); renderInspector(); }; l.appendChild(d); lanes.appendChild(l);
  }
}
function updatePlayhead() {
  const ph = $('#playhead'); ph.style.left = `${TL_PAD + T * pxPerSec - $('#tl').scrollLeft}px`; ph.classList.toggle('hidden', !P.timeline.length);
  const tot = total() || 1; $('#scrubber .fill').style.width = `${T / tot * 100}%`; $('#scrubber .knob').style.left = `${T / tot * 100}%`;
  $('#tNow').textContent = fmt(T); $('#tTotal').textContent = fmt(total());
  const tl = $('#tl'); const x = T * pxPerSec;
  if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 60) tl.scrollLeft = Math.max(0, playing ? x - 60 : x - tl.clientWidth / 2);
  updateCtx();
}
function updateCtx() {
  const L = locate(T); const overClip = L && L.seg.kind === 'clip' && L.off > 0.15 && L.seg.placed.duration - L.off > 0.15;
  for (const a of ['split', 'trimStart', 'trimEnd']) $(`[data-act=${a}]`).disabled = !overClip;
  $('[data-act=title]').disabled = !P.timeline.length;
}
$('#tl').addEventListener('scroll', updatePlayhead);
function setZoom(z) {
  const tl = $('#tl'); const xBefore = T * pxPerSec - tl.scrollLeft;
  zoom = z; renderTimeline();
  tl.scrollLeft = Math.max(0, T * pxPerSec - xBefore);
}
$('#zoomIn').onclick = () => setZoom(Math.min(400, pxPerSec * 1.5));
$('#zoomOut').onclick = () => { const f = fitPx(); const z = pxPerSec / 1.5; setZoom(z <= f ? null : z); };
$('#zoomFit').onclick = () => setZoom(null);
$('#tl').addEventListener('wheel', e => { if (e.metaKey || e.ctrlKey) { e.preventDefault(); e.deltaY < 0 ? $('#zoomIn').click() : $('#zoomOut').click(); } }, { passive: false });
function scrubSurface(el, toTime) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); const wasPlaying = playing; stop();
    const move = ev => seek(toTime(ev)); move(e);
    el.setPointerCapture(e.pointerId); el.onpointermove = move;
    el.onpointerup = () => { el.onpointermove = el.onpointerup = null; if (wasPlaying) play(); };
  });
}
scrubSurface($('#ruler'), ev => (ev.clientX - $('#ruler').getBoundingClientRect().left) / pxPerSec);
scrubSurface($('#scrubber'), ev => { const r = $('#scrubber').getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * total(); });
$('#track').addEventListener('pointerdown', e => { if (e.target === $('#track') || e.target.id === 'tlEmpty') select(null); });

function trimDrag(e, s, which) {
  e.preventDefault(); e.stopPropagation(); stop(); select(s.id);
  const b = e.currentTarget.closest('.block'); const x0 = e.clientX; const m = s.media || {}; const dur = m.duration || s.placed.src_out;
  const in0 = s.placed.src_in, out0 = s.placed.src_out; let nin = in0, nout = out0;
  const h = e.currentTarget; h.setPointerCapture(e.pointerId);
  const phSrc = (T >= s.placed.start && T <= s.placed.end) ? in0 + (T - s.placed.start) * (s.speed || 1) : null;  // snap target
  h.onpointermove = ev => {
    let ds = (ev.clientX - x0) / pxPerSec * (s.speed || 1);
    if (which === 'in') {
      nin = clamp(in0 + ds, 0, out0 - 0.2);
      if (phSrc != null && Math.abs(nin - phSrc) * pxPerSec / (s.speed || 1) < 8) nin = phSrc;
      VP.showSource(s, nin); b.style.left = `${(s.placed.start + (nin - in0) / (s.speed || 1)) * pxPerSec}px`; b.style.width = `${(out0 - nin) / (s.speed || 1) * pxPerSec}px`;
    } else {
      nout = clamp(out0 + ds, in0 + 0.2, dur);
      if (phSrc != null && Math.abs(nout - phSrc) * pxPerSec / (s.speed || 1) < 8) nout = phSrc;
      VP.showSource(s, nout); b.style.width = `${(nout - in0) / (s.speed || 1) * pxPerSec}px`;
    }
    $('.meta', b).textContent = fmt((nout - nin) / (s.speed || 1));
  };
  h.onpointerup = () => {
    h.onpointermove = h.onpointerup = null;
    if (Math.abs(nin - in0) < 0.01 && Math.abs(nout - out0) < 0.01) { renderTimeline(); VP.sync(T, true); return; }
    patchSeg(s.id, which === 'in' ? { in: nin } : { out: nout }).then(() => { const ns = seg(); if (ns) seek(which === 'in' ? ns.placed.start : Math.max(ns.placed.start, ns.placed.end - 0.05), true); });
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

// ================================================================== edits
async function patchSeg(id, body) { return guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/segments/${id}`, body)); }); }
async function patchProject(body) { return guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}`, body)); }); }
async function undo() { if (!P.can_undo) return; await guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/undo`)); toast('Undo'); }); }
async function redo() { if (!P.can_redo) return; await guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/redo`)); toast('Redo'); }); }
$('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
const ctxActions = {
  split: () => guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/split`, { time: T })); }),
  title: () => titleAt(T),
  trimStart: () => { const L = locate(T); if (L && L.seg.kind === 'clip') patchSeg(L.seg.id, { in: L.seg.placed.src_in + L.off * (L.seg.speed || 1) }).then(() => seek(L.seg.placed.start, true)); },
  trimEnd: () => { const L = locate(T); if (L && L.seg.kind === 'clip') patchSeg(L.seg.id, { out: L.seg.placed.src_in + L.off * (L.seg.speed || 1) }); },
  addTitle: () => addTitleSheet(),
  record: () => openRecorder('clip'),
  music: () => { selMusic = true; sel = selVo = null; renderInspector(); renderTimeline(); if (!(P.music && P.music.file)) pickMusic(); },
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
  $('#s_ok').onclick = () => guard(async () => { let at = $('#m_at').value; at = at === 'after' ? P.timeline.findIndex(s => s.id === sel) + 1 : at === '' ? null : +at; const p = await api('POST', `/api/projects/${P.name}/segments`, { kind: 'title', text: $('#m_t').value || 'Title', subtitle: $('#m_s').value, duration: +$('#m_d').value, at }); setProject(p); closeSheet(); const ns = at == null ? p.timeline[p.timeline.length - 1] : p.timeline[at]; if (ns) { select(ns.id); seek(ns.placed.start, true); } });
}
async function pickMusic() { await guard(async () => { const r = await api('POST', '/api/pick', { kind: 'music' }); if (r.paths[0]) await patchProject({ music: { file: r.paths[0] } }); }); }

// ================================================================== inspector
function openInspector() { $('#app').classList.add('with-inspector'); $('#inspector').classList.remove('hidden'); setTimeout(() => { renderTimeline(); VP.fitCanvas(); }, 220); }
function closeInspector() { if (!$('#inspector').classList.contains('hidden')) { $('#app').classList.remove('with-inspector'); $('#inspector').classList.add('hidden'); setTimeout(() => { renderTimeline(); VP.fitCanvas(); }, 220); } }
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
    html = `<h3>Title card ${close}</h3>` + field('Title', `<input type="text" data-k="text" value="${esc(s.title)}">`) + field('Subtitle', `<input type="text" data-k="subtitle" value="${esc(s.subtitle || '')}">`) +
      `<div class="inline">${field('Seconds', `<input type="number" data-k="duration" step="0.5" min="0.5" value="${s.duration}">`)}${field('Layout', `<select data-k="layout"><option value="center" ${s.layout !== 'lower' ? 'selected' : ''}>Centered</option><option value="lower" ${s.layout === 'lower' ? 'selected' : ''}>Lower third</option></select>`)}</div>` +
      field('Colors', `<div class="inline"><input type="color" data-k="bg" value="${s.bg || P.style.title_bg}" title="background"><input type="color" data-k="fg" value="${s.fg || P.style.title_fg}" title="text"><button class="link muted" id="titleColorsReset">use project colors</button></div>`);
  } else {
    const m = s.media || {};
    html = `<h3>Clip <span class="sub" title="${esc(s.clip)}">${esc(s.clip.replace(/^clips\//, ''))}</span>${close}</h3>` +
      `<div class="muted" style="margin:-6px 0 12px">${m.width ? `${m.width}×${m.height}${m.hdr ? ' HDR' : ''} · ${fmt(m.duration)}` : ''}${s.lufs != null ? ` · ${s.lufs.toFixed(0)} LUFS${P.match_levels ? ` (${(20 * Math.log10(gainFactor(s))).toFixed(0) >= 0 ? '+' : ''}${(20 * Math.log10(gainFactor(s))).toFixed(0)} dB)` : ''}` : ''}${s.missing ? ' · <b style="color:var(--danger)">file missing</b>' : ''}</div>` +
      field('In → out (source time)', `<div class="inline"><input type="text" data-k="in" value="${fmt(s.in || 0, 2)}"><span class="muted">→</span><input type="text" data-k="out" value="${s.out == null ? 'end' : fmt(s.out, 2)}"></div>`) +
      field('Caption', `<input type="text" data-k="caption" value="${esc(s.caption || '')}" placeholder="lower third for the whole clip">`) +
      `<div class="field"><label>Text overlays</label><div id="ovList"></div><button class="link" id="ovAdd" style="align-self:flex-start">+ Add overlay at playhead</button></div>` +
      field('Speed', `<div class="inline"><input type="range" data-k="speed" min="0.25" max="4" step="0.25" value="${s.speed || 1}"><span id="speedLbl" style="width:34px">${s.speed || 1}×</span></div>`) +
      field('Fit', `<select data-k="fit"><option value="contain" ${s.fit !== 'cover' ? 'selected' : ''}>Letterbox (show everything)</option><option value="cover" ${s.fit === 'cover' ? 'selected' : ''}>Crop to fill</option></select>`) +
      `<div class="check"><input type="checkbox" id="muteChk" ${s.mute ? 'checked' : ''}><label for="muteChk">Mute</label></div>` +
      field('Volume', `<input type="range" data-k="volume" min="0" max="2" step="0.1" value="${s.volume ?? 1}">`);
  }
  html += field('Transition in', `<div class="inline"><select data-k="transition">${trOpts}</select><input type="number" data-k="transition_duration" step="0.1" min="0.1" max="3" value="${s.transition_duration ?? ''}" placeholder="${P.style.transition_duration}s" style="flex:0 0 64px"></div>`);
  html += `<div class="sep"></div><div class="actions"><button class="link" id="segUp" title="[">← Move</button><button class="link" id="segDown" title="]">Move →</button><button class="link" id="segDup">Duplicate</button><span class="spacer"></span><button class="link danger" id="segDelete">Delete</button></div>`;
  el.innerHTML = html;
  $('#inspClose').onclick = () => select(null);
  $$('[data-k]', el).forEach(inp => {
    const k = inp.dataset.k;
    const commit = () => patchSeg(s.id, { [k]: inp.type === 'number' || inp.type === 'range' ? (inp.value === '' ? '' : +inp.value) : inp.value });
    if (inp.type === 'range') { inp.oninput = () => { if (k === 'speed') $('#speedLbl').textContent = inp.value + '×'; }; inp.onchange = commit; }
    else { inp.onchange = commit; inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); }; }
  });
  if ($('#titleColorsReset')) $('#titleColorsReset').onclick = () => patchSeg(s.id, { bg: '', fg: '' });
  if ($('#muteChk')) $('#muteChk').onchange = e => patchSeg(s.id, { mute: e.target.checked });
  $('#segDelete').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/segments/${s.id}`)); });
  const move = d => { const ids = P.timeline.map(x => x.id); const i = ids.indexOf(s.id); const j = clamp(i + d, 0, ids.length - 1); if (i === j) return; ids.splice(i, 1); ids.splice(j, 0, s.id); guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/reorder`, { ids })); const ns = seg(); if (ns) seek(ns.placed.start, true); }); };
  $('#segUp').onclick = () => move(-1); $('#segDown').onclick = () => move(1);
  $('#segDup').onclick = () => guard(async () => {
    const at = P.timeline.findIndex(x => x.id === s.id) + 1;
    const p = await api('POST', `/api/projects/${P.name}/segments`, s.kind === 'title' ? { kind: 'title', text: s.title, subtitle: s.subtitle, duration: s.duration, at } : { kind: 'clip', src: s.clip, at });
    if (s.kind === 'clip') await api('PATCH', `/api/projects/${P.name}/segments/${p.timeline[at].id}`, { in: s.in, out: s.out ?? '', speed: s.speed, mute: s.mute, caption: s.caption || '', fit: s.fit });
    else if (s.bg || s.fg || s.layout !== 'center') await api('PATCH', `/api/projects/${P.name}/segments/${p.timeline[at].id}`, { bg: s.bg || '', fg: s.fg || '', layout: s.layout });
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
    `<div class="sep"></div><div class="actions"><span class="spacer"></span><button class="link danger" id="voDel">Delete</button></div>`;
  $('#inspClose').onclick = () => { selVo = null; renderTimeline(); renderInspector(); };
  const patch = body => guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/voiceovers/${v.id}`, body)); });
  $('#voAt').onchange = e => patch({ at: e.target.value }); $('#voAt').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#voAtPh').onclick = () => patch({ at: T });
  $('#voVol').onchange = e => patch({ volume: +e.target.value });
  $('#voDuck').onchange = e => patch({ duck_clips: e.target.checked });
  $('#voDel').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/voiceovers/${v.id}`)); selVo = null; renderInspector(); });
}
function renderMusicInspector(el, close) {
  const m = P.music;
  el.innerHTML = `<h3>Music ${close}</h3>` +
    field('File', `<div class="inline"><input type="text" id="muFile" value="${esc(m.file || '')}" placeholder="none"><button class="link" id="muPick">Choose…</button></div>`) +
    (m.file ? field('Volume', `<input type="range" id="muVol" min="0" max="1" step="0.02" value="${m.volume}">`) +
      `<div class="check"><input type="checkbox" id="muDuck" ${m.duck ? 'checked' : ''}><label for="muDuck">Duck under speech</label></div>` +
      field('Start offset into the song (s)', `<input type="number" id="muStart" step="1" min="0" value="${m.start}">`) +
      `<div class="sep"></div><div class="actions"><span class="spacer"></span><button class="link danger" id="muRm">Remove music</button></div>` : '<p class="muted">Music loops under the whole vlog, ducks under speech, and fades out at the end.</p>');
  $('#inspClose').onclick = () => { selMusic = false; renderTimeline(); renderInspector(); };
  $('#muFile').onchange = e => patchProject({ music: { file: e.target.value } }); $('#muPick').onclick = pickMusic;
  if (m.file) { $('#muVol').onchange = e => patchProject({ music: { volume: +e.target.value } }); $('#muDuck').onchange = e => patchProject({ music: { duck: e.target.checked } }); $('#muStart').onchange = e => patchProject({ music: { start: +e.target.value } }); $('#muRm').onclick = () => patchProject({ music: { file: '' } }).then(() => { selMusic = false; renderInspector(); }); }
}

// ================================================================== add menu / library
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
    b.innerHTML = `<div class="actions"><button class="pill" id="pickFiles">Choose files…</button><button class="pill" id="pickFolder">Choose a folder…</button></div><div class="drop" id="dropZone">…or drop videos anywhere in the window</div><p class="muted">Clips are copied into the project and ordered by the time they were shot.</p>`;
    $('#pickFiles').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'files' }); if (r.paths.length) importPaths(r.paths); });
    $('#pickFolder').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'folder' }); if (r.paths.length) importPaths(r.paths); });
  } else if (tab === 'clips') {
    b.innerHTML = P.clips.length ? `<div class="cards">${P.clips.map(c => `<div class="card ${c.in_timeline ? 'inproj' : ''}" data-src="${esc(c.src)}">${c.thumb_url ? `<img src="${c.thumb_url}">` : '<div class="noimg">…</div>'}<div class="ci">${esc(c.name)}${c.media ? ` · ${fmt(c.media.duration)}` : ''}</div>${c.in_timeline ? '<span class="badge">in timeline</span>' : ''}</div>`).join('')}</div><p class="muted">Click a clip to add it to the end of the timeline.</p>` : '<div class="hint">No clips in this project yet.</div>';
    $$('.card', b).forEach(c => c.onclick = () => guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'clip', src: c.dataset.src })); toast('Added'); }));
  } else {
    b.innerHTML = `<div class="inline" style="margin-bottom:10px"><button class="iconbtn" id="dayPrev" title="previous day">‹</button><input type="date" id="immichDate" value="${P.date || new Date().toISOString().slice(0, 10)}" style="flex:0 0 150px"><button class="iconbtn" id="dayNext" title="next day">›</button><select id="immichDays" style="flex:0 0 90px"><option value="1">1 day</option><option value="2">2 days</option><option value="7">week</option></select><span id="immichCount" class="muted"></span><span class="spacer"></span><button class="pill sm" id="immichAddSel" disabled>Add selected</button><button class="pill sm primary" id="immichAddAll">Add all</button></div><div id="immichList"><div class="hint">Loading…</div></div>`;
    $('#immichDate').onchange = $('#immichDays').onchange = loadImmich;
    const shift = d => { const x = new Date($('#immichDate').value + 'T12:00:00'); x.setDate(x.getDate() + d); $('#immichDate').value = x.toISOString().slice(0, 10); loadImmich(); };
    $('#dayPrev').onclick = () => shift(-1); $('#dayNext').onclick = () => shift(1);
    $('#immichAddAll').onclick = () => { const have = new Set(P.clips.map(c => c.name)); importImmich(immichVids.filter(v => !have.has(v.filename))); };
    $('#immichAddSel').onclick = () => importImmich(immichVids.filter(v => picked.has(v.id)));
    loadImmich();
  }
}
async function loadImmich() {
  const box = $('#immichList'); if (!box) return; picked.clear(); $('#immichAddSel').disabled = true;
  box.innerHTML = '<div class="hint">Loading…</div>';
  try { immichVids = await api('GET', `/api/immich/videos?date=${$('#immichDate').value}&days=${$('#immichDays').value}`); }
  catch (e) { box.innerHTML = `<div class="hint">${esc(e.message)}<br><br><button class="pill" onclick="openSettings('app')">Set up Immich</button></div>`; return; }
  const have = new Set(P.clips.map(c => c.name)); const fresh = immichVids.filter(v => !have.has(v.filename));
  $('#immichCount').textContent = immichVids.length ? `${immichVids.length} video${immichVids.length > 1 ? 's' : ''}${fresh.length !== immichVids.length ? ` · ${immichVids.length - fresh.length} already in` : ''}` : '';
  $('#immichAddAll').disabled = !fresh.length;
  if (!immichVids.length) { box.innerHTML = '<div class="hint">No videos on that day.</div>'; return; }
  box.innerHTML = `<div class="cards">${immichVids.map(v => `<div class="card ${have.has(v.filename) ? 'inproj' : ''}" data-id="${v.id}"><img src="${v.thumb_url}" loading="lazy"><div class="ci">${esc((v.taken_at || '').slice(11, 16))} · ${esc((v.duration || '').replace(/^0?0:|\.\d+$/g, ''))}</div>${have.has(v.filename) ? '<span class="badge">✓</span>' : ''}</div>`).join('')}</div><p class="muted">Click to select, then <b>Add selected</b> — or <b>Add all</b>. Clips land in the order they were shot.</p>`;
  $$('.card', box).forEach(c => c.onclick = () => { if (c.classList.contains('inproj')) return; c.classList.toggle('picked'); c.classList.contains('picked') ? picked.add(c.dataset.id) : picked.delete(c.dataset.id); $('#immichAddSel').disabled = !picked.size; });
}
async function importPaths(paths) { await guard(async () => { const r = await api('POST', `/api/projects/${P.name}/import`, { paths }); setProject(r.project); toast(`Imported ${r.added.length} clip(s)`); closeSheet(); }); }
async function importImmich(assets) {
  if (!assets.length) return toast('Nothing to add');
  closeSheet();
  await guard(async () => { const j = await api('POST', `/api/projects/${P.name}/import-immich`, { assets: assets.map(a => ({ id: a.id, filename: a.filename })) }); watchJob(j, async () => { await refresh(); toast(`Added ${assets.length} clip(s)`); }); });
}
// whole-window drop of files
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files') && P) { dragDepth++; if (!$('#dropHint')) { const d = document.createElement('div'); d.id = 'dropHint'; d.textContent = 'Drop videos to add them to this vlog'; document.body.appendChild(d); } } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint') && $('#dropHint').remove(); } });
window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  dragDepth = 0; $('#dropHint') && $('#dropHint').remove();
  if (!e.dataTransfer.files.length || !P) return; e.preventDefault();
  const fd = new FormData(); for (const f of e.dataTransfer.files) fd.append('files', f);
  toast(`Uploading ${e.dataTransfer.files.length} file(s)…`);
  guard(async () => { const r = await api('POST', `/api/projects/${P.name}/upload`, fd); setProject(r.project); toast(`Imported ${r.added.length} clip(s)`); closeSheet(); });
});

// ================================================================== jobs / render / export
function watchJob(j, onDone) {
  job = j; const bar = $('#jobBar'); bar.classList.remove('hidden'); $('#doneBar').classList.add('hidden');
  $('#renderPreviewBtn').disabled = $('#exportBtn').disabled = true; clearInterval(pollTimer);
  const label = { preview: 'Rendering preview', render: 'Exporting', import: 'Importing' }[j.kind] || j.kind;
  const t0 = Date.now();
  pollTimer = setInterval(async () => {
    try { j = await api('GET', `/api/jobs/${j.id}`); } catch { return; }
    const pct = Math.round(j.progress * 100); const el = (Date.now() - t0) / 1000; const eta = j.progress > 0.05 ? Math.round(el / j.progress - el) : null;
    $('#jobBar .fill').style.width = `${pct}%`;
    $('#jobBar .msg').textContent = `${label} · ${pct}%${eta != null && eta > 1 ? ` · about ${eta}s left` : ''}${j.message ? ' · ' + j.message : ''}`;
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
  stop();
  guard(async () => { const j = await api('POST', `/api/projects/${P.name}/${kind}`); const t = T; watchJob(j, async () => { await refresh(); if (kind === 'preview') { seek(t, true); toast('Preview ready — the player now shows the real mix'); } else toast('Export complete'); }); });
}
$('#renderPreviewBtn').onclick = () => startRender('preview');
const PRESETS = [
  { label: 'Share · 1080p H.264', desc: 'iMessage / AirDrop friendly', output: { resolution: 1080, codec: 'h264', quality: 'high' } },
  { label: 'Small · 720p H.264', desc: 'smaller file', output: { resolution: 720, codec: 'h264', quality: 'medium' } },
  { label: 'High quality · 1080p HEVC', desc: 'better quality per MB', output: { resolution: 1080, codec: 'hevc', quality: 'high' } },
  { label: '4K · HEVC', desc: 'only if the clips are 4K', output: { resolution: 2160, codec: 'hevc', quality: 'high' } },
];
$('#exportBtn').onclick = e => {
  const cur = P.output;
  popover(e.currentTarget, PRESETS.map(pr => ({ label: pr.label, k: pr.desc, sel: pr.output.resolution === cur.resolution && pr.output.codec === cur.codec && pr.output.quality === cur.quality, fn: () => guard(async () => { await patchProject({ output: pr.output }); startRender('render'); }) })));
};
$('#revealBtn').onclick = () => P.final && api('POST', '/api/reveal', { path: P.final.path });
$('#openBtn').onclick = () => P.final && api('POST', '/api/open', { path: P.final.path });
$('#doneClose').onclick = () => $('#doneBar').classList.add('hidden');

// ================================================================== script / settings / projects / help
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
      <div class="inline">${field('Fade in (s)', `<input type="number" id="v_fi" step="0.1" min="0" value="${st.fade_in}">`)}${field('Fade out (s)', `<input type="number" id="v_fo" step="0.1" min="0" value="${st.fade_out}">`)}${field('FPS', `<select id="v_fps">${opt([24, 30, 60], o.fps)}</select>`)}</div>
      ${field('Title cards', `<div class="inline"><input type="color" id="v_bg" value="${st.title_bg}" title="background"><input type="color" id="v_fg" value="${st.title_fg}" title="text"><input type="color" id="v_ac" value="${st.title_accent}" title="subtitle / accent"><input type="text" id="v_font" value="${esc(st.font)}" placeholder="font family"></div>`)}
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
    if (P) await api('PATCH', `/api/projects/${P.name}`, { title: $('#v_title').value, output: { orientation: $('#v_or').value, fps: +$('#v_fps').value }, style: { transition: $('#v_tr').value, transition_duration: +$('#v_trd').value, fade_in: +$('#v_fi').value, fade_out: +$('#v_fo').value, title_bg: $('#v_bg').value, title_fg: $('#v_fg').value, title_accent: $('#v_ac').value, font: $('#v_font').value }, audio: { normalize: $('#v_norm').checked, match_levels: $('#v_match').checked } });
    closeSheet(); await loadProjects(P && P.name); toast('Saved');
  });
}
$('#projBtn').onclick = async e => {
  const list = await api('GET', '/api/projects');
  popover(e.currentTarget, [...list.slice(0, 12).map(p => ({ label: `${p.name}${p.title && p.title !== p.name ? ' · ' + p.title : ''}`, k: p.rendered ? 'exported' : `${p.segments} seg`, sel: P && p.name === P.name, fn: () => openProject(p.name) })), '-', { label: 'New vlog…', k: '⌘N', fn: newProjectSheet }]);
};
$('#welcomeNew').onclick = newProjectSheet;
async function newProjectSheet() {
  const today = new Date().toISOString().slice(0, 10);
  const imm = await api('GET', '/api/immich/status').catch(() => ({ ok: false }));
  sheet(`<h2>New vlog</h2>${field('Date / folder', `<input id="m_n" type="text" value="${today}">`)}${field('Title', `<input id="m_t" type="text" placeholder="${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}">`)}
    <div class="check"><input type="checkbox" id="m_o" checked><label for="m_o">Start with an opening title card</label></div>
    <div class="check"><input type="checkbox" id="m_i" ${imm.ok ? 'checked' : 'disabled'}><label for="m_i">Add that day's clips from Immich${imm.ok ? '' : ' <span class="muted">(not connected)</span>'}</label></div>
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Create</button></div>`);
  $('#s_ok').onclick = () => guard(async () => {
    const r = await api('POST', '/api/projects', { name: $('#m_n').value, title: $('#m_t').value || null, opening: $('#m_o').checked, pull_immich: $('#m_i').checked });
    closeSheet(); await loadProjects(r.project.name);
    if (r.job) watchJob(r.job, async () => { await refresh(); toast('Clips added'); });
    else if ($('#m_i') && $('#m_i').checked) toast('No videos on that day in Immich');
  });
}
$('#helpBtn').onclick = showHelp;
function showHelp() {
  const rows = [['space', 'play / pause'], ['← →', 'step one frame (⇧ for a second)'], ['↑ ↓', 'select previous / next segment'], ['I / O', 'trim the clip\'s start / end to the playhead'], ['S', 'split the clip at the playhead'], ['T', 'cut to a title card here'], ['R', 'record'], ['[ ]', 'move the selected segment'], ['⌫', 'delete the selected segment'], ['⌘Z / ⇧⌘Z', 'undo / redo'], ['⌘+ ⌘− ⌘0', 'zoom the timeline / fit'], ['F', 'fullscreen player'], ['⌘⏎', 'render preview'], ['⇧⌘⏎', 'export'], ['⌘N', 'new vlog'], ['esc', 'deselect / close']];
  sheet(`<h2>Keyboard</h2><div class="kbd-grid">${rows.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div><p class="muted" style="margin-top:14px">Drag the blue handles on a selected clip to trim (they snap to the playhead). Drag blocks to reorder. ⌘-scroll zooms the timeline.</p><div class="foot"><button class="pill" data-close>Close</button></div>`);
}

// ================================================================== recorder (streams chunks to disk as it goes)
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
  if (!$('#recPreview')) { stopStream(); return; }
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

// ================================================================== keyboard
document.addEventListener('keydown', e => {
  if (!P) return;
  const tag = e.target.tagName; const mod = isMac ? e.metaKey : e.ctrlKey;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape') { if (sheetOpen() && !$('#recBox')) closeSheet(); else if (sel || selVo || selMusic) select(null); return; }
  if (sheetOpen()) return;
  if (mod && e.key === 'Enter') { e.preventDefault(); startRender(e.shiftKey ? 'render' : 'preview'); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key === 'n') { e.preventDefault(); newProjectSheet(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('#zoomIn').click(); return; }
  if (mod && e.key === '-') { e.preventDefault(); $('#zoomOut').click(); return; }
  if (mod && e.key === '0') { e.preventDefault(); $('#zoomFit').click(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const s = seg(); const fr = 1 / ((P.layout && P.layout.fps) || 30);
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': ctxActions.trimStart(); break;
    case 'o': ctxActions.trimEnd(); break;
    case 's': ctxActions.split(); break;
    case 't': ctxActions.title(); break;
    case 'r': openRecorder('clip'); break;
    case 'f': { const c = $('#canvas'); document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen && c.requestFullscreen(); break; }
    case '?': showHelp(); break;
    case 'Backspace': case 'Delete': if (s) { e.preventDefault(); $('#segDelete').click(); } else if (selVo) $('#voDel').click(); break;
    case 'ArrowLeft': e.preventDefault(); stop(); seek(T - (e.shiftKey ? 1 : fr), true); break;
    case 'ArrowRight': e.preventDefault(); stop(); seek(T + (e.shiftKey ? 1 : fr), true); break;
    case 'Home': seek(0, true); break;
    case 'End': seek(total(), true); break;
    case 'ArrowUp': case 'ArrowDown': { if (!P.timeline.length) break; e.preventDefault(); const i = P.timeline.findIndex(x => x.id === sel); const n = clamp(i + (e.key === 'ArrowUp' ? -1 : 1), 0, P.timeline.length - 1); select(P.timeline[n].id); seek(P.timeline[n].placed.start, true); break; }
    case '[': if (s) $('#segUp').click(); break;
    case ']': if (s) $('#segDown').click(); break;
  }
});
document.addEventListener('fullscreenchange', () => VP.fitCanvas());
window.addEventListener('resize', () => { if (P) { renderTimeline(); VP.fitCanvas(); } });

// ================================================================== boot
(async () => { await guard(loadProjects); })();
