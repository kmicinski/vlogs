/* KrisVideos editor UI.
   State lives in P (project JSON from the server); every edit round-trips through the API, which
   rewrites project.yaml (and records undo history). The player plays the timeline live from clip
   proxies with HTML title cards, captions, crossfades, music and narration approximated in the
   browser; when a rendered preview is newer than the project it is used instead. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (t, d = 1) => { t = Math.max(0, +t || 0); const m = Math.floor(t / 60); const s = t - m * 60; return `${m}:${s.toFixed(d).padStart(d ? 3 + d : 2, '0')}`; };
const parseTime = v => { const s = String(v ?? '').trim(); if (!s) return 0; const parts = s.split(':').map(Number); if (parts.some(isNaN)) return 0; return parts.length === 2 ? parts[0] * 60 + parts[1] : parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0]; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isMac = navigator.platform.includes('Mac');

let P = null, sel = null, selVo = null, selSting = null, selImg = null, selMusic = false;
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
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
const PLAY_D = 'M4 2.5v11l9-5.5z', PAUSE_D = 'M3 2h4v12H3zM9 2h4v12H9z';
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, true); console.error(e); } }
function sheet(html, { wide = false, xl = false } = {}) {
  $('#sheetBody').innerHTML = html; $('#sheet').classList.remove('hidden'); $('.sheetbox').classList.toggle('wide', wide); $('.sheetbox').classList.toggle('xl', xl);
  const f = $('#sheetBody input[type=text], #sheetBody input:not([type=checkbox]):not([type=color]), #sheetBody textarea'); if (f) setTimeout(() => f.focus(), 30);
  $$('[data-close]').forEach(b => b.onclick = closeSheet);
  $('#sheetBody').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && $('#s_ok')) { e.preventDefault(); $('#s_ok').click(); } };
}
const sheetOpen = () => $('#sheetBody').children.length > 0;
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBody').innerHTML = ''; }
$('#sheet').onclick = e => { if (e.target.id === 'sheet' && !$('#recBox') && !$('#trimBox')) closeSheet(); };
function popover(anchor, items) {
  const el = $('#popover');
  el.innerHTML = items.map((it, i) => it === '-' ? '<div class="sep"></div>' : `<button class="item ${it.sel ? 'sel' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}</button>`).join('');
  const r = anchor.getBoundingClientRect(); el.classList.remove('hidden');
  el.style.left = `${clamp(r.left, 8, innerWidth - el.offsetWidth - 8)}px`; el.style.top = `${r.bottom + 6}px`;
  $$('.item', el).forEach(b => b.onclick = () => { closePopover(); items[+b.dataset.i].fn(); });
  // close on a mousedown outside the menu (a mousedown inside must not hide it before the click lands)
  if (el._onDown) document.removeEventListener('mousedown', el._onDown);
  el._onDown = e => { if (!el.contains(e.target)) closePopover(); };
  setTimeout(() => document.addEventListener('mousedown', el._onDown), 0);
}
function closePopover() { const el = $('#popover'); el.classList.add('hidden'); if (el._onDown) { document.removeEventListener('mousedown', el._onDown); el._onDown = null; } }
const field = (label, inner) => `<div class="field"><label>${label}</label>${inner}</div>`;
// the Channels select of a clip: what `auto` does to this file is spelled out
const channelOptions = s => {
  const auto = s.one_sided ? `Auto: only the ${s.one_sided} channel has sound → copied to both ears` : s.lufs == null && !s.media ? 'Auto' : 'Auto: stereo as recorded';
  return [['auto', auto], ['stereo', 'Stereo as recorded'], ['left', 'Left channel to both ears'], ['right', 'Right channel to both ears'], ['mix', 'Mix both to mono']]
    .map(([v, l]) => `<option value="${v}" ${(s.channel || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('');
};
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
  sel = selVo = selSting = selImg = null; selMusic = false; T = 0; stop(); TL.zoom = 1; MK.in = MK.out = null;
  VP.reset(); AUD.reset();
  setProject(await api('GET', `/api/projects/${name}`));
  checkRecoverable();
}
function setProject(p) {
  P = p;
  if (sel && !P.timeline.some(s => s.id === sel)) sel = null;
  if (selVo && !(P.voiceovers || []).some(v => v.id === selVo)) selVo = null;
  if (selSting && !(P.stings || []).some(m => m.id === selSting)) selSting = null;
  if (selImg && !(P.images || []).some(m => m.id === selImg)) selImg = null;
  $('#projTitle').textContent = P.title || P.name;
  $('#projMeta').textContent = P.layout ? `${fmt(P.layout.total)} · ${P.layout.width}×${P.layout.height}` : '';
  $('#undoBtn').disabled = !P.can_undo; $('#redoBtn').disabled = !P.can_redo;
  lastYaml = P.yaml;
  T = clamp(T, 0, total());
  renderTimeline(); renderInspector();
  AUD.projectChanged(); VP.projectChanged();
  if (P.final && !P.final.stale) { $('#doneBar').classList.remove('hidden'); $('#doneBar .msg').textContent = `Exported ${P.final.path.split('/').pop()} · ${(P.final.size / 1e6).toFixed(1)} MB`; }
  else $('#doneBar').classList.add('hidden');
  const pending = P.timeline.filter(s => s.kind === 'clip' && !s.missing && (!s.proxy_url || !s.thumb_url || (s.pip && !s.pip.missing && !s.pip.proxy_url))).length;
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
  let music = null, vos = [], stings = [];
  function reset() { if (music) { music.pause(); music.remove(); music = null; } vos.forEach(v => { v.el.pause(); v.el.remove(); }); vos = []; stings.forEach(x => { x.el.pause(); x.el.remove(); }); stings = []; }
  function projectChanged() {
    reset();
    if (P.music && P.music.file) { music = document.createElement('audio'); music.src = `/api/projects/${P.name}/music`; music.loop = true; music.preload = 'auto'; document.body.appendChild(music); }
    for (const v of P.voiceovers || []) { if (!v.url) continue; const el = document.createElement('audio'); el.src = v.url; el.preload = 'auto'; document.body.appendChild(el); vos.push({ v, el }); }
    for (const m of P.stings || []) { if (!m.url || m.at == null) continue; const el = document.createElement('audio'); el.src = m.url; el.preload = 'auto'; document.body.appendChild(el); stings.push({ m, el }); }
  }
  // fade envelope of a sting at timeline time t (0..1)
  function stingEnv(m, t) {
    const len = m.end - m.at, off = t - m.at; if (off < 0 || off >= len) return 0;
    const fi = Math.min(m.fade_in || 0, len / 2), fo = Math.min(m.fade_out || 0, len / 2);
    let g = 1; if (fi > 0 && off < fi) g = off / fi; if (fo > 0 && off > len - fo) g = Math.min(g, (len - off) / fo); return clamp(g, 0, 1);
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
    let stingActive = false;
    for (const { m, el } of stings) {
      const env = stingEnv(m, t), active = env > 0;
      if (active) stingActive = true;
      const want = (m.start || 0) + (t - m.at), duck = (m.duck !== false && (speech || voActive)) ? 0.35 : 1;
      if (play && active) { el.volume = clamp(m.volume * env * duck, 0, 1); if (el.paused || Math.abs(el.currentTime - want) > 0.35) { try { el.currentTime = Math.max(0, want); } catch { } el.play().catch(() => { }); } }
      else if (!el.paused) el.pause();
    }
    if (music) {
      const duck = (P.music.duck && (speech || voActive || stingActive)) ? 0.35 : 1;
      music.volume = clamp(P.music.volume * duck, 0, 1);
      if (play) { const want = (t + (P.music.start || 0)); if (music.paused || (music.duration && Math.abs(((music.currentTime - want) % music.duration)) > 0.5)) { try { music.currentTime = music.duration ? want % music.duration : want; } catch { } music.play().catch(() => { }); } }
      else if (!music.paused) music.pause();
    }
    return { clip: anyVoDuck ? 0.35 : 1 };
  }
  function pause() { if (music) music.pause(); vos.forEach(x => x.el.pause()); stings.forEach(x => x.el.pause()); }
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
  // channel routing for one-sided takes (a mic on the right channel only): the element plays through Web
  // Audio and the chosen channel is copied to both ears, like render.py's pan filter. An element is hooked
  // the first time a clip needs it and keeps playing through the context from then on.
  const MIX = { stereo: [[1, 0], [0, 1]], left: [[1, 0], [1, 0]], right: [[0, 1], [0, 1]], mix: [[.5, .5], [.5, .5]] };   // [ear][source channel]
  let actx = null; const routes = new Map();
  function route(el, mode) {
    mode = MIX[mode] ? mode : 'stereo';
    let r = routes.get(el);
    if (!r) {
      if (mode === 'stereo') return;
      try {
        actx = actx || new AudioContext();
        const src = actx.createMediaElementSource(el), sp = actx.createChannelSplitter(2), mg = actx.createChannelMerger(2);
        src.connect(sp); mg.connect(actx.destination);
        const gains = [[null, null], [null, null]];
        for (let o = 0; o < 2; o++) for (let i = 0; i < 2; i++) { const g = actx.createGain(); sp.connect(g, i); g.connect(mg, 0, o); gains[o][i] = g; }
        r = { gains, mode: '' }; routes.set(el, r);
      } catch (e) { console.warn('channel routing unavailable', e); routes.set(el, { gains: null, mode }); return; }
    }
    if (actx && actx.state === 'suspended') actx.resume().catch(() => { });
    if (!r.gains || r.mode === mode) return;
    r.mode = mode;
    for (let o = 0; o < 2; o++) for (let i = 0; i < 2; i++) r.gains[o][i].gain.value = MIX[mode][o][i];
  }
  function reset() { for (const v of videos) { v.pause(); v.removeAttribute('src'); v.dataset.url = ''; v.load(); v.classList.add('hidden'); } cards.forEach(c => c.classList.add('hidden')); owner.clear(); paintLayers(-1); syncPip(null); }
  // the inset (picture in picture) of the clip on screen, from its proxy, in sync with the clip
  function syncPip(s, t, opacity = 1, z = 1) {
    const box = $('#pipBox'), v = $('#vP');
    const pip = s && s.kind === 'clip' && s.placed && s.pip && !s.pip.hidden && !s.pip.missing ? s.pip : null;
    const url = pip && (pip.proxy_url || pip.src_url);
    if (!url) { box.classList.add('hidden'); box.dataset.seg = ''; if (!v.paused) v.pause(); return; }
    setSrc(v, url);
    const want = Math.max(0, (s.in || 0) + (t - s.placed.start) * (s.speed || 1) + (pip.offset || 0));
    v.playbackRate = clamp(s.speed || 1, 0.25, 4); v.muted = true;
    if (Math.abs(v.currentTime - want) > (playing ? 0.3 : 0.04) || v.dataset.seg !== s.id) { try { v.currentTime = want; } catch { } v.dataset.seg = s.id; }
    if (playing && v.paused) v.play().catch(() => { });
    if (!playing && !v.paused) v.pause();
    const [W, H] = canvasWH(), cr = $('#canvas').getBoundingClientRect();
    box.className = `pipbox ${pip.shape || 'round'}${sel === s.id ? ' sel' : ''}`;
    box.style.borderRadius = pip.shape === 'circle' ? '50%' : pip.shape === 'rect' ? '0' : `${Math.round(Math.min(cr.width, cr.height) * 0.02)}px`;
    boxStyle(box, pip.box, W, H, pipAspect(pip.media), pip.shape);
    v.style.objectFit = pip.fit === 'contain' ? 'contain' : 'cover';
    box.style.opacity = opacity; box.style.zIndex = z; box.dataset.seg = s.id;
  }
  // pictures over the video: one element per visible picture, positioned like the render does
  const lyrEls = new Map();
  function paintLayers(t) {
    const host = $('#layerLayer'); if (!host) return;
    const live = (!P || rendered || t < 0) ? [] : (P.images || []).filter(L => L.url && t >= L.at - 1e-3 && t < L.at + L.duration);
    const keep = new Set(live.map(L => L.id));
    for (const [id, el] of lyrEls) if (!keep.has(id)) { el.remove(); lyrEls.delete(id); }
    if (!live.length) return;
    const cr = $('#canvas').getBoundingClientRect(); host.style.setProperty('--lyr-rad', `${Math.round(Math.min(cr.width, cr.height) * 0.02)}px`);
    for (const L of live) {
      const kind = L.box ? 'box' : 'full'; let el = lyrEls.get(L.id);
      if (!el || el.dataset.kind !== kind || el.dataset.url !== L.url) {
        if (el) el.remove();
        el = document.createElement('div'); el.className = `lyr ${kind}`; el.dataset.kind = kind; el.dataset.url = L.url;
        el.innerHTML = (kind === 'full' ? `<div class="bg" style="background-image:url('${L.url}')"></div>` : '') + `<img src="${L.url}" draggable="false">` +
          (kind === 'box' ? '<i class="rz tl" data-c="tl"></i><i class="rz tr" data-c="tr"></i><i class="rz bl" data-c="bl"></i><i class="rz br" data-c="br"></i>' : '');
        const id = L.id; el.addEventListener('pointerdown', e => layerPointer(e, id));
        host.appendChild(el); lyrEls.set(L.id, el);
      }
      el.style.zIndex = String(1 + P.images.indexOf(L));
      el.classList.toggle('cover', L.fit === 'cover'); el.classList.toggle('sel', L.id === selImg);
      if (L.box) { el.style.left = `${L.box[0] * 100}%`; el.style.top = `${L.box[1] * 100}%`; el.style.width = `${L.box[2] * 100}%`; }
      const f = Math.min(L.fade || 0, L.duration / 3), off = t - L.at;
      el.style.opacity = (L.id === selImg && !playing) || f <= 0 ? 1 : clamp(Math.min(off / f, (L.duration - off) / f), 0, 1);
    }
  }
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
    const bg = s.bg || P.style.title_bg, hasText = !!(s.title || s.subtitle || s.kicker);
    el.style.background = bg; el.style.color = s.fg || P.style.title_fg; el.style.setProperty('--cardbg', bg);
    el.classList.toggle('lower', s.layout === 'lower' && !s.image_url);
    el.classList.toggle('img', !!s.image_url); el.classList.toggle('cover', s.fit === 'cover'); el.classList.toggle('text', hasText);
    const url = s.image_url ? `url("${s.image_url}")` : '';
    $('.bg', el).style.backgroundImage = url; $('.pic', el).style.backgroundImage = url;
    $('.k', el).textContent = s.kicker || ''; $('.k', el).style.display = s.kicker ? '' : 'none'; $('.k', el).style.color = P.style.title_accent;
    $('.rule', el).style.display = hasText ? '' : 'none';
    $('.t', el).textContent = s.title; $('.s', el).textContent = s.subtitle || ''; $('.s', el).style.color = P.style.title_accent; $('.rule', el).style.background = P.style.title_accent;
    $('.t', el).style.fontFamily = $('.k', el).style.fontFamily = `"${P.style.font}", -apple-system, sans-serif`;
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
    mainBoxStyle(el, s.box);
    el.muted = !!s.mute || !playing;
    el.volume = clamp((s.volume ?? 1) * gainFactor(s) * weight * duck, 0, 1);
    route(el, s.channel_effective);
    const drift = Math.abs(el.currentTime - want);
    if (drift > (playing ? 0.3 : 0.04) || el.dataset.seg !== s.id) { try { el.currentTime = want; } catch { } el.dataset.seg = s.id; }
    if (playing && el.paused) el.play().catch(() => { });
    if (!playing && !el.paused) el.pause();
    return el;
  }
  function sync(t, hard = false) {
    if (!P || !P.timeline.length) { reset(); captions(null); return; }
    paintLayers(t);
    if (rendered) {
      cards.forEach(c => c.classList.add('hidden')); captions(null); videos[1].classList.add('hidden');
      syncPip(null);
      const v = videos[0]; setSrc(v, P.preview.url); v.classList.remove('hidden'); v.style.opacity = 1; v.style.objectFit = 'contain'; mainBoxStyle(v, null); v.muted = false; v.volume = 1; v.playbackRate = 1; route(v, 'stereo');
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
      if (frac < 0.5) syncPip(s, t, oA, 1); else syncPip(n, t, oB, 3);
    } else {
      const a = present(s, t, 1, 1, null, duck); a.classList.remove('top'); active.push(a);
      captions(s, L.off);
      syncPip(s, t, 1, 1);
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
    cards.forEach(c => c.classList.add('hidden')); videos.forEach(v => v.classList.toggle('hidden', v !== el)); paintLayers(-1); syncPip(null);
    setSrc(el, url); el.pause(); el.muted = true; el.style.opacity = 1; el.style.objectFit = s.fit === 'cover' ? 'cover' : 'contain'; mainBoxStyle(el, s.box);
    try { el.currentTime = srcTime; } catch { } el.dataset.seg = '';
  }
  function pauseAll() { videos.forEach(v => v.pause()); $('#vP').pause(); AUD.pause(); }
  const mainVideo = () => videos[0];
  return { sync, showSource, pauseAll, reset, projectChanged, fitCanvas, isRendered: () => rendered, mainVideo, channelRoutes: () => [...routes].map(([el, r]) => el.id + ":" + (r.gains ? r.mode : "unavailable")) };
})();

function play() {
  if (!P || !P.timeline.length) return;
  if (T >= total() - 0.05) T = 0;
  playing = true; clock.t0 = T; clock.wall = performance.now();
  if (VP.isRendered()) { VP.sync(T, true); VP.mainVideo().play().catch(() => { }); }
  $('#playIcon').setAttribute('d', PAUSE_D);
  requestAnimationFrame(tick);
}
function stop() { playing = false; VP.pauseAll(); $('#playIcon').setAttribute('d', PLAY_D); if (P) VP.sync(T); }
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
// Every segment gets a block whose width grows with log(duration) (or linearly), so a 2-second clip
// stays visible next to a 2-minute take. Time is linear inside each block; tToX / xToT map between
// time and pixels, and everything on the timeline (ruler, lanes, marks, playhead) goes through them.
const TL = { W: 0, blocks: [], zoom: 1, log: lsGet('kv.tlScale', 'log') !== 'linear', dragging: false };
const LOG_TAU = 2;      // seconds: widths grow ~linearly below this and logarithmically above
const MIN_BLOCK = 34;   // px: even a 0.3 s card stays clickable
const TL_GAP = 2;       // px between blocks
function layoutTimeline() {
  const segs = P.timeline.filter(s => s.placed), n = segs.length, tot = total();
  const avail = Math.max(240, $('#tl').clientWidth - 16);   // #tl has 8px of padding on each side
  if (!n) { TL.blocks = []; TL.W = avail; return; }
  // each block's time span; boundaries sit in the middle of transition overlaps, so spans tile [0, total]
  const cuts = [0];
  for (let i = 1; i < n; i++) cuts.push(clamp((segs[i].placed.start + segs[i - 1].placed.end) / 2, cuts[i - 1], tot));
  cuts.push(tot);
  const weight = i => { const d = Math.max(0.001, cuts[i + 1] - cuts[i]); return TL.log ? Math.log1p(d / LOG_TAU) : d; };
  const W = Math.max(avail * TL.zoom, n * MIN_BLOCK);
  // widths proportional to weight, with a floor: blocks under it are pinned and the rest share what is left
  const w = new Array(n).fill(0), pinned = new Array(n).fill(false);
  for (let pass = 0; pass <= n; pass++) {
    let free = W, sum = 0;
    for (let i = 0; i < n; i++) if (pinned[i]) free -= MIN_BLOCK; else sum += weight(i);
    let changed = false;
    for (let i = 0; i < n; i++) {
      w[i] = pinned[i] ? MIN_BLOCK : free * weight(i) / (sum || 1);
      if (!pinned[i] && w[i] < MIN_BLOCK) { pinned[i] = true; changed = true; }
    }
    if (!changed) break;
  }
  let x = 0;
  TL.blocks = segs.map((s, i) => { const b = { s, t0: cuts[i], t1: cuts[i + 1], x0: x, x1: x + w[i] }; x += w[i]; return b; });
  TL.W = x;
}
function tToX(t) {
  if (!TL.blocks.length) return 0;
  for (const b of TL.blocks) if (t < b.t1) return b.x0 + (b.x1 - b.x0) * clamp((t - b.t0) / Math.max(1e-6, b.t1 - b.t0), 0, 1);
  return TL.W;
}
function xToT(x) {
  if (!TL.blocks.length) return 0;
  for (const b of TL.blocks) if (x < b.x1) return b.t0 + (b.t1 - b.t0) * clamp((x - b.x0) / Math.max(1e-6, b.x1 - b.x0), 0, 1);
  return total();
}
// markers (source-clip seconds on a clip) that fall inside the part of the clip in use, with their timeline time
function segMarkers(s) {
  if (!s || s.kind !== 'clip' || !s.placed || !(s.markers || []).length) return [];
  const spd = s.speed || 1, a = s.placed.src_in, b = s.placed.src_out;
  return s.markers.filter(m => m >= a - 1e-3 && m <= b + 1e-3).map(m => ({ src: m, t: s.placed.start + (m - a) / spd, seg: s }));
}
const allMarkers = () => (P ? P.timeline.flatMap(segMarkers).sort((x, y) => x.t - y.t) : []);
const pxPerSecIn = b => (b.x1 - b.x0) / Math.max(1e-6, b.t1 - b.t0);
const contentX = ev => ev.clientX - $('#tlInner').getBoundingClientRect().left;
const NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
function renderRuler() {
  let html = '', lastLab = -1e9;
  const lab = (x, t, d) => { if (x - lastLab < 50 || TL.W - x < 26) return ''; lastLab = x; return `<div class="lab" style="left:${x}px">${fmt(t, d)}</div>`; };
  for (const b of TL.blocks) {
    const k = pxPerSecIn(b), frac = b.t0 % 1;
    html += `<div class="tick edge" style="left:${b.x0}px"></div>` + lab(b.x0, b.t0, frac > 0.05 && frac < 0.95 ? 1 : 0);
    const step = NICE_STEPS.find(st => st * k >= 70) || 1800, d = step < 1 ? 1 : 0;
    for (let j = Math.floor(b.t0 / step + 1e-9) + 1; j * step < b.t1 - 1e-6; j++) {
      const t = j * step, x = b.x0 + (t - b.t0) * k;
      if (x - b.x0 < 12 || b.x1 - x < 12) continue;
      html += `<div class="tick" style="left:${x}px"></div>` + lab(x, t, d);
    }
    const ms = [step / 5, step / 2].find(m => m * k >= 9);
    if (ms) for (let j = Math.floor(b.t0 / ms + 1e-9) + 1; j * ms < b.t1 - 1e-6; j++) {
      const t = j * ms; if (Math.abs(t / step - Math.round(t / step)) < 1e-6) continue;
      const x = b.x0 + (t - b.t0) * k; if (x - b.x0 < 6 || b.x1 - x < 6) continue;
      html += `<div class="tick minor" style="left:${x}px"></div>`;
    }
  }
  $('#ruler').innerHTML = html + '<div id="hoverTime" class="hidden"></div>';
}
function renderTimeline() {
  if (TL.dragging) { TL.pending = true; return; }    // rebuilt when the drag ends
  const track = $('#track');
  $$('.block', track).forEach(b => b.remove());
  $('#tlEmpty').classList.toggle('hidden', !!P.timeline.length);
  layoutTimeline();
  $('#tlInner').style.width = `${TL.W}px`;
  renderRuler();
  for (const blk of TL.blocks) {
    const s = blk.s, b = document.createElement('div');
    const w = Math.max(6, blk.x1 - blk.x0 - TL_GAP);
    b.className = `block ${s.kind}${s.missing ? ' missing' : ''}${s.id === sel ? ' selected' : ''}${s.kind === 'clip' && !s.missing && !s.proxy_url ? ' pending' : ''}`;
    b.style.left = `${blk.x0}px`; b.style.width = `${w}px`; b.dataset.id = s.id; b.draggable = true;
    const xf = s.placed.transition !== 'cut' ? '<div class="xf"></div>' : '';
    const meta = `<div class="meta">${fmt(s.placed.duration)}${s.speed && s.speed !== 1 ? ` ×${s.speed}` : ''}${s.mute ? ' 🔇' : ''}${s.fit === 'cover' ? ' ⤢' : ''}${s.pip && !s.pip.hidden ? ' ⧉' : ''}</div>`;
    if (s.kind === 'title') {
      const black = !s.title && !s.image && (s.bg || '').toLowerCase() === '#000000';
      b.classList.toggle('img', !!s.image_url); b.classList.toggle('black', black);
      b.style.background = s.bg && !s.image_url ? s.bg : ''; b.style.color = s.fg ? s.fg : '';
      const lbl = s.title || (s.image ? s.image.replace(/^assets\//, '') : black ? 'black' : 'card');
      b.innerHTML = `${s.image_url ? `<img class="strip" src="${s.image_url}" draggable="false">` : ''}${xf}${w > 64 ? meta : ''}<div class="lbl">${esc(lbl)}</div>`;
    } else {
      const m = s.media || {}; const ar = m.width && m.height ? m.width / m.height : 16 / 9;
      const n = clamp(Math.ceil(w / (64 * ar)), 1, 60);
      const q = `src=${encodeURIComponent(s.clip)}&start=${s.placed.src_in}&end=${s.placed.src_out}`;
      const strip = s.proxy_url ? `<img class="strip" src="/api/projects/${P.name}/strip?v=2&${q}&n=${n}&h=64" draggable="false">` : (s.thumb_url ? `<img class="strip" src="${s.thumb_url}" draggable="false">` : '');
      const wave = (s.proxy_url && m.has_audio && !s.mute && w > 24) ? `<img class="wave" src="/api/projects/${P.name}/wave?${q}&w=${Math.ceil(w / 50) * 50}&h=20&color=ffffff" draggable="false">` : '';
      const mks = segMarkers(s).map(mk => `<i class="mk" style="left:${tToX(mk.t) - blk.x0}px"></i>`).join('');
      b.innerHTML = `${strip}${wave}${xf}${mks}${meta}${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ''}<div class="lbl">${esc(s.clip.replace(/^clips\//, ''))}</div><div class="handle l"></div><div class="handle r"></div>`;
      b.title = 'Double-click to re-trim against the whole clip';
    }
    b.onclick = e => { if (e.target.classList.contains('handle')) return; select(s.id); seek(xToT(contentX(e)), true); };
    b.ondblclick = e => { if (s.kind === 'clip' && !s.missing) { e.preventDefault(); openTrimmer([s.clip], { segId: s.id }); } };
    b.ondragstart = e => { e.dataTransfer.setData('text/seg', s.id); e.dataTransfer.effectAllowed = 'move'; };
    b.ondragover = e => { e.preventDefault(); b.classList.add('dragover'); };
    b.ondragleave = () => b.classList.remove('dragover');
    b.ondrop = e => { e.preventDefault(); b.classList.remove('dragover'); onDrop(e, s.id); };
    if (s.kind === 'clip') { $('.handle.l', b).onpointerdown = e => trimDrag(e, s, 'in'); $('.handle.r', b).onpointerdown = e => trimDrag(e, s, 'out'); }
    track.appendChild(b);
  }
  track.ondragover = e => e.preventDefault(); track.ondrop = e => { if (e.target === track) onDrop(e, null); };
  renderImageLane(); renderLanes(); renderMarks(); updatePlayhead();
}
function renderLanes() {
  const lanes = $('#lanes'); lanes.innerHTML = '';
  const W = TL.W, tot = Math.max(total(), 1);
  const place = (el, a, b) => { const x0 = tToX(a), w = Math.max(14, tToX(b) - x0); el.style.left = `${x0}px`; el.style.width = `${w}px`; return w; };
  const vos = P.voiceovers || [];
  if (vos.length) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`; l.innerHTML = '<span class="lanelbl">voice</span>';
    for (const v of vos) {
      const d = document.createElement('div'); d.className = 'vo' + (v.id === selVo ? ' selected' : ''); const w = place(d, v.at, v.at + (v.duration || 1));
      d.innerHTML = `${v.url ? `<img src="/api/projects/${P.name}/wave?src=${encodeURIComponent(v.file)}&w=${Math.ceil(w / 50) * 50}&h=16&color=ffffff">` : ''}<span>${fmt(v.duration || 0)}</span>`;
      d.onclick = e => { e.stopPropagation(); selVo = v.id; sel = selSting = selImg = null; selMusic = false; renderTimeline(); renderInspector(); seek(v.at, true); }; l.appendChild(d);
    }
    lanes.appendChild(l);
  }
  const stings = (P.stings || []).filter(m => m.at != null);
  if (stings.length) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`; l.innerHTML = '<span class="lanelbl">sting</span>';
    for (const m of stings) {
      const d = document.createElement('div'); d.className = 'st' + (m.id === selSting ? ' selected' : ''); const w = place(d, m.at, m.end);
      d.innerHTML = `${m.url ? `<img src="/api/projects/${P.name}/wave?src=${encodeURIComponent(m.file)}&start=${m.start || 0}&end=${(m.start || 0) + (m.end - m.at)}&w=${Math.ceil(w / 50) * 50}&h=16&color=ffffff">` : ''}<span>♪ ${esc(m.file.split('/').pop())}</span>`;
      d.onclick = e => { e.stopPropagation(); selSting = m.id; sel = selVo = selImg = null; selMusic = false; renderTimeline(); renderInspector(); seek(m.at, true); }; l.appendChild(d);
    }
    lanes.appendChild(l);
  }
  if (P.music && P.music.file) {
    const l = document.createElement('div'); l.className = 'lane'; l.style.width = `${W}px`;
    const d = document.createElement('div'); d.className = 'mu' + (selMusic ? ' selected' : '');
    // the waveform image is linear in time, so it only lines up with a linear timeline
    d.innerHTML = `${TL.log ? '' : `<img src="/api/projects/${P.name}/wave?src=music&start=${P.music.start || 0}&end=${(P.music.start || 0) + tot}&w=${Math.ceil(W / 100) * 100}&h=16&color=ffffff">`}<span>♫ ${esc(P.music.file.split('/').pop())} · ${Math.round(P.music.volume * 100)}%${P.music.duck ? ' · ducks under speech' : ''}</span>`;
    d.onclick = e => { e.stopPropagation(); selMusic = true; sel = selVo = selSting = selImg = null; renderTimeline(); renderInspector(); }; l.appendChild(d); lanes.appendChild(l);
  }
}
function updatePlayhead() {
  const x = tToX(T), ph = $('#playhead');
  ph.style.left = `${x}px`; ph.classList.toggle('hidden', !P.timeline.length);
  $('#tNow').textContent = fmt(T); $('#tTotal').textContent = fmt(total());
  const tl = $('#tl');
  if (!TL.dragging && (x < tl.scrollLeft + 8 || x > tl.scrollLeft + tl.clientWidth - 40)) tl.scrollLeft = Math.max(0, playing ? x - 60 : x - tl.clientWidth / 2);
  if (MK.in != null && MK.out == null) renderMarks();   // an open range follows the playhead
  updateCtx();
}
function updateCtx() {
  const L = locate(T); const overClip = L && L.seg.kind === 'clip' && L.off > 0.15 && L.seg.placed.duration - L.off > 0.15;
  $('[data-act=split]').disabled = !overClip;
  for (const a of ['title', 'markIn', 'markOut']) $(`[data-act=${a}]`).disabled = !P.timeline.length;
}

// ---- in / out marks, in timeline time: I / O set them, ⌫ cuts that part out, K keeps only it
const MK = { in: null, out: null };
function markRange() {
  if (MK.in == null || MK.out == null) return null;
  const a = Math.min(MK.in, MK.out), b = Math.max(MK.in, MK.out);
  return b - a >= 0.04 ? [a, b] : null;
}
function renderMarks() {
  const band = $('#range'), chip = $('#rangeChip');
  if (!P || (MK.in == null && MK.out == null)) { band.classList.add('hidden'); chip.classList.add('hidden'); return; }
  const live = MK.in != null && MK.out == null;
  const a = MK.in ?? MK.out, b = MK.out ?? Math.max(MK.in, T);
  const x0 = tToX(Math.min(a, b)), x1 = tToX(Math.max(a, b));
  band.classList.remove('hidden'); band.classList.toggle('live', live); band.classList.toggle('single', MK.in == null);
  band.style.left = `${x0}px`; band.style.width = `${Math.max(0, x1 - x0)}px`;
  const r = markRange();
  chip.classList.remove('hidden');
  $('#rangeLbl').textContent = r ? `${fmt(r[1] - r[0])} marked` : MK.in != null ? 'In set · O at the end' : 'Out set · I at the start';
  $$('[data-act=keepRange], [data-act=cutRange]', chip).forEach(x => { x.disabled = !r; });
}
function setMark(which, t) {
  if (!P || !P.timeline.length) return;
  t = clamp(t, 0, total());
  if (which === 'in') { MK.in = t; if (MK.out != null && MK.out <= t + 0.04) MK.out = null; }
  else { MK.out = t; if (MK.in != null && MK.in >= t - 0.04) MK.in = null; }
  renderMarks();
}
function clearMarks() { MK.in = MK.out = null; renderMarks(); }
function markClip() { const L = locate(T); if (!L) return; MK.in = L.seg.placed.start; MK.out = L.seg.placed.end; renderMarks(); }
async function cutRange() {
  const r = markRange(); if (!r) return toast('Mark the part to cut first: I at its start, O at its end');
  stop();
  await guard(async () => { const p = await api('POST', `/api/projects/${P.name}/cut`, { start: r[0], end: r[1] }); MK.in = MK.out = null; setProject(p); seek(r[0], true); toast(`Cut out ${fmt(p.removed)} · ⌘Z undoes`); });
}
async function keepRange() {
  const r = markRange(); if (!r) return toast('Mark the part to keep first: I at its start, O at its end');
  stop();
  await guard(async () => { const p = await api('POST', `/api/projects/${P.name}/keep`, { start: r[0], end: r[1] }); MK.in = MK.out = null; setProject(p); seek(p.at, true); toast(`Kept the marked part, trimmed ${fmt(p.removed)} · ⌘Z undoes`); });
}

// ---- scrubbing: the ruler and the playhead's red head; shift-drag on the ruler marks a range
function dragOn(el, { down, move, up }) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const ctx = down(e); if (ctx === false) return;
    e.preventDefault(); e.stopPropagation(); TL.dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch { }
    const mv = ev => move && move(ev, ctx);
    const end = ev => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); TL.dragging = false; if (up) up(ev, ctx); if (TL.pending) { TL.pending = false; renderTimeline(); } };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  });
}
const scrubState = { was: false };
const scrubStart = () => { scrubState.was = playing; stop(); };
const scrubEnd = () => { if (scrubState.was) play(); };
dragOn($('#ruler'), {
  down: e => { if (!P || !P.timeline.length) return false; scrubStart(); const t = xToT(contentX(e)); if (e.shiftKey) { MK.in = MK.out = t; renderMarks(); return { from: t }; } seek(t, true); return {}; },
  move: (ev, c) => { const t = xToT(contentX(ev)); if (c.from != null) { MK.in = Math.min(c.from, t); MK.out = Math.max(c.from, t); renderMarks(); } seek(t); },
  up: (ev, c) => { if (c.from != null && !markRange()) clearMarks(); scrubEnd(); },
});
dragOn($('#playhead .head'), { down: () => { scrubStart(); return {}; }, move: ev => seek(xToT(contentX(ev))), up: scrubEnd });
for (const side of ['l', 'r']) dragOn($(`#range .edge.${side}`), {
  down: () => { const r = markRange(); if (!r) return false; stop(); return { other: side === 'l' ? r[1] : r[0] }; },
  move: (ev, c) => { const t = xToT(contentX(ev)); if (side === 'l') { MK.in = Math.min(t, c.other - 0.05); MK.out = c.other; } else { MK.in = c.other; MK.out = Math.max(t, c.other + 0.05); } renderMarks(); seek(t); },
});
$('#tl').addEventListener('pointermove', e => {
  const hv = $('#hoverTime'); if (!hv || !P || !P.timeline.length) return;
  if (!(e.target.closest && e.target.closest('#ruler'))) { hv.classList.add('hidden'); return; }
  const x = contentX(e); hv.classList.remove('hidden'); hv.style.left = `${x}px`; hv.textContent = fmt(xToT(x));
});
$('#tl').addEventListener('pointerleave', () => { const hv = $('#hoverTime'); if (hv) hv.classList.add('hidden'); });
$('#track').addEventListener('pointerdown', e => { if (e.target === $('#track') || e.target.id === 'tlEmpty') select(null); });

// ---- zoom and scale
function setZoom(z, anchorT = T, anchorClientX = null) {
  const tl = $('#tl');
  const sx = anchorClientX != null ? anchorClientX - tl.getBoundingClientRect().left : tToX(anchorT) - tl.scrollLeft;
  TL.zoom = clamp(z, 1, 80); renderTimeline();
  tl.scrollLeft = Math.max(0, tToX(anchorT) - sx);
}
$('#zoomIn').onclick = () => setZoom(TL.zoom * 1.5);
$('#zoomOut').onclick = () => setZoom(TL.zoom / 1.5);
$('#zoomFit').onclick = () => setZoom(1);
$('#tl').addEventListener('wheel', e => { if (!(e.metaKey || e.ctrlKey)) return; e.preventDefault(); setZoom(TL.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), xToT(contentX(e)), e.clientX); }, { passive: false });
function updateScaleBtn() {
  const b = $('#scaleBtn'); b.textContent = TL.log ? 'Log' : 'Linear';
  b.title = TL.log ? 'Clip widths follow log(length) so short clips stay visible. Click for true-length widths.' : 'Clip widths are proportional to length. Click for log widths (short clips stay visible).';
}
$('#scaleBtn').onclick = () => { TL.log = !TL.log; lsSet('kv.tlScale', TL.log ? 'log' : 'linear'); updateScaleBtn(); if (P) setZoom(TL.zoom); };
updateScaleBtn();

function trimDrag(e, s, which) {
  e.preventDefault(); e.stopPropagation(); stop(); select(s.id);
  const b = e.currentTarget.closest('.block'); const x0 = e.clientX; const m = s.media || {}; const dur = m.duration || s.placed.src_out;
  const blk = TL.blocks.find(k => k.s.id === s.id); const k = blk ? pxPerSecIn(blk) : 20;   // px per timeline second in this block
  const left0 = parseFloat(b.style.left), width0 = parseFloat(b.style.width), spd = s.speed || 1;
  const in0 = s.placed.src_in, out0 = s.placed.src_out; let nin = in0, nout = out0;
  const h = e.currentTarget; try { h.setPointerCapture(e.pointerId); } catch { } TL.dragging = true;
  const phSrc = (T >= s.placed.start && T <= s.placed.end) ? in0 + (T - s.placed.start) * spd : null;  // snap target
  h.onpointermove = ev => {
    const ds = (ev.clientX - x0) / k * spd;
    if (which === 'in') {
      nin = clamp(in0 + ds, 0, out0 - 0.2);
      if (phSrc != null && Math.abs(nin - phSrc) / spd * k < 8) nin = phSrc;
      const dx = (nin - in0) / spd * k;
      VP.showSource(s, nin); b.style.left = `${left0 + dx}px`; b.style.width = `${Math.max(8, width0 - dx)}px`;
    } else {
      nout = clamp(out0 + ds, in0 + 0.2, dur);
      if (phSrc != null && Math.abs(nout - phSrc) / spd * k < 8) nout = phSrc;
      VP.showSource(s, nout); b.style.width = `${Math.max(8, width0 + (nout - out0) / spd * k)}px`;
    }
    $('.meta', b).textContent = fmt((nout - nin) / spd);
  };
  h.onpointerup = () => {
    h.onpointermove = h.onpointerup = null; TL.dragging = false;
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
function select(id) { sel = id; selVo = selSting = selImg = null; selMusic = false; if (P) setTimeout(() => VP.sync(T), 0); $$('#track .block').forEach(b => b.classList.toggle('selected', b.dataset.id === id)); $$('#lanes .selected').forEach(x => x.classList.remove('selected')); renderInspector(); }

// ================================================================== edits
async function patchSeg(id, body) { return guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/segments/${id}`, body)); }); }
async function patchProject(body) { return guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}`, body)); }); }
async function undo() { if (!P.can_undo) return; await guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/undo`)); toast('Undo'); }); }
async function redo() { if (!P.can_redo) return; await guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/redo`)); toast('Redo'); }); }
$('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
const ctxActions = {
  split: () => { if ($('[data-act=split]').disabled) return toast('Put the playhead inside a clip to split it'); guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/split`, { time: T })); }); },
  markIn: () => setMark('in', T),
  markOut: () => setMark('out', T),
  keepRange: () => keepRange(),
  cutRange: () => cutRange(),
  clearRange: () => clearMarks(),
  title: () => titleAt(T),
  trimStart: () => { const L = locate(T); if (L && L.seg.kind === 'clip') patchSeg(L.seg.id, { in: L.seg.placed.src_in + L.off * (L.seg.speed || 1) }).then(() => seek(L.seg.placed.start, true)); },
  trimEnd: () => { const L = locate(T); if (L && L.seg.kind === 'clip') patchSeg(L.seg.id, { out: L.seg.placed.src_in + L.off * (L.seg.speed || 1) }); },
  addTitle: () => addTitleSheet(),
  record: () => openRecorder('clip'),
  music: () => { selMusic = true; sel = selVo = selSting = selImg = null; renderInspector(); renderTimeline(); if (!(P.music && P.music.file)) pickMusic(); },
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
  const el = $('#inspBody'); const s = seg(); const v = (P.voiceovers || []).find(x => x.id === selVo); const m = (P.stings || []).find(x => x.id === selSting); const im = imgOf(selImg);
  if (!s && !v && !m && !im && !selMusic) { closeInspector(); return; }
  openInspector();
  const close = '<button class="close" id="inspClose">✕</button>';
  if (selMusic) { renderMusicInspector(el, close); return; }
  if (v) { renderVoInspector(el, v, close); return; }
  if (m) { renderStingInspector(el, m, close); return; }
  if (im) { renderImageInspector(el, im, close); return; }
  const trOpts = ['', 'cut', 'fade', 'dip'].map(x => `<option value="${x}" ${(s.transition || '') === x ? 'selected' : ''}>${x || `default (${P.style.transition})`}</option>`).join('');
  let html;
  if (s.kind === 'title') {
    const imgRow = s.image
      ? `<div class="insp-img">${s.image_url ? `<img src="${s.image_url}">` : ''}<span class="sub" title="${esc(s.image)}">${esc(s.image.replace(/^assets\//, ''))}${s.image_missing ? ' <b style="color:var(--danger)">missing</b>' : ''}</span><span class="spacer"></span><select data-k="fit" style="flex:0 0 auto"><option value="contain" ${s.fit !== 'cover' ? 'selected' : ''}>Fit</option><option value="cover" ${s.fit === 'cover' ? 'selected' : ''}>Fill</option></select><button class="link" id="imgPick">Change…</button><button class="link muted" id="imgClear">Remove</button></div>`
      : `<div class="inline"><button class="link" id="imgPick">Choose an image…</button></div>`;
    html = `<h3>${s.image && !s.title ? 'Image card' : 'Title card'} ${close}</h3>` + field('Kicker (small line above)', `<input type="text" data-k="kicker" value="${esc(s.kicker || '')}" placeholder="e.g. Daily Vlogs">`) +
      field('Title', `<input type="text" data-k="text" value="${esc(s.title)}">`) + field('Subtitle', `<input type="text" data-k="subtitle" value="${esc(s.subtitle || '')}">`) +
      field('Background image', imgRow) +
      `<div class="inline">${field('Seconds', `<input type="number" data-k="duration" step="0.5" min="0.5" value="${s.duration}">`)}${field('Layout', `<select data-k="layout" ${s.image ? 'disabled' : ''}><option value="center" ${s.layout !== 'lower' ? 'selected' : ''}>Centered</option><option value="lower" ${s.layout === 'lower' ? 'selected' : ''}>Lower third</option></select>`)}</div>` +
      field('Colors', `<div class="inline"><input type="color" data-k="bg" value="${s.bg || P.style.title_bg}" title="background"><input type="color" data-k="fg" value="${s.fg || P.style.title_fg}" title="text"><button class="link muted" id="titleColorsReset">use project colors</button></div>`);
  } else {
    const m = s.media || {};
    html = `<h3>Clip <span class="sub" title="${esc(s.clip)}">${esc(s.clip.replace(/^clips\//, ''))}</span>${close}</h3>` +
      `<div class="muted" style="margin:-6px 0 12px">${m.width ? `${m.width}×${m.height}${m.hdr ? ' HDR' : ''} · ${fmt(m.duration)}` : ''}${s.lufs != null ? ` · ${s.lufs.toFixed(0)} LUFS${P.match_levels ? ` (${(20 * Math.log10(gainFactor(s))).toFixed(0) >= 0 ? '+' : ''}${(20 * Math.log10(gainFactor(s))).toFixed(0)} dB)` : ''}` : ''}${s.missing ? ' · <b style="color:var(--danger)">file missing</b>' : ''}</div>` +
      field('In → out (source time)', `<div class="inline"><input type="text" data-k="in" value="${fmt(s.in || 0, 2)}"><span class="muted">→</span><input type="text" data-k="out" value="${s.out == null ? 'end' : fmt(s.out, 2)}"></div>`) +
      `<button class="link" id="segTrim" style="margin:-8px 0 10px -8px" ${s.missing ? 'disabled' : ''}>Re-trim against the whole clip…</button>` +
      (segMarkers(s).length ? field('Markers', `<div class="mklist">${segMarkers(s).map(mk => `<span class="mkchip"><button class="link" data-mkgo="${mk.t}" title="Jump here">◆ ${fmt(mk.t)}</button><button class="link muted" data-mkrm="${mk.src}" title="Remove this marker">✕</button></span>`).join('')}</div>`) : '') +
      field('Caption', `<input type="text" data-k="caption" value="${esc(s.caption || '')}" placeholder="lower third for the whole clip">`) +
      `<div class="field"><label>Text overlays</label><div id="ovList"></div><button class="link" id="ovAdd" style="align-self:flex-start">+ Add overlay at playhead</button></div>` +
      field('Speed', `<div class="inline"><input type="range" data-k="speed" min="0.25" max="4" step="0.25" value="${s.speed || 1}"><span id="speedLbl" style="width:34px">${s.speed || 1}×</span></div>`) +
      field('Fit', `<select data-k="fit"><option value="contain" ${s.fit !== 'cover' ? 'selected' : ''}>Letterbox (show everything)</option><option value="cover" ${s.fit === 'cover' ? 'selected' : ''}>Crop to fill</option></select>`) +
      pipInspectorHtml(s) +
      `<div class="check"><input type="checkbox" id="muteChk" ${s.mute ? 'checked' : ''}><label for="muteChk">Mute</label></div>` +
      field('Volume', `<input type="range" data-k="volume" min="0" max="2" step="0.1" value="${s.volume ?? 1}">`) +
      (m.has_audio ? field('Channels', `<select data-k="channel">${channelOptions(s)}</select>`) : '');
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
  if ($('#imgPick')) $('#imgPick').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'image' }); if (r.paths[0]) await patchSeg(s.id, { image: r.paths[0] }); });
  if ($('#imgClear')) $('#imgClear').onclick = () => patchSeg(s.id, { image: '' });
  if ($('#muteChk')) $('#muteChk').onchange = e => patchSeg(s.id, { mute: e.target.checked });
  if (s.kind === 'clip') bindPipInspector(s);
  if ($('#segTrim')) $('#segTrim').onclick = () => openTrimmer([s.clip], { segId: s.id });
  $$('[data-mkgo]', el).forEach(b => b.onclick = () => { stop(); seek(+b.dataset.mkgo, true); });
  $$('[data-mkrm]', el).forEach(b => b.onclick = () => patchSeg(s.id, { markers: (s.markers || []).filter(m => Math.abs(m - +b.dataset.mkrm) > 1e-4) }));
  $('#segDelete').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/segments/${s.id}`)); });
  const move = d => { const ids = P.timeline.map(x => x.id); const i = ids.indexOf(s.id); const j = clamp(i + d, 0, ids.length - 1); if (i === j) return; ids.splice(i, 1); ids.splice(j, 0, s.id); guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/reorder`, { ids })); const ns = seg(); if (ns) seek(ns.placed.start, true); }); };
  $('#segUp').onclick = () => move(-1); $('#segDown').onclick = () => move(1);
  $('#segDup').onclick = () => guard(async () => {
    const at = P.timeline.findIndex(x => x.id === s.id) + 1;
    const p = await api('POST', `/api/projects/${P.name}/segments`, s.kind === 'title' ? { kind: 'title', text: s.title, subtitle: s.subtitle, kicker: s.kicker, image: s.image, duration: s.duration, bg: s.bg, fg: s.fg, at } : { kind: 'clip', src: s.clip, at });
    if (s.kind === 'clip') await api('PATCH', `/api/projects/${P.name}/segments/${p.timeline[at].id}`, { in: s.in, out: s.out ?? '', speed: s.speed, mute: s.mute, caption: s.caption || '', fit: s.fit });
    else if (s.layout !== 'center' || s.fit === 'cover' || s.transition) await api('PATCH', `/api/projects/${P.name}/segments/${p.timeline[at].id}`, { layout: s.layout, fit: s.fit, transition: s.transition || '', transition_duration: s.transition_duration ?? '' });
    await refresh();
  });
  if (s.kind === 'clip') renderOverlays(s);
}
// picture in picture: the inset's layout (small / large corner, stacked, hidden), corner, shape, swap
function pipInspectorHtml(s) {
  const pp = s.pip;
  if (!pp) return `<div class="field"><label>Picture in picture</label><button class="link" id="pipAdd" style="align-self:flex-start">+ Put another clip in a box over this one…</button></div>`;
  const [W, H] = canvasWH(), lay = pipLayoutOf(s), anchor = pipAnchorOf(s);
  return `<div class="field"><label>Picture in picture</label>
    <div class="insp-img">${pp.thumb_url ? `<img src="${pp.thumb_url}">` : ''}<span class="sub" title="${esc(pp.src)}">${esc(pp.src.replace(/^clips\//, ''))}${pp.missing ? ' <b style="color:var(--danger)">missing</b>' : ''}</span><span class="spacer"></span><button class="link" id="pipSwap" title="Show the inset big and this clip in the box instead">⇄ Swap</button><button class="link muted" id="pipRm">Remove</button></div>
    <div class="seg" id="pipLayout">${pipLayoutNames(W, H).map(([k, l]) => `<button data-k="${k}" class="${k === lay ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${!pp.hidden && !(s.box && pp.box[3] != null) ? `<div class="inline" style="margin-top:8px"><div class="grid9" id="pipPos">${POS9.map(p => `<button data-p="${p}" class="${p === anchor ? 'on' : ''}"></button>`).join('')}</div><span class="muted" style="font-size:11.5px;line-height:1.4">or drag it on the video;<br>drag a corner to resize</span></div>` : ''}
    ${!pp.hidden ? `<div class="seg" id="pipShape" style="margin-top:8px"><button data-v="round" class="${pp.shape === 'round' ? 'on' : ''}">Rounded</button><button data-v="rect" class="${pp.shape === 'rect' ? 'on' : ''}">Square corners</button><button data-v="circle" class="${pp.shape === 'circle' ? 'on' : ''}">Circle</button></div>` : ''}
  </div>`;
}
function bindPipInspector(s) {
  const lay = pipLayoutOf(s), anchor = pipAnchorOf(s);
  if ($('#pipAdd')) $('#pipAdd').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'files' }); if (r.paths[0]) { await patchSeg(s.id, { pip: { clip: r.paths[0] }, pip_layout: 'corner:br' }); toast('Inset added: drag it on the video, or pick a layout'); } });
  if ($('#pipSwap')) $('#pipSwap').onclick = () => patchSeg(s.id, { pip_swap: true });
  if ($('#pipRm')) $('#pipRm').onclick = () => patchSeg(s.id, { pip: null, box: null });
  $$('#pipLayout button').forEach(b => b.onclick = () => patchSeg(s.id, { pip_layout: b.dataset.k + (b.dataset.k.startsWith('corner') && anchor ? ':' + anchor : '') }));
  $$('#pipPos button').forEach(b => b.onclick = () => patchSeg(s.id, { pip_layout: `${lay === 'corner-large' ? 'corner-large' : 'corner'}:${b.dataset.p}` }));
  $$('#pipShape button').forEach(b => b.onclick = () => patchSeg(s.id, { pip: { shape: b.dataset.v } }));
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
function renderStingInspector(el, m, close) {
  const segOpt = cur => P.timeline.map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.kind === 'title' ? (s.title || (s.image ? s.image.split('/').pop() : 'black')) : s.clip.replace(/^clips\//, ''))}</option>`).join('');
  el.innerHTML = `<h3>Music sting ${close}</h3><div class="muted" style="margin:-6px 0 12px">${esc(m.file.split('/').pop())}${m.at != null ? ` · plays ${fmt(m.at)} → ${fmt(m.end)}` : ' · <b style="color:var(--danger)">its segments are gone</b>'}${m.missing ? ' · <b style="color:var(--danger)">file missing</b>' : ''}</div>` +
    field('From', `<select id="stFrom">${segOpt(m.from)}</select>`) + field('Through', `<select id="stTo">${segOpt(m.to)}</select>`) +
    field('Start in the song', `<div class="inline"><input type="text" id="stStart" value="${fmt(m.start || 0, 2)}"><span class="muted">of ${fmt(m.file_duration || 0)}</span></div>`) +
    field('Volume', `<input type="range" id="stVol" min="0" max="1.5" step="0.05" value="${m.volume}">`) +
    `<div class="inline">${field('Fade in (s)', `<input type="number" id="stFi" step="0.1" min="0" value="${m.fade_in}">`)}${field('Fade out (s)', `<input type="number" id="stFo" step="0.1" min="0" value="${m.fade_out}">`)}</div>` +
    `<div class="check"><input type="checkbox" id="stDuck" ${m.duck !== false ? 'checked' : ''}><label for="stDuck">Lower it while people talk</label></div>` +
    `<div class="sep"></div><div class="actions"><span class="spacer"></span><button class="link danger" id="stDel">Delete</button></div>`;
  $('#inspClose').onclick = () => { selSting = null; renderTimeline(); renderInspector(); };
  const patch = body => guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/stings/${m.id}`, body)); });
  $('#stFrom').onchange = e => patch({ from: e.target.value }); $('#stTo').onchange = e => patch({ to: e.target.value });
  $('#stStart').onchange = e => patch({ start: e.target.value }); $('#stStart').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#stVol').onchange = e => patch({ volume: +e.target.value });
  $('#stFi').onchange = e => patch({ fade_in: +e.target.value }); $('#stFo').onchange = e => patch({ fade_out: +e.target.value });
  $('#stDuck').onchange = e => patch({ duck: e.target.checked });
  $('#stDel').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/stings/${m.id}`)); selSting = null; renderInspector(); });
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
  { label: 'Record screen (+ camera)…', fn: () => openRecorder('screen') },
  { label: 'Record voiceover…', fn: () => openRecorder('voiceover') },
  '-',
  { label: 'Title card', fn: addTitleSheet },
  { label: 'Picture over the video…', k: '⌘V pastes', fn: () => pickImages() },
  { label: 'Masthead card', fn: () => guard(async () => { const at = sel ? P.timeline.findIndex(s => s.id === sel) + 1 : null; const p = await api('POST', `/api/projects/${P.name}/segments`, { kind: 'masthead', at }); setProject(p); const ns = at == null ? p.timeline[p.timeline.length - 1] : p.timeline[at]; if (ns) { select(ns.id); seek(ns.placed.start, true); } }) },
  { label: 'Music sting over selection…', fn: () => addSting(null) },
  { label: 'Continue the intro song over selection', fn: () => addSting('intro') },
  { label: 'Music…', fn: () => ctxActions.music() },
]);
// A music cue over the selected segment(s). file = null picks a song; 'intro' continues the configured
// intro song from where the last cue using it stopped (so the rest of the track comes in later).
async function addSting(file) {
  const s = seg(); if (!s) return toast('Select a clip first, then add the music over it');
  await guard(async () => {
    const body = { from: s.id, to: s.id };
    if (file === 'intro') {
      body.file = 'intro'; body.fade_in = 1.5; body.fade_out = 2;
      const prev = (P.stings || []).filter(m => /(^|\/)sting\.[a-z0-9]+$/i.test(m.file) && m.at != null && m.end <= s.placed.start + 0.01).sort((a, b) => b.end - a.end)[0];
      if (prev) body.start = (prev.start || 0) + (prev.end - prev.at);
    } else {
      const r = await api('POST', '/api/pick', { kind: 'music' }); if (!r.paths[0]) return;
      body.file = r.paths[0];
    }
    const p = await api('POST', `/api/projects/${P.name}/stings`, body);
    setProject(p); selSting = p.stings[p.stings.length - 1].id; sel = null; renderTimeline(); renderInspector();
    toast('Music added — set "Through" in the inspector to stretch it over more clips');
  });
}
let immichVids = [], picked = new Set();
const trimOnImport = () => lsGet('kv.trimImport', '1') === '1';
function openLibrary(tab) {
  sheet(`<div class="inline libhead"><div class="tabs"><button class="tab ${tab === 'immich' ? 'active' : ''}" data-t="immich">Immich</button><button class="tab ${tab === 'files' ? 'active' : ''}" data-t="files">Files</button><button class="tab ${tab === 'clips' ? 'active' : ''}" data-t="clips">In this project</button></div><span class="spacer"></span>
    <label class="check libtrim" title="New clips open in the trimmer one by one: pick the part you want, press Enter for the next"><input type="checkbox" id="libTrim" ${trimOnImport() ? 'checked' : ''}> Trim each clip before it goes on the timeline</label></div>
    <div id="libBody"></div>`, { wide: true });
  $('#libTrim').onchange = e => lsSet('kv.trimImport', e.target.checked ? '1' : '0');
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
    b.innerHTML = P.clips.length ? `<div class="cards">${P.clips.map(c => `<div class="card ${c.in_timeline ? 'inproj' : ''}" data-src="${esc(c.src)}" title="Click to pick the part you want">${c.thumb_url ? `<img src="${c.thumb_url}">` : '<div class="noimg">…</div>'}<div class="ci">${esc(c.name)}${c.media ? ` · ${fmt(c.media.duration)}` : ''}</div>${c.in_timeline ? '<span class="badge">in timeline</span>' : ''}<button class="quick" title="Add the whole clip to the end">+ whole</button></div>`).join('')}</div><p class="muted">Click a clip to pick the part you want. <b>+ whole</b> adds all of it.</p>` : '<div class="hint">No clips in this project yet.</div>';
    $$('.card', b).forEach(c => c.onclick = e => {
      if (e.target.closest('.quick')) { e.stopPropagation(); return guard(async () => { setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'clip', src: c.dataset.src })); toast('Added the whole clip'); }); }
      openTrimmer([c.dataset.src]);
    });
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
async function importPaths(paths) {
  const trim = trimOnImport();
  await guard(async () => { const r = await api('POST', `/api/projects/${P.name}/import`, { paths, add: !trim }); setProject(r.project); closeSheet(); if (trim && r.added.length) openTrimmer(r.added); else toast(`Imported ${r.added.length} clip(s)`); });
}
async function importImmich(assets) {
  if (!assets.length) return toast('Nothing to add');
  closeSheet(); const trim = trimOnImport();
  await guard(async () => { const j = await api('POST', `/api/projects/${P.name}/import-immich`, { assets: assets.map(a => ({ id: a.id, filename: a.filename })), add: !trim }); watchJob(j, async done => { await refresh(); if (trim && done.added && done.added.length) openTrimmer(done.added); else toast(`Added ${assets.length} clip(s)`); }); });
}
// whole-window drop of files
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files') && P) { dragDepth++; if (!$('#dropHint')) { const d = document.createElement('div'); d.id = 'dropHint'; d.textContent = 'Drop videos to add clips, or pictures to show them over the video'; document.body.appendChild(d); } } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint') && $('#dropHint').remove(); } });
window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  dragDepth = 0; $('#dropHint') && $('#dropHint').remove();
  if (!e.dataTransfer.files.length || !P) return; e.preventDefault();
  const all = [...e.dataTransfer.files];
  const pics = all.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name)), vids = all.filter(f => !pics.includes(f));
  if (pics.length) uploadImages(pics, e.target.closest && e.target.closest('#tl') ? xToT(contentX(e)) : T);
  if (!vids.length) return;
  const fd = new FormData(); for (const f of vids) fd.append('files', f);
  toast(`Uploading ${vids.length} file(s)…`);
  const trim = trimOnImport();
  guard(async () => { const r = await api('POST', `/api/projects/${P.name}/upload?add=${!trim}`, fd); setProject(r.project); closeSheet(); if (trim && r.added.length) openTrimmer(r.added); else toast(`Imported ${r.added.length} clip(s)`); });
});

// ================================================================== pictures over the video (the images track)
// Each picture shows for a while, full screen or in a box. They sit on the pink lane above the clips
// (drag to move, drag an end to change how long), and in the player (drag to place, corners resize).
const imgOf = id => (P && id ? (P.images || []).find(x => x.id === id) : null);
const IMG_SIZES = [['full', 'Full screen', null], ['large', 'Large', 0.8], ['half', 'Half', 0.5], ['small', 'Small', 0.32]];
const POS9 = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
// ---- picture in picture (a second clip in a box over a clip): layout math shared by the player,
// the inspector and the recorder preview. Boxes are [x, y, w, h] fractions of the frame (centre and
// size; h null = the picture's own aspect). Mirrors edits.pip_layout on the server.
const canvasWH = () => (P && P.layout) ? [P.layout.width, P.layout.height] : [1920, 1080];
const pipAspect = m => (m && m.width && m.height) ? m.height / m.width : 9 / 16;   // height / width of the inset's picture
function pipAnchorBox(w, pos, W, H, aspect, m = 0.04) {
  const hf = w * W / H * aspect, i = Math.max(0, POS9.indexOf(pos)), col = i % 3, row = Math.floor(i / 3);
  return [[m + w / 2, 0.5, 1 - m - w / 2][col], [m + hf / 2, 0.5, 1 - m - hf / 2][row], w, null].map(v => v == null ? null : +v.toFixed(4));
}
function pipLayoutBoxes(name, pos, W, H, aspect) {   // -> { box: main clip's box or null, pip: inset box, shape }
  const portrait = H > W;
  if (name === 'stacked') {
    if (!portrait) return { box: [0.69, 0.5, 0.62, 1], pip: [0.19, 0.5, 0.38, 1], shape: 'rect' };
    const hc = +(W / H).toFixed(4);
    return { box: [0.5, +((1 + hc) / 2).toFixed(4), 1, +(1 - hc).toFixed(4)], pip: [0.5, +(hc / 2).toFixed(4), 1, hc], shape: 'rect' };
  }
  const w = name === 'corner-large' ? (portrait ? 0.6 : 0.45) : (portrait ? 0.42 : 0.3);
  return { box: null, pip: pipAnchorBox(w, pos || 'br', W, H, aspect), shape: 'round' };
}
const pipLayoutNames = (W, H) => [['corner', 'Small inset'], ['corner-large', 'Large inset'], ['stacked', H > W ? 'Stacked' : 'Side by side'], ['hidden', 'Hide inset']];
function pipLayoutOf(s) {      // which standard layout a clip + inset currently is in ('' = custom)
  const pp = s.pip; if (!pp) return '';
  if (pp.hidden) return 'hidden';
  const [W, H] = canvasWH(), portrait = H > W;
  if (s.box && pp.box[3] != null) return 'stacked';
  if (pp.box[3] != null) return '';
  const w = pp.box[2];
  return Math.abs(w - (portrait ? 0.42 : 0.3)) < 0.01 ? 'corner' : Math.abs(w - (portrait ? 0.6 : 0.45)) < 0.01 ? 'corner-large' : '';
}
function pipAnchorOf(s) {
  const pp = s.pip; if (!pp || pp.box[3] != null) return null;
  const [W, H] = canvasWH(), ar = pipAspect(pp.media);
  return POS9.find(p => { const [ax, ay] = pipAnchorBox(pp.box[2], p, W, H, ar); return Math.abs(ax - pp.box[0]) < 0.01 && Math.abs(ay - pp.box[1]) < 0.01; }) || null;
}
const boxH = (box, W, H, aspect, shape) => box[3] != null ? box[3] : box[2] * W / H * (shape === 'circle' ? 1 : aspect);
function boxStyle(el, box, W, H, aspect, shape) {   // position an absolutely placed element (centre-anchored) in a box
  el.style.left = `${box[0] * 100}%`; el.style.top = `${box[1] * 100}%`; el.style.width = `${box[2] * 100}%`; el.style.height = `${boxH(box, W, H, aspect, shape) * 100}%`;
}
function mainBoxStyle(el, box, mirror = false, W = null, H = null) {   // a <video> that normally fills its container, placed in a box (or back to full)
  if (box) { if (W == null) [W, H] = canvasWH(); boxStyle(el, box, W, H, 9 / 16); el.style.right = el.style.bottom = 'auto'; el.style.transform = `translate(-50%, -50%)${mirror ? ' scaleX(-1)' : ''}`; }
  else { el.style.left = el.style.top = el.style.width = el.style.height = el.style.right = el.style.bottom = ''; el.style.transform = mirror ? 'scaleX(-1)' : ''; }
}
function imgHeightFrac(L, w) {   // the picture's height as a fraction of the frame height, at width fraction w
  const fw = (P.layout && P.layout.width) || 1920, fh = (P.layout && P.layout.height) || 1080;
  return w * fw / fh * ((L.ih || 9) / (L.iw || 16));
}
function anchorBox(L, w, pos, m = 0.05) {
  const hf = imgHeightFrac(L, w), i = Math.max(0, POS9.indexOf(pos)), col = i % 3, row = Math.floor(i / 3);
  return [[m + w / 2, 0.5, 1 - m - w / 2][col], [m + hf / 2, 0.5, 1 - m - hf / 2][row], w].map(v => +v.toFixed(4));
}
function currentAnchor(L) {
  if (!L.box) return null;
  return POS9.find(p => { const [ax, ay] = anchorBox(L, L.box[2], p); return Math.abs(ax - L.box[0]) < 0.01 && Math.abs(ay - L.box[1]) < 0.01; }) || null;
}
const sizeName = L => !L.box ? 'full' : ((IMG_SIZES.find(z => z[2] && Math.abs(z[2] - L.box[2]) < 0.01) || [0, 'box'])[1]).toLowerCase();
function selectImage(id, { seekInto = true } = {}) {
  selImg = id; sel = selVo = selSting = null; selMusic = false;
  $$('#track .block.selected, #lanes .selected').forEach(x => x.classList.remove('selected'));
  $$('#imgLane .imgblk').forEach(x => x.classList.toggle('selected', x.dataset.id === id));
  const L = imgOf(id);
  if (L && seekInto && !(T >= L.at && T < L.at + L.duration)) seek(Math.min(L.at + Math.min(0.5, L.duration / 2), total()), true);
  else VP.sync(T, true);
  renderInspector();
}
async function patchImage(id, body) {
  try { setProject(await api('PATCH', `/api/projects/${P.name}/images/${id}`, body)); }
  catch (e) { toast(e.message, true); refresh(); }
}
async function deleteImage(id) { await guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/images/${id}`)); selImg = null; renderInspector(); VP.sync(T, true); toast('Picture removed · ⌘Z undoes'); }); }
async function addImages(files, at = T) {
  await guard(async () => {
    const p = await api('POST', `/api/projects/${P.name}/images`, { files, at, for: 3 });
    setProject(p); if (p.new_ids && p.new_ids.length) selectImage(p.new_ids[0]);
    toast(`${files.length > 1 ? `${files.length} pictures` : 'Picture'} added at ${fmt(at)} · drag it on the timeline or on the video`);
  });
}
async function uploadImages(list, at = T) {
  const fd = new FormData(); for (const f of list) fd.append('files', f, f.name || 'pasted.png'); fd.append('at', at); fd.append('dur', 3);
  await guard(async () => {
    const p = await api('POST', `/api/projects/${P.name}/images/upload`, fd);
    setProject(p); if (p.new_ids && p.new_ids.length) selectImage(p.new_ids[0]);
    toast(`${p.new_ids.length > 1 ? `${p.new_ids.length} pictures` : 'Picture'} added at ${fmt(at)} · drag it on the timeline or on the video`);
  });
}
const pickImages = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'images' }); if (r.paths.length) await addImages(r.paths, T); });
document.addEventListener('paste', e => {
  if (!P || sheetOpen()) return;
  const tag = document.activeElement && document.activeElement.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault(); uploadImages(files, T);
});
function renderImageLane() {
  const lane = $('#imgLane'), imgs = P.images || [], ROW = 28;
  const rows = [], rowOf = new Map();       // overlapping pictures get their own rows
  for (const L of [...imgs].sort((a, b) => a.at - b.at)) { let r = rows.findIndex(end => end <= L.at + 1e-3); if (r < 0) { r = rows.length; rows.push(0); } rows[r] = L.at + L.duration; rowOf.set(L.id, r); }
  const marks = allMarkers();
  lane.style.width = `${TL.W}px`; lane.style.height = imgs.length ? `${rows.length * ROW + 4}px` : '24px';
  lane.innerHTML = imgs.length ? '' : marks.length ? '' : '<div class="lanehint">Pictures over the video go here: drop or paste one (⌘V), or + Add ▸ Picture</div>';
  for (const L of imgs) {
    const d = document.createElement('div');
    d.className = 'imgblk' + (L.id === selImg ? ' selected' : '') + (L.missing ? ' missing' : ''); d.dataset.id = L.id;
    const place = (a, b) => { const x0 = tToX(a); d.style.left = `${x0}px`; d.style.width = `${Math.max(22, tToX(b) - x0)}px`; };
    place(L.at, L.at + L.duration); d.style.top = `${2 + rowOf.get(L.id) * ROW}px`;
    d.innerHTML = `${L.url ? `<img src="${L.url}" draggable="false">` : ''}<span>${fmt(L.duration)} · ${sizeName(L)}</span><div class="eh l"></div><div class="eh r"></div>`;
    d.title = `${L.file.split('/').pop()}: drag to move, drag an end to change how long it shows`;
    dragOn(d, {
      down: e => { stop(); const eh = e.target.closest('.eh'); selectImage(L.id, { seekInto: false }); return { edge: eh ? (eh.classList.contains('l') ? 'l' : 'r') : null, x: e.clientX, a: L.at, b: L.at + L.duration, ph: T, moved: false }; },
      move: (ev, c) => {
        const dx = ev.clientX - c.x; if (!c.moved && Math.abs(dx) < 3) return; c.moved = true;
        const snap = t => (Math.abs(tToX(t) - tToX(c.ph)) < 8 ? c.ph : t);    // to where the playhead was when the drag began
        let a = c.a, b = c.b;
        if (c.edge === 'l') a = clamp(snap(xToT(tToX(c.a) + dx)), 0, c.b - 0.3);
        else if (c.edge === 'r') b = Math.max(c.a + 0.3, snap(xToT(tToX(c.b) + dx)));
        else { a = clamp(snap(xToT(tToX(c.a) + dx)), 0, Math.max(0, total() - 0.2)); b = a + (c.b - c.a); }
        c.na = a; c.nb = b; place(a, b); $('span', d).textContent = `${fmt(b - a)} · ${sizeName(L)}`;
        L.at = a; L.duration = b - a;                   // live preview in the player
        seek(c.edge === 'r' ? Math.max(a, b - 0.04) : a + 0.01);
      },
      up: (ev, c) => {
        if (c.moved && c.na != null) patchImage(L.id, { at: +c.na.toFixed(3), for: +(c.nb - c.na).toFixed(3) });
        else if (!(T >= L.at && T < L.at + L.duration)) seek(L.at + Math.min(0.5, L.duration / 2), true);
      },
    });
    lane.appendChild(d);
  }
  for (const mk of marks) {
    const done = imgs.some(L => Math.abs(L.at - mk.t) < 0.35 || (L.at <= mk.t && mk.t < L.at + L.duration));
    const pin = document.createElement('button');
    pin.className = 'mkpin' + (done ? ' done' : ''); pin.style.left = `${tToX(mk.t)}px`; pin.textContent = done ? '' : '+';
    pin.title = done ? `Marker at ${fmt(mk.t)}` : `Marker at ${fmt(mk.t)}: click to add pictures here (or jump here and ⌘V / drop)`;
    pin.onpointerdown = e => e.stopPropagation();
    pin.onclick = e => { e.stopPropagation(); stop(); seek(mk.t, true); if (!done) pickImages(); };
    lane.appendChild(pin);
  }
}
async function toggleMarker() {      // M: add a marker on the clip at the playhead, or remove the one right there
  const L = locate(T); if (!L || L.seg.kind !== 'clip') return toast('Markers go on clips: put the playhead over a clip');
  const s = L.seg, spd = s.speed || 1, src = s.placed.src_in + L.off * spd;
  const near = segMarkers(s).find(mk => Math.abs(tToX(mk.t) - tToX(T)) < 6 || Math.abs(mk.t - T) < 0.1);
  const markers = near ? s.markers.filter(m => m !== near.src) : [...(s.markers || []), +src.toFixed(3)];
  await patchSeg(s.id, { markers });
  toast(near ? 'Marker removed' : `◆ Marker at ${fmt(T)} · add pictures with the + above it, ⌘V or a drop`);
}
function jumpMarker(dir) {           // , and . : previous / next marker
  const ms = allMarkers(); if (!ms.length) return toast('No markers yet: press M here, or Space while recording');
  const m = dir > 0 ? ms.find(x => x.t > T + 0.02) : [...ms].reverse().find(x => x.t < T - 0.02);
  if (m) { stop(); seek(m.t, true); } else toast(dir > 0 ? 'No more markers after this' : 'No markers before this');
}
$('#imgLane').addEventListener('pointerdown', e => { if (e.target !== $('#imgLane') || !P || !P.timeline.length) return; select(null); seek(xToT(contentX(e)), true); });
// dragging a picture on the video moves it; its corners resize it from the opposite corner
function layerPointer(e, id) {
  if (e.button !== 0) return;
  const L = imgOf(id); if (!L) return;
  e.preventDefault(); e.stopPropagation(); stop();
  if (selImg !== id) selectImage(id, { seekInto: false });
  if (!L.box) return;
  const el = e.currentTarget, cr = $('#canvas').getBoundingClientRect(), cw = cr.width, ch = cr.height;
  const handle = e.target.closest('.rz'), x0 = e.clientX, y0 = e.clientY, box0 = [...L.box];
  const ar = (L.ih || 9) / (L.iw || 16), hfOf = w => w * cw * ar / ch;
  try { el.setPointerCapture(e.pointerId); } catch { }
  let moved = false;
  const move = ev => {
    let [x, y, w] = box0;
    if (handle) {
      const c = handle.dataset.c, sx = c.includes('l') ? -1 : 1, sy = c.includes('t') ? -1 : 1;
      const ox = x - sx * w / 2, oy = y - sy * hfOf(w) / 2;
      const px = (ev.clientX - cr.left) / cw, py = (ev.clientY - cr.top) / ch;
      w = clamp(Math.max(sx * (px - ox), sy * (py - oy) * ch / (cw * ar)), 0.06, 1.6);
      x = ox + sx * w / 2; y = oy + sy * hfOf(w) / 2;
    } else {
      x += (ev.clientX - x0) / cw; y += (ev.clientY - y0) / ch;
      const hf = hfOf(w), m = 0.05, tol = 0.012;       // snap to the centre lines and to a 5% margin
      for (const cx of [0.5, m + w / 2, 1 - m - w / 2]) if (Math.abs(x - cx) < tol) { x = cx; break; }
      for (const cy of [0.5, m + hf / 2, 1 - m - hf / 2]) if (Math.abs(y - cy) < tol) { y = cy; break; }
    }
    moved = true; L.box = [x, y, w];
    el.style.left = `${x * 100}%`; el.style.top = `${y * 100}%`; el.style.width = `${w * 100}%`;
  };
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    if (moved) patchImage(id, { box: L.box.map(v => +v.toFixed(4)) });
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
// dragging the inset on the video moves it; its corners resize it from the opposite corner (aspect kept)
$('#pipBox').addEventListener('pointerdown', e => {
  if (e.button !== 0 || !P) return;
  const box = $('#pipBox'), id = box.dataset.seg, s = P.timeline.find(x => x.id === id); if (!s || !s.pip) return;
  e.preventDefault(); e.stopPropagation(); stop();
  if (sel !== id) select(id);
  const cr = $('#canvas').getBoundingClientRect(), cw = cr.width, ch = cr.height, [W, H] = canvasWH();
  const handle = e.target.closest('.rz'), x0 = e.clientX, y0 = e.clientY, b0 = [...s.pip.box], ar = pipAspect(s.pip.media);
  const hfOf = w => boxH([0, 0, w, b0[3] != null ? b0[3] * w / b0[2] : null], W, H, ar, s.pip.shape);
  try { box.setPointerCapture(e.pointerId); } catch { }
  let moved = false;
  const move = ev => {
    let [x, y, w] = b0;
    if (handle) {
      const c = handle.dataset.c, sx = c.includes('l') ? -1 : 1, sy = c.includes('t') ? -1 : 1;
      const ox = x - sx * w / 2, oy = y - sy * hfOf(w) / 2;
      const px = (ev.clientX - cr.left) / cw, py = (ev.clientY - cr.top) / ch;
      w = clamp(Math.max(sx * (px - ox), sy * (py - oy) * w / hfOf(w)), 0.08, 1);
      x = ox + sx * w / 2; y = oy + sy * hfOf(w) / 2;
    } else {
      x += (ev.clientX - x0) / cw; y += (ev.clientY - y0) / ch;
      const hf = hfOf(w), m = 0.04, tol = 0.012;       // snap to the centre lines and to the margin
      for (const cx of [0.5, m + w / 2, 1 - m - w / 2]) if (Math.abs(x - cx) < tol) { x = cx; break; }
      for (const cy of [0.5, m + hf / 2, 1 - m - hf / 2]) if (Math.abs(y - cy) < tol) { y = cy; break; }
    }
    moved = true; s.pip.box = [x, y, w, b0[3] != null ? hfOf(w) : null];
    boxStyle(box, s.pip.box, W, H, ar, s.pip.shape);
  };
  const up = () => {
    box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up);
    if (moved) { const [x, y, w, h] = s.pip.box; patchSeg(id, { pip: { box: { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: h == null ? null : +h.toFixed(4) } } }); }
  };
  box.addEventListener('pointermove', move); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
});
function renderImageInspector(el, L, close) {
  const sk = !L.box ? 'full' : (IMG_SIZES.find(z => z[2] && Math.abs(z[2] - L.box[2]) < 0.01) || [''])[0], anchor = currentAnchor(L);
  el.innerHTML = `<h3>Picture <span class="sub" title="${esc(L.file)}">${esc(L.file.split('/').pop())}</span>${close}</h3>` +
    `<div class="insp-img" style="margin-bottom:12px">${L.url ? `<img src="${L.url}">` : ''}${L.missing ? '<b style="color:var(--danger)">file missing</b>' : ''}<span class="spacer"></span><button class="link" id="imChange">Change picture…</button></div>` +
    field('Starts at', `<div class="inline"><input type="text" id="imAt" value="${fmt(L.at, 2)}"><button class="link" id="imAtPh" title="Start it at the playhead">← playhead</button></div>`) +
    field('Shows for (seconds)', `<input type="number" id="imFor" step="0.5" min="0.3" value="${+L.duration.toFixed(2)}" style="width:80px">`) +
    field('Size', `<div class="seg" id="imSize">${IMG_SIZES.map(([k, label]) => `<button data-k="${k}" class="${k === sk ? 'on' : ''}">${label}</button>`).join('')}</div>`) +
    (L.box ? field('Position', `<div class="inline"><div class="grid9" id="imPos">${POS9.map(p => `<button data-p="${p}" class="${p === anchor ? 'on' : ''}"></button>`).join('')}</div><span class="muted" style="font-size:11.5px;line-height:1.4">or drag it on the video;<br>drag a corner to resize</span></div>`)
           : field('Fit', `<div class="seg" id="imFit"><button data-v="contain" class="${L.fit !== 'cover' ? 'on' : ''}">Whole picture</button><button data-v="cover" class="${L.fit === 'cover' ? 'on' : ''}">Fill the frame</button></div>`)) +
    field('Fade in / out (seconds)', `<input type="number" id="imFade" step="0.05" min="0" max="2" value="${L.fade}" style="width:70px">`) +
    `<div class="sep"></div><div class="actions"><button class="link" id="imFront" title="Draw it above the other pictures">Bring to front</button><button class="link" id="imDup">Duplicate</button><span class="spacer"></span><button class="link danger" id="imDel">Delete</button></div>`;
  $('#inspClose').onclick = () => { selImg = null; renderTimeline(); renderInspector(); VP.sync(T, true); };
  $('#imChange').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'image' }); if (r.paths[0]) await patchImage(L.id, { file: r.paths[0] }); });
  $('#imAt').onchange = e => patchImage(L.id, { at: e.target.value }); $('#imAt').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#imAtPh').onclick = () => patchImage(L.id, { at: T });
  $('#imFor').onchange = e => patchImage(L.id, { for: Math.max(0.3, +e.target.value || 3) });
  $$('#imSize button').forEach(b => b.onclick = () => {
    const z = IMG_SIZES.find(x => x[0] === b.dataset.k);
    if (!z[2]) return patchImage(L.id, { box: null });
    const pos = L.box ? currentAnchor(L) : (z[0] === 'small' ? 'tr' : 'c');
    patchImage(L.id, { box: pos ? anchorBox(L, z[2], pos) : [L.box[0], L.box[1], z[2]] });
  });
  $$('#imPos button').forEach(b => b.onclick = () => patchImage(L.id, { box: anchorBox(L, L.box[2], b.dataset.p) }));
  $$('#imFit button').forEach(b => b.onclick = () => patchImage(L.id, { fit: b.dataset.v }));
  $('#imFade').onchange = e => patchImage(L.id, { fade: Math.max(0, +e.target.value || 0) });
  $('#imFront').onclick = () => patchImage(L.id, { front: true });
  $('#imDup').onclick = () => guard(async () => { const p = await api('POST', `/api/projects/${P.name}/images`, { file: L.file, at: L.at + L.duration, for: L.duration, box: L.box, fit: L.fit }); setProject(p); if (p.new_ids) selectImage(p.new_ids[0]); });
  $('#imDel').onclick = () => deleteImage(L.id);
}

// ================================================================== trimmer (source viewer)
// Watch a clip, drag the yellow handles (or press I / O) around the part you want, press Enter.
// After an import the new clips come through one by one (Enter adds and moves on, N skips). For a
// clip already on the timeline (double-click it) the handles start at its in/out on the whole source.
const TR = { queue: [], i: 0, src: null, segId: null, dur: 0, in: 0, out: 0, stopAt: 0, raf: 0, poll: 0, added: 0 };
function openTrimmer(srcs, { segId = null } = {}) {
  srcs = (Array.isArray(srcs) ? srcs : [srcs]).filter(Boolean);
  if (!srcs.length || !P) return;
  stop();
  Object.assign(TR, { queue: srcs, i: 0, segId, added: 0, src: null, dur: 0 });
  const edit = !!segId, where = lsGet('kv.trWhere', 'end');
  sheet(`<div id="trimBox">
    <div class="trhead"><h2 id="trName"></h2><span id="trCount" class="muted"></span><span class="spacer"></span><button class="iconbtn" id="trClose" title="Close (esc)">✕</button></div>
    <div class="trstage"><video id="trVideo" playsinline preload="auto"></video><div id="trWait" class="hidden">Preparing a preview of this clip…</div></div>
    <div id="trBar"><div class="frames"></div><img class="wave hidden" alt=""><div class="shade l"></div><div class="shade r"></div><div class="win"><div class="h l" title="Drag to set the start"></div><div class="h r" title="Drag to set the end"></div></div><div class="ph"></div></div>
    <div id="trUsed"></div>
    <div class="trctl">
      <button class="playbtn" id="trPlay" title="Play / pause (space)"><svg viewBox="0 0 16 16" width="14" height="14"><path id="trPlayIcon" d="${PLAY_D}" fill="currentColor"/></svg></button>
      <span class="tc" id="trTime"></span>
      <button class="link" id="trIn" title="Start the part at the playhead (I)">Mark in <kbd>I</kbd></button>
      <button class="link" id="trOut" title="End the part at the playhead (O)">Mark out <kbd>O</kbd></button>
      <span id="trSel"></span>
      <span class="spacer"></span>
      ${edit ? '' : `<select id="trWhere" title="Where the part goes on the timeline"><option value="end" ${where === 'end' ? 'selected' : ''}>Add at the end</option><option value="playhead" ${where === 'playhead' ? 'selected' : ''}>Insert at the playhead</option></select>`}
    </div>
    <div class="foot">
      ${edit ? `<span class="muted trhint">Drag the yellow handles, or play and press I / O.</span><span class="spacer"></span><button class="pill" id="trCancel">Cancel</button><button class="pill primary" id="trApply">Update clip <kbd>⏎</kbd></button>`
             : `<span class="muted trhint" id="trHint"></span><span class="spacer"></span><button class="pill ghost" id="trSkip" title="Leave this clip in the library (N)">Skip <kbd>N</kbd></button><button class="pill" id="trMore" title="Add this part and keep picking parts of the same clip (⇧⏎)">Add & pick more <kbd>⇧⏎</kbd></button><button class="pill primary" id="trAdd">Add <kbd>⏎</kbd></button>`}
    </div>
  </div>`, { xl: true });
  $('#trClose').onclick = closeTrimmer;
  $('#trPlay').onclick = () => { const v = $('#trVideo'); v && !v.paused ? trPause() : trPlay(); };
  $('#trIn').onclick = () => trMark('in'); $('#trOut').onclick = () => trMark('out');
  if (edit) { $('#trApply').onclick = trApply; $('#trCancel').onclick = closeTrimmer; }
  else {
    $('#trAdd').onclick = () => trAdd(false); $('#trMore').onclick = () => trAdd(true); $('#trSkip').onclick = trNext;
    $('#trWhere').onchange = e => { lsSet('kv.trWhere', e.target.value); e.target.blur(); };
  }
  $('#trVideo').onclick = () => { const v = $('#trVideo'); v.paused ? trPlay() : trPause(); };
  dragOn($('#trBar'), {
    down: e => { if (!TR.dur) return false; trPause(); const h = e.target.closest('.h'); if (h) return { h: h.classList.contains('l') ? 'in' : 'out' }; trSeek(trBarT(e)); return {}; },
    move: (ev, c) => {
      const t = trBarT(ev);
      if (c.h === 'in') { TR.in = clamp(t, 0, TR.out - 0.1); trSeek(TR.in); }
      else if (c.h === 'out') { TR.out = clamp(t, TR.in + 0.1, TR.dur); trSeek(TR.out); }
      else trSeek(t);
    },
  });
  trLoad();
}
function trBarT(ev) { const r = $('#trBar').getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * TR.dur; }
function trSource(src) {
  const s = TR.segId ? P.timeline.find(x => x.id === TR.segId) : null;
  const c = (P.clips || []).find(x => x.src === src);
  return { seg: s, media: (s && s.media) || (c && c.media) || null, url: (s && s.proxy_url) || (c && c.proxy_url) || null };
}
async function trLoad() {
  clearTimeout(TR.poll); cancelAnimationFrame(TR.raf);
  const box = $('#trimBox'); if (!box) return;
  const src = TR.queue[TR.i]; TR.src = src;
  $('#trName').textContent = src.replace(/^clips\//, '');
  $('#trCount').textContent = TR.queue.length > 1 ? `${TR.i + 1} of ${TR.queue.length}` : '';
  const { seg, media, url } = trSource(src), v = $('#trVideo');
  if (!url || !media) {      // the browser-friendly proxy is still being made: check back shortly
    TR.dur = 0; $('#trWait').classList.remove('hidden'); v.removeAttribute('src'); v.dataset.url = ''; trRender();
    TR.poll = setTimeout(async () => { try { await refresh(); } catch { } trLoad(); }, 1500);
    return;
  }
  $('#trWait').classList.add('hidden');
  TR.dur = media.duration || 0;
  if (seg) { TR.in = seg.in || 0; TR.out = seg.out == null ? TR.dur : Math.min(seg.out, TR.dur); } else { TR.in = 0; TR.out = TR.dur; }
  if (v.dataset.url !== url) { v.dataset.url = url; v.src = url; }
  const toStart = () => { try { v.currentTime = TR.in; } catch { } trRender(); };
  if (v.readyState >= 1) toStart(); else v.onloadedmetadata = toStart;
  v.ontimeupdate = () => { if (v.paused) trRender(); };
  // filmstrip + waveform of the whole source
  const bar = $('#trBar'), bw = bar.clientWidth || 800;
  const ar = media.width && media.height ? media.width / media.height : 16 / 9;
  const q = `src=${encodeURIComponent(src)}&start=0&end=${TR.dur}`;
  $('.frames', bar).style.backgroundImage = `url("/api/projects/${P.name}/strip?v=2&${q}&n=${clamp(Math.round(bw / (58 * ar)), 4, 40)}&h=58")`;
  const wv = $('.wave', bar);
  if (media.has_audio) { wv.src = `/api/projects/${P.name}/wave?${q}&w=${Math.ceil(bw / 50) * 50}&h=22&color=ffffff`; wv.classList.remove('hidden'); } else wv.classList.add('hidden');
  trLoadUsed();
  trRender();
}
function trRender() {
  const bar = $('#trBar'); if (!bar) return;
  const v = $('#trVideo'), d = TR.dur || 1, t = v ? v.currentTime || 0 : 0, pct = x => `${clamp(x / d, 0, 1) * 100}%`;
  $('.shade.l', bar).style.width = pct(TR.in);
  $('.shade.r', bar).style.width = `${(1 - clamp(TR.out / d, 0, 1)) * 100}%`;
  const win = $('.win', bar); win.style.left = pct(TR.in); win.style.width = `${clamp((TR.out - TR.in) / d, 0, 1) * 100}%`;
  $('.ph', bar).style.left = pct(t);
  $('#trTime').textContent = TR.dur ? `${fmt(t)} / ${fmt(TR.dur)}` : '';
  const whole = TR.in <= 0.01 && TR.out >= TR.dur - 0.01;
  $('#trSel').innerHTML = !TR.dur ? '' : whole ? `<span class="muted">whole clip · ${fmt(TR.dur)}</span>` : `<b>${fmt(TR.out - TR.in)}</b> <span class="muted">· ${fmt(TR.in)} → ${fmt(TR.out)}</span>`;
  const hint = $('#trHint');
  if (hint) hint.textContent = TR.added ? `${TR.added} part${TR.added > 1 ? 's' : ''} added` : TR.queue.length > 1 ? 'Skipped clips stay in + Add ▸ In this project' : '';
}
function trSeek(t) { const v = $('#trVideo'); if (!v || !TR.dur) return; try { v.currentTime = clamp(t, 0, TR.dur); } catch { } trRender(); }
function trPlay() {
  const v = $('#trVideo'); if (!v || !TR.dur) return;
  let t = v.currentTime || 0;
  if (Math.abs(t - TR.out) < 0.08 || t >= TR.dur - 0.05) { t = TR.in; v.currentTime = t; }   // at the end of the part: replay it
  TR.stopAt = (t >= TR.in - 0.05 && t < TR.out) ? TR.out : TR.dur;                         // inside the part: stop at its end
  v.play().catch(() => { }); $('#trPlayIcon').setAttribute('d', PAUSE_D);
  const tick = () => { if (!$('#trimBox') || v.paused) return; if (v.currentTime >= TR.stopAt) { v.pause(); v.currentTime = TR.stopAt; trPause(); return; } trRender(); TR.raf = requestAnimationFrame(tick); };
  cancelAnimationFrame(TR.raf); TR.raf = requestAnimationFrame(tick);
}
function trPause() { const v = $('#trVideo'); if (v) v.pause(); cancelAnimationFrame(TR.raf); const ic = $('#trPlayIcon'); if (ic) ic.setAttribute('d', PLAY_D); trRender(); }
function trMark(which) {
  const v = $('#trVideo'); if (!v || !TR.dur) return; const t = clamp(v.currentTime || 0, 0, TR.dur);
  if (which === 'in') { TR.in = Math.min(t, TR.dur - 0.1); if (TR.out <= TR.in + 0.1) TR.out = TR.dur; }
  else { TR.out = Math.max(t, 0.1); if (TR.in >= TR.out - 0.1) TR.in = 0; }
  trRender();
}
async function trAdd(more = false) {
  if (!TR.src || !TR.dur) return;
  const where = $('#trWhere') ? $('#trWhere').value : 'end';
  const body = { kind: 'clip', src: TR.src };
  if (TR.in > 0.01) body.in = +TR.in.toFixed(3);
  if (TR.out < TR.dur - 0.01) body.out = +TR.out.toFixed(3);
  if (where === 'playhead') body.at_time = T;
  trPause();
  await guard(async () => {
    const p = await api('POST', `/api/projects/${P.name}/segments`, body);
    setProject(p); TR.added++;
    const ns = p.new_id && p.timeline.find(x => x.id === p.new_id);
    if (where === 'playhead' && ns && ns.placed) { T = ns.placed.end; updatePlayhead(); }   // the next part lands after this one
    toast(`Added ${fmt(TR.out - TR.in)} to the timeline`);
    if (more) { const from = TR.out >= TR.dur - 0.1 ? 0 : TR.out; TR.in = from; TR.out = TR.dur; trSeek(from); trLoadUsed(); }
    else trNext();
  });
}
function trLoadUsed() {    // parts of this clip that are already on the timeline, in green under the strip
  if (!$('#trUsed') || !TR.dur) return;
  const mk = [...new Set(P.timeline.filter(x => x.kind === 'clip' && x.clip === TR.src).flatMap(x => x.markers || []))];
  $$('#trBar .trmk').forEach(x => x.remove());
  for (const m of mk) { const i = document.createElement('i'); i.className = 'trmk'; i.style.left = `${clamp(m / TR.dur, 0, 1) * 100}%`; i.title = `marker at ${fmt(m)}`; $('#trBar').appendChild(i); }
  $('#trUsed').innerHTML = P.timeline.filter(x => x.kind === 'clip' && x.clip === TR.src && x.id !== TR.segId).map(x => { const a = x.in || 0, b = x.out == null ? TR.dur : x.out; return `<i style="left:${a / TR.dur * 100}%;width:${Math.max(0.3, (b - a) / TR.dur * 100)}%" title="already on the timeline: ${fmt(a)} → ${fmt(b)}"></i>`; }).join('');
}
function trNext() {
  if (TR.i + 1 < TR.queue.length) { TR.i++; trPause(); trLoad(); return; }
  const n = TR.added, many = TR.queue.length > 1; closeTrimmer();
  if (many) toast(n ? `Done: ${n} part${n > 1 ? 's' : ''} added` : 'Done');
}
async function trApply() {
  const s = P.timeline.find(x => x.id === TR.segId); if (!s || !TR.dur) return closeTrimmer();
  const body = { in: +TR.in.toFixed(3), out: TR.out >= TR.dur - 0.01 ? '' : +TR.out.toFixed(3) };
  await guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/segments/${s.id}`, body)); closeTrimmer(); const ns = P.timeline.find(x => x.id === s.id); if (ns && ns.placed) seek(ns.placed.start, true); toast('Clip updated'); });
}
function closeTrimmer() {
  clearTimeout(TR.poll); cancelAnimationFrame(TR.raf);
  const v = $('#trVideo'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  closeSheet();
}
function trimKey(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, v = $('#trVideo');
  if (k === 'Escape') { e.preventDefault(); closeTrimmer(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (k) {
    case ' ': e.preventDefault(); v && !v.paused ? trPause() : trPlay(); break;
    case 'i': trMark('in'); break;
    case 'o': trMark('out'); break;
    case 'Enter': e.preventDefault(); TR.segId ? trApply() : trAdd(e.shiftKey); break;
    case 'n': if (!TR.segId) trNext(); break;
    case 'ArrowLeft': e.preventDefault(); trPause(); trSeek((v.currentTime || 0) - (e.shiftKey ? 1 : 1 / 30)); break;
    case 'ArrowRight': e.preventDefault(); trPause(); trSeek((v.currentTime || 0) + (e.shiftKey ? 1 : 1 / 30)); break;
    case 'Home': trPause(); trSeek(TR.in); break;
    case 'End': trPause(); trSeek(TR.out); break;
  }
}

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
      ${field('Masthead image (shown before the opening card)', `<div class="inline"><input id="s_mast" type="text" value="${esc(s.masthead_image)}" placeholder="optional path to an image"><button class="link" id="s_mastPick">Choose…</button></div>`)}
      <div class="inline">${field('Opening card kicker', `<input id="s_kick" type="text" value="${esc(s.default_title_kicker)}" placeholder="e.g. Daily Vlogs">`)}${field('Masthead (s)', `<input id="s_ms" type="number" step="0.5" min="0.5" value="${s.intro_masthead_seconds}">`)}${field('Date card (s)', `<input id="s_ts" type="number" step="0.5" min="0.5" value="${s.intro_title_seconds}">`)}${field('Black hold (s)', `<input id="s_hold" type="number" step="0.5" min="0" value="${s.intro_black_hold}">`)}</div>
      ${field('Intro music sting (plays over masthead + date card)', `<div class="inline"><input id="s_sting" type="text" value="${esc(s.intro_sting)}" placeholder="optional path to a song"><button class="link" id="s_stingPick">Choose…</button></div>`)}
      <div class="inline">${field('Start in the song', `<input id="s_stingStart" type="text" value="${fmt(s.intro_sting_start || 0, 2)}">`)}${field('Sting volume', `<input id="s_stingVol" type="number" step="0.05" min="0" max="1.5" value="${s.intro_sting_volume}">`)}</div>
      ${field('Opening card subtitle', `<input id="s_sub" type="text" value="${esc(s.default_title_subtitle)}" placeholder="e.g. a daily vlog">`)}
      ${field('Default music', `<input id="s_music" type="text" value="${esc(s.default_music)}" placeholder="optional path">`)}
      <div class="inline">${field('Default orientation', `<select id="s_or">${opt(['auto', 'portrait', 'landscape', 'square'], s.default_orientation)}</select>`)}${field('Default transition', `<select id="s_tr">${opt(['cut', 'fade', 'dip'], s.default_transition)}</select>`)}</div>
      <p class="muted">${esc(s.config_file)}</p>
    </div>
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Save</button></div>`);
  $$('.tabs .tab').forEach(b => b.onclick = () => { $$('.tabs .tab').forEach(x => x.classList.toggle('active', x === b)); $('#setVlog').classList.toggle('hidden', b.dataset.t !== 'vlog'); $('#setApp').classList.toggle('hidden', b.dataset.t !== 'app'); });
  $('#s_mastPick').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'image' }); if (r.paths[0]) $('#s_mast').value = r.paths[0]; });
  $('#s_stingPick').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'music' }); if (r.paths[0]) $('#s_sting').value = r.paths[0]; });
  if (P) { $('#openFolder').onclick = () => api('POST', '/api/open', { path: P.folder }); $('#delProj').onclick = () => { if (!confirm(`Move “${P.name}” to the Trash?`)) return; guard(async () => { await api('DELETE', `/api/projects/${P.name}`); closeSheet(); localStorage.removeItem('kv.project'); P = null; await loadProjects(); }); }; }
  $('#s_ok').onclick = () => guard(async () => {
    await api('PUT', '/api/settings', { immich_url: $('#s_url').value, immich_api_key: $('#s_key').value, vlogs_dir: $('#s_dir').value, default_title_subtitle: $('#s_sub').value, default_title_kicker: $('#s_kick').value, masthead_image: $('#s_mast').value, intro_black_hold: +$('#s_hold').value || 0, intro_masthead_seconds: +$('#s_ms').value || 2.5, intro_title_seconds: +$('#s_ts').value || 2, intro_sting: $('#s_sting').value, intro_sting_start: parseTime($('#s_stingStart').value), intro_sting_volume: +$('#s_stingVol').value || 0, default_music: $('#s_music').value, default_orientation: $('#s_or').value, default_transition: $('#s_tr').value });
    if (P) await api('PATCH', `/api/projects/${P.name}`, { title: $('#v_title').value, output: { orientation: $('#v_or').value, fps: +$('#v_fps').value }, style: { transition: $('#v_tr').value, transition_duration: +$('#v_trd').value, fade_in: +$('#v_fi').value, fade_out: +$('#v_fo').value, title_bg: $('#v_bg').value, title_fg: $('#v_fg').value, title_accent: $('#v_ac').value, font: $('#v_font').value }, audio: { normalize: $('#v_norm').checked, match_levels: $('#v_match').checked } });
    closeSheet(); await loadProjects(P && P.name); toast('Saved');
  });
}
$('#projBtn').onclick = async e => {
  const anchor = e.currentTarget;   // currentTarget is null once the await has yielded
  const list = await api('GET', '/api/projects');
  popover(anchor, [...list.slice(0, 12).map(p => ({ label: `${p.name}${p.title && p.title !== p.name ? ' · ' + p.title : ''}`, k: p.rendered ? 'exported' : `${p.segments} seg`, sel: P && p.name === P.name, fn: () => openProject(p.name) })), '-', { label: 'New vlog…', k: '⌘N', fn: newProjectSheet }]);
};
$('#welcomeNew').onclick = newProjectSheet;
async function newProjectSheet() {
  const today = new Date().toISOString().slice(0, 10);
  const imm = await api('GET', '/api/immich/status').catch(() => ({ ok: false }));
  sheet(`<h2>New vlog</h2>${field('Date / folder', `<input id="m_n" type="text" value="${today}">`)}${field('Title', `<input id="m_t" type="text" placeholder="${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}">`)}
    <div class="check"><input type="checkbox" id="m_o" checked><label for="m_o">Start with the intro (masthead → black → date card)</label></div>
    <div class="check"><input type="checkbox" id="m_i" ${imm.ok ? 'checked' : 'disabled'}><label for="m_i">Add that day's clips from Immich${imm.ok ? '' : ' <span class="muted">(not connected)</span>'}</label></div>
    <div class="foot"><button class="pill" data-close>Cancel</button><button class="pill primary" id="s_ok">Create</button></div>`);
  $('#s_ok').onclick = () => guard(async () => {
    const trim = trimOnImport();
    const r = await api('POST', '/api/projects', { name: $('#m_n').value, title: $('#m_t').value || null, opening: $('#m_o').checked, pull_immich: $('#m_i').checked, trim });
    closeSheet(); await loadProjects(r.project.name);
    if (r.job) watchJob(r.job, async done => { await refresh(); if (trim && done.added && done.added.length) openTrimmer(done.added); else toast('Clips added'); });
    else if ($('#m_i') && $('#m_i').checked) toast('No videos on that day in Immich');
  });
}
$('#helpBtn').onclick = showHelp;
function showHelp() {
  const rows = [['space', 'play / pause'], ['I / O', 'mark in / out at the playhead'], ['X', 'mark the whole clip under the playhead'], ['⌫', 'cut out the marked part (no marks: delete the selected segment)'], ['K', 'keep only the marked part of the clip(s)'], ['S', 'split at the playhead (also C, ⌘K)'], ['Q / W', 'trim the clip\'s start / end to the playhead'], ['T', 'cut to a title card here'], ['← →', 'step one frame (⇧ for a second)'], ['↑ ↓', 'select previous / next segment'], ['[ ]', 'move the selected segment'], ['R', 'record (Space during a recording drops a marker)'], ['M', 'add / remove a marker at the playhead'], [', .', 'jump to the previous / next marker'], ['⌘V', 'paste a picture over the video at the playhead'], ['⌘Z / ⇧⌘Z', 'undo / redo'], ['⌘+ ⌘− ⌘0', 'zoom the timeline / fit'], ['esc', 'clear the marks / deselect / close'], ['F', 'fullscreen player'], ['⌘⏎', 'render preview'], ['⇧⌘⏎', 'export'], ['⌘N', 'new vlog']];
  sheet(`<h2>Keyboard</h2><div class="kbd-grid">${rows.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div><p class="muted" style="margin-top:14px">Drag the red playhead (or anywhere on the ruler) to scrub; shift-drag the ruler to mark a range and drag its edges to adjust it. Double-click a clip to re-trim it against the whole source. Pictures over the video sit on the pink lane above the clips: drag them to move, drag their ends to change how long they show, and drag them on the video to place them (corners resize). Drag the blue handles on a selected clip to trim, drag blocks to reorder. <b>Log / Linear</b> switches how wide clips are drawn; ⌘-scroll zooms.</p><div class="foot"><button class="pill" data-close>Close</button></div>`);
}

// ================================================================== recorder (streams chunks to disk as it goes)
const REC = { stream: null, screen: null, recorder: null, recorder2: null, mode: 'clip', ctx: null, raf: 0, start: 0, playFrom: 0, timer: 0, session: null, seq: 0, seq2: 0, queue: Promise.resolve(), queue2: Promise.resolve(), bytes: 0, failed: 0, chunks: [], known: null, pending: 0, t0: {} };
// Screen takes: what is big and what sits in the box. The layout is only the starting point: it can
// be changed on the clip afterwards (inspector ▸ Picture in picture, or drag the inset on the video).
const REC_LAYOUTS = { 'screen-corner': { main: 'screen', pip: 'cam', layout: 'corner' }, 'cam-corner': { main: 'cam', pip: 'screen', layout: 'corner-large' }, 'stacked': { main: 'screen', pip: 'cam', layout: 'stacked' }, 'screen-only': { main: 'screen', pip: null, layout: null } };
const recRoles = () => REC_LAYOUTS[lsGet('kv.recLayout', 'screen-corner')] || REC_LAYOUTS['screen-corner'];
const recIsScreen = () => REC.mode === 'screen';
const isRecording = () => !!(REC.recorder && REC.recorder.state === 'recording');
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
    <div class="inline" style="margin-bottom:12px"><h2 style="margin:0">Record</h2><span class="spacer"></span><div class="tabs" style="margin:0"><button class="tab ${mode === 'clip' ? 'active' : ''}" data-rm="clip">Camera clip</button><button class="tab ${mode === 'screen' ? 'active' : ''}" data-rm="screen">Screen</button><button class="tab ${mode === 'voiceover' ? 'active' : ''}" data-rm="voiceover">Voiceover</button></div></div>
    <video id="recPreview" autoplay muted playsinline class="${portrait ? 'portrait' : ''}"></video>
    <div id="recStage" class="recstage hidden" style="aspect-ratio:${canvasWH()[0]}/${canvasWH()[1]};width:min(100%, calc(42vh * ${(canvasWH()[0] / canvasWH()[1]).toFixed(4)}))"><video id="recMain" autoplay muted playsinline></video><div id="recPipBox" class="pipbox hidden"><video id="recPip" autoplay muted playsinline></video></div><div id="recShareHint" class="sharehint">Choose a screen or window to share.<br><small>Share a window (not the whole screen) if this app would otherwise be in the recording.</small></div></div>
    <div class="meter"><div class="lvl" id="recLvl"></div></div>
    <div id="micWarn" class="micwarn hidden"></div>
    <div id="recScreenOpts" class="hidden">
      ${field('Screen', '<div class="inline"><button class="pill" id="recShare">Choose screen or window…</button><span id="recShareLbl" class="muted"></span></div>')}
      <div class="inline" style="align-items:flex-start;gap:18px">
        ${field('Layout', `<div class="seg" id="recLayout">${[['screen-corner', 'Screen · me in a corner'], ['cam-corner', 'Me · screen in a corner'], ['stacked', portrait ? 'Stacked: me on top' : 'Side by side'], ['screen-only', 'Screen only']].map(([k, l]) => `<button data-k="${k}" class="${lsGet('kv.recLayout', 'screen-corner') === k ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
        ${field('Corner', `<div class="grid9" id="recPos">${POS9.map(p => `<button data-p="${p}" class="${lsGet('kv.recPos', 'br') === p ? 'on' : ''}"></button>`).join('')}</div>`)}
        ${field('Sound', '<label class="check" style="margin:4px 0 0"><input type="checkbox" id="recSys"> include computer sound</label>')}
      </div>
    </div>
    <div class="recgrid">
      ${field('Camera', '<select id="recCam"></select>')}${field('Microphone', '<select id="recMic"></select>')}
      ${field('Quality', '<select id="recQ"><option value="1080">1080p</option><option value="720">720p</option><option value="2160">4K (if supported)</option></select>')}
      ${field('Options', `<div class="inline"><label class="check" style="margin:0"><input type="checkbox" id="recMirror" checked> mirror</label><label class="check" style="margin:0"><input type="checkbox" id="recCover" ${portrait ? 'checked' : ''}> crop to fill</label></div>`)}
    </div>
    <p id="recVoHint" class="muted hidden">The preview plays from <b id="recVoAt">${fmt(T)}</b> while you talk. Wear headphones. Clip audio is ducked under your voice.</p>
    <p class="muted rechint">While recording, press <b>Space</b> wherever you'll want to show pictures: it leaves a ◆ marker on the clip to come back to.</p>
    <div class="recctl"><button class="recbtn" id="recGo"><i></i></button><span id="recTime">0:00.0</span><button class="pill sm" id="recMark" disabled title="Drop a marker where you'll want to show pictures (Space)">◆ Marker <kbd>space</kbd></button><span id="recMarks"></span><span id="recMicBadge" class="hidden">⚠ not a good mic</span><span id="recStatus" class="muted"></span><span class="spacer"></span><button class="pill" id="recClose">Close</button></div>
  </div>`, { wide: true });
  $('#recClose').onclick = closeRecorder;
  $$('[data-rm]').forEach(b => b.onclick = () => { if (isRecording()) return; $$('[data-rm]').forEach(x => x.classList.toggle('active', x === b)); REC.mode = b.dataset.rm; if (!recIsScreen()) stopScreen(); applyRecMode(); startPreview(); });
  $('#recShare').onclick = () => chooseScreen();
  $$('#recLayout button').forEach(b => b.onclick = () => { if (isRecording()) return; lsSet('kv.recLayout', b.dataset.k); $$('#recLayout button').forEach(x => x.classList.toggle('on', x === b)); startPreview(); });
  $$('#recPos button').forEach(b => b.onclick = () => { if (isRecording()) return; lsSet('kv.recPos', b.dataset.p); $$('#recPos button').forEach(x => x.classList.toggle('on', x === b)); applyRecLayout(); });
  $('#recMirror').addEventListener('change', applyRecLayout);
  $('#recQ').onchange = startPreview; $('#recMirror').onchange = e => $('#recPreview').classList.toggle('nomirror', !e.target.checked);
  $('#recGo').onclick = () => { $('#recGo').blur(); REC.recorder && REC.recorder.state === 'recording' ? stopRecording() : startRecording(); };
  $('#recMark').onclick = () => { $('#recMark').blur(); recMarker(); };
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    tmp.getTracks().forEach(t => t.stop());
    REC.known = null;
    await refreshDevices();
  } catch (e) { toast('Camera/microphone permission denied: ' + e.message, true); }
  applyRecMode(); startPreview();
}
// Device lists refresh whenever something is plugged in or unplugged while the sheet is open. A newly
// connected mic (e.g. the DJI receiver) is switched to automatically, and a good mic is preferred
// over webcam / computer mics whenever one is connected.
const GOOD_MIC = /\bdji\b|wireless mic|mic mini|\bmic 2\b|\brx\b|\br[øo]de\b|yeti|snowball|shure|\bsm7|\bmv7|audio-?technica|\bat20\d\d|elgato wave|\bwave[: ]?[13]\b|wave link|focusrite|scarlett|clarett|\bmotu\b|apollo|universal audio|\bvolt \d|audient|\bevo \d|presonus|behringer|\bumc\d|tascam|\bzoom [hfp]\d|sennheiser|hollyland|\blark\b|saramonic|\bboya\b|samson|fifine|maono|quadcast|seiren|\bssl ?\d|steinberg|\bur\d\d|apogee|\brme\b|babyface|minifuse|\bm-?audio\b|komplete audio|audio interface/i;
const BAD_MIC = /webcam|cam\b|camera|\bc9\d\d\b|brio|logitech|anker|powerconf|facetime|built-?in|internal|macbook|imac|mac ?mini|mac studio|studio display|display audio|ultrafine|airpods|beats|iphone|ipad|continuity|zoom ?audio|teams|virtual|blackhole|loopback|soundflower|krisp|aggregate|default/i;
const trustedMics = () => { try { return JSON.parse(lsGet('kv.goodMics', '[]')); } catch { return []; } };
function micQuality(label) {
  label = (label || '').trim();
  if (!label) return 'none';
  if (trustedMics().includes(label)) return 'good';
  if (GOOD_MIC.test(label)) return 'good';
  return BAD_MIC.test(label) ? 'bad' : 'unknown';
}
function trustMic(label) { const l = trustedMics(); if (!l.includes(label)) l.push(label); lsSet('kv.goodMics', JSON.stringify(l)); }
function selectedMicLabel() {
  const tr = REC.stream && REC.stream.getAudioTracks()[0];
  if (tr && tr.label) return tr.label;
  const o = $('#recMic') && $('#recMic').selectedOptions[0];
  return o && o.value ? o.textContent.replace(/ ✓$/, '') : '';
}
function updateMicWarn() {
  const el = $('#micWarn'); if (!el) return;
  const label = selectedMicLabel(), q = micQuality(label);
  if (q === 'good') { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden'); el.classList.toggle('soft', q === 'unknown');
  el.innerHTML = q === 'none' ? '<b>⚠ No microphone found.</b> Plug in your DJI Mic Mini, Yeti or audio interface.'
    : q === 'bad' ? `<b>⚠ Not using a good mic.</b> “${esc(label)}” is a webcam or computer mic. Plug in your DJI Mic Mini, Yeti or audio interface. <button class="link muted" id="micTrust">It's fine, stop warning</button>`
    : `<b>⚠ Is this a good mic?</b> “${esc(label)}” isn't one I recognize. <button class="link" id="micTrust">Yes, it's a good mic</button>`;
  const b = $('#micTrust'); if (b) b.onclick = () => { trustMic(label); updateMicWarn(); };
}
function flashWarn(title, detail) {
  let el = $('#micFlash'); if (!el) { el = document.createElement('div'); el.id = 'micFlash'; document.body.appendChild(el); }
  el.innerHTML = `${esc(title)}${detail ? `<small>${esc(detail)}</small>` : ''}`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 4500);
}
async function refreshDevices() {
  if (!$('#recBox')) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const first = REC.known === null, known = REC.known || new Set();
  let switched = null;
  const fill = (sel, kind, key) => {
    const list = devs.filter(d => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const cur = sel.value, saved = lsGet(key, '');
    sel.innerHTML = list.map(d => `<option value="${d.deviceId}">${esc(d.label || kind)}${kind === 'audioinput' && micQuality(d.label) === 'good' ? ' ✓' : ''}</option>`).join('') || '<option value="">none</option>';
    const fresh = first ? null : list.find(d => !known.has(d.deviceId) && (kind !== 'audioinput' || micQuality(d.label) !== 'bad'));
    let pick = null;
    if (fresh) { pick = fresh; switched = fresh.label || kind; }
    else if (!first && list.some(d => d.deviceId === cur)) pick = list.find(d => d.deviceId === cur);
    else if (kind === 'audioinput') { const good = list.filter(d => micQuality(d.label) === 'good'); pick = good.find(d => d.deviceId === saved) || good[0] || list.find(d => d.deviceId === saved) || list.find(d => micQuality(d.label) !== 'bad') || list[0]; }
    else pick = list.find(d => d.deviceId === saved) || list[0];
    if (pick) sel.value = pick.deviceId;
    sel.onchange = () => { lsSet(key, sel.value); startPreview(); };
  };
  const camBefore = $('#recCam').value, micBefore = $('#recMic').value;
  fill($('#recCam'), 'videoinput', 'kv.cam'); fill($('#recMic'), 'audioinput', 'kv.mic');
  REC.known = new Set(devs.map(d => d.deviceId));
  if (!first && ($('#recCam').value !== camBefore || $('#recMic').value !== micBefore)) {
    if (switched) toast(`Using ${switched}`);
    if (!(REC.recorder && REC.recorder.state === 'recording')) startPreview();
  }
  updateMicWarn();
}
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().catch(() => { }));
function applyRecMode() {
  const vo = REC.mode === 'voiceover', sc = recIsScreen();
  $('#recPreview').classList.toggle('hidden', vo || sc); $('#recStage').classList.toggle('hidden', !sc); $('#recScreenOpts').classList.toggle('hidden', !sc);
  $('#recCam').closest('.field').classList.toggle('hidden', vo); $('#recQ').closest('.field').classList.toggle('hidden', vo); $('#recCover').closest('label').classList.toggle('hidden', sc);
  $('#recVoHint').classList.toggle('hidden', !vo); $('#recVoAt').textContent = fmt(T);
  if (sc) applyRecLayout();
}
// ---- screen takes: the shared screen/window and the camera, previewed in the chosen layout
async function chooseScreen() {
  if (isRecording()) return;
  stopScreen();
  try {
    REC.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1200 } }, audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include' });
  } catch (e) { if (e.name !== 'NotAllowedError') toast('Could not share the screen: ' + e.message, true); applyRecLayout(); return; }
  const vt = REC.screen.getVideoTracks()[0];
  vt.onended = () => {           // "Stop sharing" in the browser's bar
    if (isRecording() && recIsScreen()) { flashWarn('Screen sharing stopped', 'Recording stopped; the take so far is saved'); stopRecording(); }
    REC.screen = null; applyRecLayout();
  };
  applyRecLayout();
}
function stopScreen() { if (REC.screen) { REC.screen.getTracks().forEach(t => t.stop()); REC.screen = null; } }
function screenLabel() {
  const vt = REC.screen && REC.screen.getVideoTracks()[0]; if (!vt) return '';
  const st = vt.getSettings(), kind = { monitor: 'Screen', window: 'Window', browser: 'Tab' }[st.displaySurface] || 'Screen';
  return `${kind} · ${st.width}×${st.height}${REC.screen.getAudioTracks().length ? ' · sound available' : ''}`;
}
function recSources() {        // the live tracks for the main picture and the inset in the chosen layout
  const r = recRoles(), cam = REC.stream && REC.stream.getVideoTracks()[0], scr = REC.screen && REC.screen.getVideoTracks()[0];
  const pick = role => role === 'cam' ? cam : role === 'screen' ? scr : null;
  return { roles: r, main: pick(r.main), pip: pick(r.pip), mainIsCam: r.main === 'cam', pipIsCam: r.pip === 'cam' };
}
const trackAspect = (tr, dflt = 9 / 16) => { const s = tr && tr.getSettings(); return s && s.width && s.height ? s.height / s.width : dflt; };
function recLayoutBoxes() {    // -> { box, pip, shape } for the current layout, canvas and inset aspect (null pip = no inset)
  const src = recSources(); if (!src.roles.pip) return { box: null, pip: null, shape: 'round', aspect: 9 / 16 };
  const [W, H] = canvasWH(), aspect = trackAspect(src.pip, src.pipIsCam ? 9 / 16 : 10 / 16);
  return { ...pipLayoutBoxes(src.roles.layout, lsGet('kv.recPos', 'br'), W, H, aspect), aspect };
}
function applyRecLayout() {
  if (!$('#recStage') || !recIsScreen()) return;
  const src = recSources(), L = recLayoutBoxes(), [W, H] = canvasWH(), mirror = $('#recMirror').checked;
  const main = $('#recMain'), pipBox = $('#recPipBox'), pipV = $('#recPip');
  const lbl = $('#recShareLbl'); if (lbl) lbl.textContent = screenLabel();
  const mainStream = src.main ? new MediaStream([src.main]) : null;
  if ((main.srcObject && main.srcObject.getVideoTracks()[0]) !== src.main) main.srcObject = mainStream;
  main.style.objectFit = src.mainIsCam ? 'cover' : 'contain';
  mainBoxStyle(main, L.box, mirror && src.mainIsCam, W, H);
  $('#recShareHint').classList.toggle('hidden', !!REC.screen);
  $('#recPos').closest('.field').classList.toggle('hidden', !(src.roles.layout || '').startsWith('corner'));
  $('#recSys').closest('.field').classList.toggle('hidden', !(REC.screen && REC.screen.getAudioTracks().length));
  if (src.pip && L.pip) {
    if ((pipV.srcObject && pipV.srcObject.getVideoTracks()[0]) !== src.pip) pipV.srcObject = new MediaStream([src.pip]);
    pipBox.className = `pipbox ${L.shape}`; pipBox.classList.remove('hidden');
    const cr = $('#recStage').getBoundingClientRect();
    pipBox.style.borderRadius = L.shape === 'rect' ? '0' : `${Math.round(Math.min(cr.width || 300, cr.height || 300) * 0.02)}px`;
    boxStyle(pipBox, L.pip, W, H, L.aspect, L.shape);
    pipV.style.transform = mirror && src.pipIsCam ? 'scaleX(-1)' : '';
  } else { pipBox.classList.add('hidden'); pipV.srcObject = null; }
}
function recAudioTrack() {     // the microphone, mixed with the computer's sound when asked for
  const mic = REC.stream && REC.stream.getAudioTracks()[0];
  const sys = recIsScreen() && REC.screen && $('#recSys') && $('#recSys').checked ? REC.screen.getAudioTracks()[0] : null;
  if (!sys) return mic || null;
  try {
    REC.ctx = REC.ctx || new AudioContext(); REC.ctx.resume && REC.ctx.resume();
    const dest = REC.ctx.createMediaStreamDestination();
    if (mic) REC.ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
    REC.ctx.createMediaStreamSource(new MediaStream([sys])).connect(dest);
    return dest.stream.getAudioTracks()[0];
  } catch (e) { console.warn('audio mix failed', e); return mic || null; }
}
async function startPreview() {
  stopStream(); const q = +$('#recQ').value;
  const needCam = REC.mode === 'clip' || (recIsScreen() && !!recRoles().pip);
  const constraints = { audio: { deviceId: $('#recMic').value ? { exact: $('#recMic').value } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    video: !needCam ? false : { deviceId: $('#recCam').value ? { exact: $('#recCam').value } : undefined, width: { ideal: q === 2160 ? 3840 : q === 720 ? 1280 : 1920 }, height: { ideal: q === 2160 ? 2160 : q }, frameRate: { ideal: 30 } } };
  try { REC.stream = await navigator.mediaDevices.getUserMedia(constraints); } catch (e) { $('#recStatus').textContent = 'cannot open device: ' + e.message; updateMicWarn(); return; }
  if (!$('#recPreview')) { stopStream(); return; }
  updateMicWarn();
  $('#recPreview').srcObject = REC.stream;
  if (recIsScreen()) applyRecLayout();
  const vt = REC.stream.getVideoTracks()[0];
  $('#recStatus').textContent = vt ? `${vt.getSettings().width}×${vt.getSettings().height}` : recIsScreen() ? '' : 'audio only';
  try {
    REC.ctx = REC.ctx || new AudioContext(); const src = REC.ctx.createMediaStreamSource(REC.stream); const an = REC.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an); const buf = new Float32Array(an.fftSize);
    const tickM = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; const db = 20 * Math.log10(Math.sqrt(s / buf.length) || 1e-6); const el = $('#recLvl'); if (el) el.style.width = `${clamp((db + 60) / 60 * 100, 0, 100)}%`; REC.raf = requestAnimationFrame(tickM); };
    cancelAnimationFrame(REC.raf); tickM();
  } catch { }
}
function stopStream() { cancelAnimationFrame(REC.raf); if (REC.stream) { REC.stream.getTracks().forEach(t => t.stop()); REC.stream = null; } }
function closeRecorder() { if (isRecording()) return toast('Stop the recording first'); stopStream(); stopScreen(); closeSheet(); }
window.addEventListener('beforeunload', e => { if (REC.recorder && REC.recorder.state === 'recording') { e.preventDefault(); e.returnValue = ''; } });
async function startRecording() {
  if (!REC.stream) return toast('No input device', true);
  const mime = pickMime(REC.mode === 'voiceover' ? 'voiceover' : 'clip');
  REC.playFrom = T;
  // what gets recorded: the camera/mic stream, or for a screen take the shared screen (+ the camera as a
  // second stream, the inset) with the mic (+ computer sound) on both so either can be the main picture later
  let mainStream = REC.stream, pipStream = null, body = { kind: REC.mode, at: REC.playFrom, fit: $('#recCover').checked ? 'cover' : 'contain', mime };
  if (recIsScreen()) {
    if (!REC.screen) return toast('Choose a screen or window first', true);
    const src = recSources(), L = recLayoutBoxes();
    if (!src.main) return toast(src.roles.main === 'cam' ? 'No camera' : 'No screen', true);
    const audio = recAudioTrack();
    mainStream = new MediaStream([src.main, ...(audio ? [audio] : [])]);
    if (src.pip) pipStream = new MediaStream([src.pip, ...(audio ? [audio.clone()] : [])]);
    const boxObj = b => b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null;
    body = { kind: 'clip', at: REC.playFrom, fit: src.mainIsCam ? 'cover' : 'contain', mime, name: src.roles.main, box: boxObj(L.box),
             pip: pipStream ? { name: src.roles.pip, mime, box: boxObj(L.pip), shape: L.shape, fit: 'cover' } : null };
  }
  try { const r = await api('POST', `/api/projects/${P.name}/record/start`, body); REC.session = r.id; }
  catch (e) { return toast('Could not start a recording session: ' + e.message, true); }
  REC.seq = REC.seq2 = 0; REC.bytes = 0; REC.failed = 0; REC.chunks = []; REC.queue = REC.queue2 = Promise.resolve(); REC.markers = []; REC.t0 = {};
  if ($('#recMark')) { $('#recMark').disabled = false; $('#recMarks').textContent = ''; }
  const opts = { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 };
  REC.recorder = new MediaRecorder(mainStream, opts);
  REC.recorder.ondataavailable = e => { if (!e.data.size) return; REC.chunks.push(e.data); const seq = REC.seq++; REC.queue = REC.queue.then(() => sendChunk(seq, e.data)); };
  REC.pending = pipStream ? 2 : 1;
  const oneStopped = () => { if (--REC.pending <= 0) finishRecording(); };
  REC.recorder.onstop = oneStopped;
  REC.recorder2 = null;
  if (pipStream) {
    REC.recorder2 = new MediaRecorder(pipStream, opts);
    REC.recorder2.ondataavailable = e => { if (!e.data.size) return; const seq = REC.seq2++; REC.queue2 = REC.queue2.then(() => sendChunk(seq, e.data, 0, 'pip')); };
    REC.recorder2.onstop = oneStopped;
    // the two streams start a few ms apart: tell the server so the inset plays in sync
    const sync = () => { if (REC.t0.main != null && REC.t0.pip != null) api('POST', `/api/projects/${P.name}/record/${REC.session}/sync`, { offset: -(REC.t0.pip - REC.t0.main) / 1000 }).catch(() => { }); };
    REC.recorder.onstart = () => { REC.t0.main = performance.now(); sync(); };
    REC.recorder2.onstart = () => { REC.t0.pip = performance.now(); sync(); };
  }
  REC.start = performance.now();
  if (REC.mode === 'voiceover') { seek(REC.playFrom, true); play(); }
  REC.recorder.start(500);
  if (REC.recorder2) REC.recorder2.start(500);
  $('#recGo').classList.add('on');
  const micLabel = selectedMicLabel(), q = micQuality(micLabel);
  if (q !== 'good') { flashWarn('⚠ Not using a good mic', q === 'none' ? 'No microphone is connected' : `Recording with “${micLabel}”`); $('#recMicBadge').classList.remove('hidden'); }
  const audioTrack = REC.stream.getAudioTracks()[0];
  if (audioTrack) audioTrack.onended = () => { if (REC.recorder && REC.recorder.state === 'recording') { flashWarn('⚠ Microphone disconnected', 'Recording stopped; the take so far is saved'); stopRecording(); } };
  REC.timer = setInterval(() => { const el = $('#recTime'); if (!el) return; el.textContent = fmt((performance.now() - REC.start) / 1000); $('#recStatus').textContent = REC.failed ? `⚠ ${REC.failed} chunk(s) not saved yet` : `saved ${(REC.bytes / 1e6).toFixed(1)} MB`; if (REC.mode === 'voiceover' && !playing) stopRecording(); }, 250);
}
async function sendChunk(seq, blob, attempt = 0, track = 'main') {
  try { const r = await api('POST', `/api/projects/${P.name}/record/${REC.session}/chunk?seq=${seq}&track=${track}`, blob); if (track === 'main') REC.bytes = r.bytes; REC.failed = 0; }
  catch (e) { if (attempt < 5 && e.status !== 409) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); return sendChunk(seq, blob, attempt + 1, track); } REC.failed++; }
}
// Space during a recording: a marker at this moment of the take (or, for narration, on the clip playing)
function recMarker() {
  if (!(REC.recorder && REC.recorder.state === 'recording')) return;
  const t = (performance.now() - REC.start) / 1000;
  REC.markers.push(t);
  api('POST', `/api/projects/${P.name}/record/${REC.session}/marker`, { t }).catch(() => { });   // kept with the take on disk
  const c = $('#recMarks'); if (!c) return;
  c.textContent = `◆ ${REC.markers.length}`; c.title = `${REC.markers.length} marker${REC.markers.length > 1 ? 's' : ''}, the last at ${fmt(t)}`;
  c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse');
}
window.addEventListener('keydown', e => {
  if (e.key !== ' ' || !(REC.recorder && REC.recorder.state === 'recording')) return;
  e.preventDefault(); e.stopPropagation();          // never let Space press a focused button (that would stop the take)
  if (!e.repeat) recMarker();
}, true);
window.addEventListener('keyup', e => { if (e.key === ' ' && REC.recorder && REC.recorder.state === 'recording') { e.preventDefault(); e.stopPropagation(); } }, true);
function stopRecording() { clearInterval(REC.timer); if ($('#recMark')) $('#recMark').disabled = true; $('#recGo') && $('#recGo').classList.remove('on'); $('#recMicBadge') && $('#recMicBadge').classList.add('hidden'); if (REC.mode === 'voiceover') stop(); if (REC.recorder2 && REC.recorder2.state === 'recording') REC.recorder2.stop(); if (REC.recorder && REC.recorder.state === 'recording') REC.recorder.stop(); }
async function finishRecording() {
  const secs = (performance.now() - REC.start) / 1000;
  if ($('#recStatus')) $('#recStatus').textContent = 'finishing…';
  await REC.queue; await REC.queue2;
  if (secs < 0.5) { await api('DELETE', `/api/projects/${P.name}/recordings/${REC.session}`).catch(() => { }); return toast('Too short, discarded'); }
  try {
    const r = await api('POST', `/api/projects/${P.name}/record/${REC.session}/finish`);
    setProject(r.project);
    const nm = r.markers ? ` · ${r.markers} marker${r.markers > 1 ? 's' : ''} to add pictures at` : '';
    toast((REC.mode === 'voiceover' ? `Voiceover added at ${fmt(REC.playFrom)}` : recIsScreen() ? 'Screen take added to the timeline · change its layout in the inspector' : 'Recording added to the timeline') + nm);
    if (r.id && REC.mode !== 'voiceover') { select(r.id); const s = seg(); if (s && s.placed) seek(s.placed.start, true); }
    if ($('#recStatus')) { $('#recStatus').textContent = 'saved'; $('#recTime').textContent = '0:00.0'; }
  } catch (e) {
    toast('Save failed: ' + e.message + ' — trying again', true);
    try {
      const fd = new FormData(); fd.append('file', new Blob(REC.chunks, { type: REC.recorder.mimeType || 'video/webm' }), 'rec'); fd.append('kind', REC.mode); fd.append('at', REC.playFrom); fd.append('fit', $('#recCover') && $('#recCover').checked ? 'cover' : 'contain'); fd.append('markers', JSON.stringify(REC.markers || []));
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
  if ($('#trimBox')) { trimKey(e); return; }
  if (e.key === 'Escape') { if (sheetOpen() && !$('#recBox')) closeSheet(); else if (MK.in != null || MK.out != null) clearMarks(); else if (sel || selVo || selSting || selImg || selMusic) select(null); return; }
  if (sheetOpen()) return;
  if (mod && e.key === 'Enter') { e.preventDefault(); startRender(e.shiftKey ? 'render' : 'preview'); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key === 'n') { e.preventDefault(); newProjectSheet(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('#zoomIn').click(); return; }
  if (mod && e.key === '-') { e.preventDefault(); $('#zoomOut').click(); return; }
  if (mod && e.key === '0') { e.preventDefault(); $('#zoomFit').click(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); ctxActions.split(); return; }   // Premiere's "add edit"
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const s = seg(); const fr = 1 / ((P.layout && P.layout.fps) || 30);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (k) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': setMark('in', T); break;
    case 'o': setMark('out', T); break;
    case 'x': markClip(); break;
    case 'k': keepRange(); break;
    case 'm': toggleMarker(); break;
    case ',': jumpMarker(-1); break;
    case '.': jumpMarker(1); break;
    case 's': case 'c': ctxActions.split(); break;
    case 'q': ctxActions.trimStart(); break;
    case 'w': ctxActions.trimEnd(); break;
    case 't': ctxActions.title(); break;
    case 'r': openRecorder('clip'); break;
    case 'f': { const c = $('#canvas'); document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen && c.requestFullscreen(); break; }
    case '?': showHelp(); break;
    case 'Backspace': case 'Delete': e.preventDefault(); if (markRange()) cutRange(); else if (s) $('#segDelete').click(); else if (selImg) deleteImage(selImg); else if (selVo) $('#voDel').click(); else if (selSting) $('#stDel').click(); break;
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
