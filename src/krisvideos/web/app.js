/* KrisVideos frontend. State lives in `P` (project JSON from the server); every edit
   round-trips through the API which rewrites project.yaml. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (t, d = 1) => { t = Math.max(0, +t || 0); const m = Math.floor(t / 60); const s = t - m * 60; return `${m}:${s.toFixed(d).padStart(d ? 3 + d : 2, '0')}`; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let P = null;            // project json
let sel = null;          // selected segment id
let mode = 'timeline';   // player mode: timeline | clip
let clipLoaded = null;   // src currently loaded in clip mode
let job = null;          // running job
let lastYaml = '';
let pollTimer = null;

const player = $('#player');

// ------------------------------------------------------------------ api
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { }
    throw new Error(msg);
  }
  return r.json();
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 2500);
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, true); console.error(e); } }

// ------------------------------------------------------------------ projects
async function loadProjects(selectName) {
  const list = await api('GET', '/api/projects');
  const sel = $('#projectSelect');
  sel.innerHTML = list.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.title && p.title !== p.name ? ' — ' + esc(p.title) : ''}</option>`).join('');
  if (!list.length) { $('#welcome').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
  $('#welcome').classList.add('hidden'); $('#app').classList.remove('hidden');
  const name = selectName || localStorage.getItem('kv.project') || list[0].name;
  sel.value = list.some(p => p.name === name) ? name : list[0].name;
  await openProject(sel.value);
}

async function openProject(name) {
  localStorage.setItem('kv.project', name);
  sel = null; clipLoaded = null; mode = 'timeline';
  setProject(await api('GET', `/api/projects/${name}`));
  $('#immichDate').value = P.date || new Date().toISOString().slice(0, 10);
  const imm = await api('GET', '/api/immich/status').catch(() => ({ ok: false }));
  if (imm.ok && $('#immichList').children.length <= 1) loadImmich();
}

function setProject(p) {
  P = p;
  if (sel && !P.timeline.some(s => s.id === sel)) sel = null;
  renderTimeline(); renderVoLane(); if (!selVo || !(P.voiceovers || []).some(v => v.id === selVo)) { selVo = null; renderInspector(); } else renderVoInspector(P.voiceovers.find(v => v.id === selVo)); renderProjectInspector(); renderClips(); renderPlayerSource();
  if ($('#yaml').value !== P.yaml && (document.activeElement !== $('#yaml'))) $('#yaml').value = P.yaml;
  lastYaml = P.yaml;
  $('#staleBadge').classList.toggle('hidden', !(P.preview && P.preview.stale));
  $('#tlMeta').textContent = P.layout ? `${fmt(P.layout.total)} · ${P.layout.width}×${P.layout.height} · ${P.timeline.length} segments` : '';
  $('#renderDone').classList.toggle('hidden', !(P.final && !P.final.stale));
  if (P.final && !P.final.stale) $('#renderDone .msg').textContent = `Rendered ${P.final.path.split('/').pop()} (${(P.final.size / 1e6).toFixed(1)} MB)`;
  // thumbnails/proxies may still be generating: re-fetch soon
  const pending = P.timeline.some(s => s.kind === 'clip' && !s.missing && (!s.proxy_url || !s.thumb_url));
  clearTimeout(setProject._t);
  if (pending) setProject._t = setTimeout(refresh, 2500);
}

async function refresh() { if (P) setProject(await api('GET', `/api/projects/${P.name}`)); }

// poll for external edits (Claude editing project.yaml, CLI, etc.)
setInterval(async () => {
  if (!P || job) return;
  try { const p = await api('GET', `/api/projects/${P.name}`); if (p.yaml !== lastYaml) setProject(p); } catch { }
}, 3000);

// ------------------------------------------------------------------ timeline
function renderTimeline() {
  const tl = $('#timeline');
  $$('.block', tl).forEach(b => b.remove());
  const total = P.layout ? P.layout.total : P.timeline.length;
  const pxPerSec = Math.max(14, (tl.clientWidth - 40) / Math.max(total, 1));
  for (const s of P.timeline) {
    const b = document.createElement('div');
    const dur = s.placed ? s.placed.duration : (s.duration || 3);
    b.className = `block ${s.kind}${s.missing ? ' missing' : ''}${s.id === sel ? ' selected' : ''}`;
    b.style.width = Math.max(48, dur * pxPerSec) + 'px';
    b.dataset.id = s.id; b.draggable = true;
    const label = s.kind === 'title' ? s.title : s.clip.replace(/^clips\//, '');
    b.innerHTML = `${s.thumb_url ? `<img src="${s.thumb_url}" draggable="false">` : ''}` +
      `${s.placed && s.placed.transition !== 'cut' ? '<div class="tr"></div>' : ''}` +
      `<div class="dur">${fmt(dur)}${s.speed && s.speed !== 1 ? ' ×' + s.speed : ''}${s.mute ? ' 🔇' : ''}</div>` +
      `${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ''}<div class="lbl">${s.kind === 'title' ? '🅃 ' : ''}${esc(label)}</div>`;
    b.onclick = () => select(s.id);
    b.ondblclick = () => { if (s.kind === 'clip') { setMode('clip'); } };
    b.ondragstart = e => { e.dataTransfer.setData('text/seg', s.id); e.dataTransfer.effectAllowed = 'move'; };
    b.ondragover = e => { e.preventDefault(); b.classList.add('dragover'); };
    b.ondragleave = () => b.classList.remove('dragover');
    b.ondrop = e => { e.preventDefault(); b.classList.remove('dragover'); onDropOnBlock(e, s.id); };
    tl.appendChild(b);
  }
  tl.ondragover = e => { e.preventDefault(); };
  tl.ondrop = e => { if (e.target === tl) onDropOnBlock(e, null); };
  updatePlayhead();
}

async function onDropOnBlock(e, targetId) {
  const segId = e.dataTransfer.getData('text/seg');
  const clipSrc = e.dataTransfer.getData('text/clip');
  const immich = e.dataTransfer.getData('text/immich');
  const ids = P.timeline.map(s => s.id);
  let at = targetId ? ids.indexOf(targetId) : ids.length;
  if (targetId) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX > r.left + r.width / 2) at++; }
  if (segId) {
    const from = ids.indexOf(segId); if (from < 0) return;
    ids.splice(from, 1); if (at > from) at--; ids.splice(at, 0, segId);
    await guard(async () => setProject(await api('POST', `/api/projects/${P.name}/reorder`, { ids })));
  } else if (clipSrc) {
    await guard(async () => setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'clip', src: clipSrc, at })));
  } else if (immich) {
    await importImmich([JSON.parse(immich)]);
  }
}

function select(id) {
  sel = id; selVo = null; $$('#voTrack .vo').forEach(b => b.classList.remove('selected'));
  $$('#timeline .block').forEach(b => b.classList.toggle('selected', b.dataset.id === id));
  renderInspector();
  const s = seg();
  if (!s) return;
  if (mode === 'clip') loadClip(s);
  else if (s.placed && P.preview && !isNaN(player.duration)) { player.currentTime = s.placed.start + 0.02; }
  if (s.kind === 'title' && mode === 'clip') showTitlePreview(s);
}
const seg = () => P && P.timeline.find(s => s.id === sel);

// ------------------------------------------------------------------ player
function setMode(m) {
  mode = m;
  $('#modeTimeline').classList.toggle('active', m === 'timeline');
  $('#modeClip').classList.toggle('active', m === 'clip');
  clipLoaded = null;
  renderPlayerSource();
}
function renderPlayerSource() {
  const s = seg();
  $('#titlePreview').classList.add('hidden');
  if (mode === 'clip' && s) {
    if (s.kind === 'clip') loadClip(s); else showTitlePreview(s);
    $('#playerEmpty').classList.add('hidden');
    return;
  }
  if (mode === 'clip' && !s) { $('#playerEmpty').classList.remove('hidden'); $('#playerEmpty').innerHTML = 'Select a clip to scrub it.'; player.removeAttribute('src'); return; }
  // timeline mode
  if (P.preview) {
    $('#playerEmpty').classList.add('hidden');
    const url = P.preview.url;
    if (player.dataset.url !== url) { const t = player.currentTime; player.src = url; player.dataset.url = url; player.load(); player.currentTime = t || 0; }
  } else {
    player.removeAttribute('src'); player.dataset.url = '';
    $('#playerEmpty').innerHTML = 'No preview yet.<br><small>Press <b>Preview</b> (or ⌘⏎) to render one.</small>';
    $('#playerEmpty').classList.remove('hidden');
  }
  updateScrub();
}
function loadClip(s) {
  if (s.kind !== 'clip') { showTitlePreview(s); return; }
  $('#titlePreview').classList.add('hidden'); $('#playerEmpty').classList.add('hidden');
  const url = s.proxy_url || s.src_url;
  if (clipLoaded !== url) {
    player.src = url; player.dataset.url = url; clipLoaded = url; player.load();
    player.onloadedmetadata = () => { player.currentTime = s.in || 0; updateScrub(); };
  }
  updateScrub();
}
function showTitlePreview(s) {
  player.pause(); player.removeAttribute('src'); player.dataset.url = ''; clipLoaded = null;
  $('#titlePreview .t').textContent = s.title; $('#titlePreview .s').textContent = s.subtitle || '';
  $('#titlePreview').style.background = P.style.title_bg; $('#titlePreview .t').style.color = P.style.title_fg;
  $('#titlePreview').classList.remove('hidden');
}
function playerDuration() { return mode === 'clip' ? (player.duration || 0) : (player.duration || (P.layout ? P.layout.total : 0)); }
function updateScrub() {
  const d = playerDuration() || 1, t = player.currentTime || 0;
  $('#scrubInput').value = Math.round(t / d * 1000);
  $('#scrubFill').style.width = `${t / d * 100}%`;
  $('#timeNow').textContent = fmt(t); $('#timeTotal').textContent = fmt(d);
  const s = seg();
  const r = $('#scrubRange');
  if (mode === 'clip' && s && s.kind === 'clip' && player.duration) {
    const a = (s.in || 0) / player.duration, b = (s.out ?? player.duration) / player.duration;
    r.style.left = `${a * 100}%`; r.style.width = `${(b - a) * 100}%`; r.style.display = 'block';
  } else r.style.display = 'none';
  $('#playBtn').textContent = player.paused ? '▶' : '❚❚';
  updatePlayhead();
}
function updatePlayhead() {
  const ph = $('#playhead');
  if (mode !== 'timeline' || !P.layout || !P.preview) { ph.style.display = 'none'; return; }
  const t = player.currentTime || 0;
  const blocks = $$('#timeline .block');
  for (const s of P.timeline) {
    if (!s.placed) continue;
    if (t >= s.placed.start && t < s.placed.end || s === P.timeline[P.timeline.length - 1]) {
      const b = blocks.find(b => b.dataset.id === s.id); if (!b) break;
      const frac = Math.min(1, (t - s.placed.start) / Math.max(0.01, s.placed.duration));
      ph.style.left = (b.offsetLeft + frac * b.offsetWidth) + 'px'; ph.style.display = 'block';
      break;
    }
  }
}
player.addEventListener('timeupdate', () => {
  updateScrub();
  const s = seg();
  if (mode === 'clip' && s && s.kind === 'clip' && s.out != null && player.currentTime >= s.out && !player.paused) { player.pause(); player.currentTime = s.out; }
});
player.addEventListener('play', updateScrub); player.addEventListener('pause', updateScrub); player.addEventListener('loadedmetadata', updateScrub);
$('#scrubInput').oninput = e => { const d = playerDuration(); if (d) player.currentTime = e.target.value / 1000 * d; updateScrub(); };
$('#playBtn').onclick = togglePlay;
function togglePlay() {
  if (!player.src) return;
  if (player.paused) {
    const s = seg();
    if (mode === 'clip' && s && s.kind === 'clip' && s.out != null && player.currentTime >= s.out - 0.05) player.currentTime = s.in || 0;
    player.play();
  } else player.pause();
}
$('#modeTimeline').onclick = () => setMode('timeline');
$('#modeClip').onclick = () => setMode('clip');

// timeline-time of the playhead (for "cut to title here" / split)
function playheadTime() {
  if (mode === 'timeline') return player.currentTime || 0;
  const s = seg();
  if (s && s.kind === 'clip' && s.placed) return s.placed.start + ((player.currentTime || 0) - (s.in || 0)) / (s.speed || 1);
  return 0;
}

// ------------------------------------------------------------------ edits
async function patchSeg(id, body) { await guard(async () => setProject(await api('PATCH', `/api/projects/${P.name}/segments/${id}`, body))); }
async function patchProject(body) { await guard(async () => setProject(await api('PATCH', `/api/projects/${P.name}`, body))); }

$('#setIn').onclick = () => { const s = seg(); if (s && s.kind === 'clip' && mode === 'clip') patchSeg(s.id, { in: player.currentTime }); else toast('Switch to Clip mode and select a clip'); };
$('#setOut').onclick = () => { const s = seg(); if (s && s.kind === 'clip' && mode === 'clip') patchSeg(s.id, { out: player.currentTime }); else toast('Switch to Clip mode and select a clip'); };
$('#splitHere').onclick = () => guard(async () => setProject(await api('POST', `/api/projects/${P.name}/split`, { time: playheadTime() })));
$('#titleHere').onclick = () => titleAt(playheadTime());
$('#addTitleBtn').onclick = () => addTitleDialog(null);

function titleAt(t) {
  modal(`<h2>Cut to title at ${fmt(t)}</h2>
    <div class="field"><label>Title</label><input id="m_t" type="text" placeholder="Lunch" autofocus></div>
    <div class="field"><label>Subtitle</label><input id="m_s" type="text" placeholder="optional"></div>
    <div class="field"><label>Seconds</label><input id="m_d" type="number" value="2.5" step="0.5" min="0.5"></div>
    <div class="row"><button class="btn primary" id="m_ok">Insert</button><button class="btn" id="m_cancel">Cancel</button></div>`);
  $('#m_ok').onclick = () => guard(async () => {
    setProject(await api('POST', `/api/projects/${P.name}/title-at`, { time: t, text: $('#m_t').value, subtitle: $('#m_s').value, duration: +$('#m_d').value }));
    closeModal();
  });
}
function addTitleDialog(at) {
  modal(`<h2>Add title card</h2>
    <div class="field"><label>Title</label><input id="m_t" type="text" placeholder="Lunch" autofocus></div>
    <div class="field"><label>Subtitle</label><input id="m_s" type="text" placeholder="optional"></div>
    <div class="field"><label>Seconds</label><input id="m_d" type="number" value="3" step="0.5" min="0.5"></div>
    <div class="field"><label>Place</label><select id="m_at"><option value="">at the end</option><option value="0">at the beginning</option>${sel ? `<option value="after" selected>after selected segment</option>` : ''}</select></div>
    <div class="row"><button class="btn primary" id="m_ok">Add</button><button class="btn" id="m_cancel">Cancel</button></div>`);
  $('#m_ok').onclick = () => guard(async () => {
    let at = $('#m_at').value; if (at === 'after') at = P.timeline.findIndex(s => s.id === sel) + 1; else if (at === '') at = null; else at = +at;
    setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'title', text: $('#m_t').value, subtitle: $('#m_s').value, duration: +$('#m_d').value, at }));
    closeModal();
  });
}

// ------------------------------------------------------------------ inspector
function field(label, inner) { return `<div class="field"><label>${label}</label>${inner}</div>`; }
function renderInspector() {
  const el = $('#segInspector');
  const s = seg();
  if (!s) { el.innerHTML = '<div class="hint">Select a segment on the timeline.<br><br><kbd>T</kbd> cut to title at playhead · <kbd>S</kbd> split · <kbd>I</kbd>/<kbd>O</kbd> trim · <kbd>⌫</kbd> delete · <kbd>space</kbd> play</div>'; return; }
  const trOpts = ['', 'cut', 'fade', 'dip'].map(v => `<option value="${v}" ${(s.transition || '') === v ? 'selected' : ''}>${v || 'project default (' + P.style.transition + ')'}</option>`).join('');
  let html = '';
  if (s.kind === 'title') {
    html += `<h3>Title card</h3>` +
      field('Title', `<input type="text" data-k="text" value="${esc(s.title)}">`) +
      field('Subtitle', `<input type="text" data-k="subtitle" value="${esc(s.subtitle || '')}">`) +
      field('Duration (s)', `<input type="number" data-k="duration" step="0.5" min="0.5" value="${s.duration}">`);
  } else {
    const m = s.media || {};
    html += `<h3>Clip</h3><div class="muted" style="margin-bottom:8px">${esc(s.clip)}${m.width ? ` · ${m.width}×${m.height}${m.hdr ? ' HDR' : ''} · ${fmt(m.duration)}` : ''}${s.lufs != null ? ` · ${s.lufs.toFixed(1)} LUFS` : ''}${s.missing ? ' · <b style="color:var(--danger)">file missing</b>' : ''}</div>` +
      field('In / Out (source seconds)', `<div class="inline"><input type="text" data-k="in" value="${fmt(s.in || 0, 2)}"><span class="muted">→</span><input type="text" data-k="out" value="${s.out == null ? 'end' : fmt(s.out, 2)}"></div>`) +
      field('Fit to frame', `<select data-k="fit"><option value="contain" ${s.fit !== 'cover' ? 'selected' : ''}>letterbox (show everything)</option><option value="cover" ${s.fit === 'cover' ? 'selected' : ''}>crop to fill</option></select>`) +
      field('Caption (lower third, whole clip)', `<input type="text" data-k="caption" value="${esc(s.caption || '')}" placeholder="e.g. coffee first">`) +
      `<div class="field"><label>Text overlays</label><div id="ovList"></div><button class="btn small" id="ovAdd">+ overlay</button></div>` +
      field('Speed', `<div class="inline"><input type="range" data-k="speed" min="0.25" max="4" step="0.25" value="${s.speed || 1}"><span id="speedLbl">${s.speed || 1}×</span></div>`) +
      `<div class="check"><input type="checkbox" id="muteChk" ${s.mute ? 'checked' : ''}><label for="muteChk">Mute clip audio</label></div>` +
      field('Clip volume', `<input type="range" data-k="volume" min="0" max="2" step="0.1" value="${s.volume ?? 1}">`);
  }
  html += field('Transition into this segment', `<div class="inline"><select data-k="transition">${trOpts}</select><input type="number" data-k="transition_duration" step="0.1" min="0.1" max="3" value="${s.transition_duration ?? ''}" placeholder="${P.style.transition_duration}s" style="width:70px"></div>`);
  html += `<div class="row"><button class="btn small danger" id="segDelete">Delete</button><button class="btn small" id="segDup">Duplicate</button></div>`;
  el.innerHTML = html;
  $$('[data-k]', el).forEach(inp => {
    const k = inp.dataset.k;
    const commit = () => patchSeg(s.id, { [k]: inp.type === 'number' || inp.type === 'range' ? (inp.value === '' ? '' : +inp.value) : inp.value });
    if (inp.type === 'range') { inp.oninput = () => { if (k === 'speed') $('#speedLbl').textContent = inp.value + '×'; }; inp.onchange = commit; }
    else if (inp.tagName === 'SELECT') inp.onchange = commit;
    else { inp.onchange = commit; inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); }; }
  });
  if ($('#muteChk')) $('#muteChk').onchange = e => patchSeg(s.id, { mute: e.target.checked });
  $('#segDelete').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/segments/${s.id}`)); });
  $('#segDup').onclick = () => guard(async () => {
    const at = P.timeline.findIndex(x => x.id === s.id) + 1;
    const body = s.kind === 'title' ? { kind: 'title', text: s.title, subtitle: s.subtitle, duration: s.duration, at } : { kind: 'clip', src: s.clip, at };
    const p = await api('POST', `/api/projects/${P.name}/segments`, body);
    if (s.kind === 'clip') { const ns = p.timeline[at]; await api('PATCH', `/api/projects/${P.name}/segments/${ns.id}`, { in: s.in, out: s.out ?? '', speed: s.speed, mute: s.mute, caption: s.caption || '' }); }
    setProject(await api('GET', `/api/projects/${P.name}`));
  });
  if (s.kind === 'clip') renderOverlays(s);
}
function renderOverlays(s) {
  const box = $('#ovList');
  box.innerHTML = s.overlays.map((o, i) => `<div class="ov" data-i="${i}">
      <div class="row"><input type="text" class="ov-text" value="${esc(o.text)}" placeholder="text"></div>
      <div class="row"><span class="muted">at</span><input type="number" class="ov-at" step="0.5" min="0" value="${o.at}"><span class="muted">for</span><input type="number" class="ov-for" step="0.5" min="0.5" value="${o.for ?? ''}" placeholder="rest">
        <select class="ov-pos"><option ${o.position === 'bottom' || !o.position ? 'selected' : ''}>bottom</option><option ${o.position === 'top' ? 'selected' : ''}>top</option><option ${o.position === 'center' ? 'selected' : ''}>center</option></select>
        <select class="ov-style"><option value="caption" ${o.style !== 'big' ? 'selected' : ''}>pill</option><option value="big" ${o.style === 'big' ? 'selected' : ''}>big</option></select>
        <button class="btn small ghost ov-del">✕</button></div></div>`).join('');
  const commit = () => {
    const overlays = $$('.ov', box).map(d => ({ text: $('.ov-text', d).value, at: +$('.ov-at', d).value || 0, for: $('.ov-for', d).value === '' ? null : +$('.ov-for', d).value, position: $('.ov-pos', d).value, style: $('.ov-style', d).value }))
      .map(o => { if (o.for == null) delete o.for; return o; });
    patchSeg(s.id, { overlays });
  };
  $$('input, select', box).forEach(i => { i.onchange = commit; i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
  $$('.ov-del', box).forEach(b => b.onclick = () => { b.closest('.ov').remove(); commit(); });
  $('#ovAdd').onclick = () => patchSeg(s.id, { overlays: [...s.overlays, { text: 'new overlay', at: mode === 'clip' ? Math.max(0, (player.currentTime || 0) - (s.in || 0)) : 0, for: 3 }] });
}

function renderProjectInspector() {
  const el = $('#projInspector');
  const o = P.output, st = P.style, m = P.music, a = P.audio;
  const opt = (vals, cur) => vals.map(v => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
  el.innerHTML = `<h3>Project</h3>` +
    field('Title', `<input type="text" data-p="title" value="${esc(P.title)}">`) +
    field('Orientation', `<select data-p="output.orientation">${opt(['auto', 'portrait', 'landscape', 'square'], o.orientation)}</select>`) +
    field('Default transition', `<div class="inline"><select data-p="style.transition">${opt(['cut', 'fade', 'dip'], st.transition)}</select><input type="number" data-p="style.transition_duration" step="0.1" min="0.1" max="3" value="${st.transition_duration}" style="width:70px"></div>`) +
    field('Music', `<div class="inline"><input type="text" data-p="music.file" value="${esc(m.file || '')}" placeholder="none"><button class="btn small" id="pickMusic">…</button></div>`) +
    (m.file ? field('Music volume', `<input type="range" data-p="music.volume" min="0" max="1" step="0.02" value="${m.volume}">`) +
      `<div class="check"><input type="checkbox" id="duckChk" ${m.duck ? 'checked' : ''}><label for="duckChk">Duck music under speech</label></div>` : '') +
    field('Fade in / out (s)', `<div class="inline"><input type="number" data-p="style.fade_in" step="0.1" min="0" value="${st.fade_in}"><input type="number" data-p="style.fade_out" step="0.1" min="0" value="${st.fade_out}"></div>`) +
    field('Title colors', `<div class="inline"><input type="color" data-p="style.title_bg" value="${st.title_bg}" title="background"><input type="color" data-p="style.title_fg" value="${st.title_fg}" title="text"><input type="text" data-p="style.font" value="${esc(st.font)}" title="font family"></div>`) +
    field('Output', `<div class="inline"><select data-p="output.codec">${opt(['h264', 'hevc'], o.codec)}</select><select data-p="output.quality">${opt(['high', 'medium'], o.quality)}</select><select data-p="output.fps">${opt([24, 30, 60], o.fps)}</select></div>`) +
    `<div class="check"><input type="checkbox" id="normChk" ${a.normalize ? 'checked' : ''}><label for="normChk">Normalize loudness</label></div>` +
    `<div class="check"><input type="checkbox" id="matchChk" ${a.match_levels ? 'checked' : ''}><label for="matchChk">Match clip & voice levels</label></div>` +
    `<div class="row"><button class="btn small ghost" id="openFolder">Open project folder</button><button class="btn small ghost danger" id="deleteProject">Delete project</button></div>`;
  $$('[data-p]', el).forEach(inp => {
    const path = inp.dataset.p.split('.');
    const commit = () => {
      const v = inp.type === 'number' || inp.type === 'range' ? +inp.value : inp.value;
      const body = path.length === 1 ? { [path[0]]: v } : { [path[0]]: { [path[1]]: v } };
      patchProject(body);
    };
    inp.onchange = commit; inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
  });
  if ($('#duckChk')) $('#duckChk').onchange = e => patchProject({ music: { duck: e.target.checked } });
  $('#normChk').onchange = e => patchProject({ audio: { normalize: e.target.checked } });
  $('#matchChk').onchange = e => patchProject({ audio: { match_levels: e.target.checked } });
  $('#pickMusic').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'music' }); if (r.paths[0]) patchProject({ music: { file: r.paths[0] } }); });
  $('#openFolder').onclick = () => api('POST', '/api/open', { path: P.folder });
  $('#deleteProject').onclick = () => modal(`<h2>Delete “${esc(P.name)}”?</h2><p class="muted">The folder is moved to the Trash.</p><div class="row"><button class="btn danger" id="m_ok">Delete</button><button class="btn" id="m_cancel">Cancel</button></div>`, () => guard(async () => { await api('DELETE', `/api/projects/${P.name}`); closeModal(); localStorage.removeItem('kv.project'); P = null; await loadProjects(); }));
}

// ------------------------------------------------------------------ library: clips
function renderClips() {
  const box = $('#clipList');
  if (!P.clips.length) { box.innerHTML = '<div class="hint">No clips in this project yet. Import files or pull from Immich.</div>'; return; }
  box.innerHTML = P.clips.map(c => `<div class="card ${c.in_timeline ? 'inproj' : ''}" draggable="true" data-src="${esc(c.src)}">
      ${c.thumb_url ? `<img src="${c.thumb_url}" draggable="false">` : '<div class="noimg">…</div>'}
      <div class="info"><div class="name">${esc(c.name)}</div><div class="meta">${c.media ? `${fmt(c.media.duration)} · ${c.media.width}×${c.media.height}${c.media.hdr ? ' HDR' : ''}` : ''}${c.in_timeline ? ' · in timeline' : ''}</div></div>
      <button class="btn small" data-add="${esc(c.src)}">+</button></div>`).join('');
  $$('[data-add]', box).forEach(b => b.onclick = () => guard(async () => setProject(await api('POST', `/api/projects/${P.name}/segments`, { kind: 'clip', src: b.dataset.add }))));
  $$('.card', box).forEach(c => c.ondragstart = e => e.dataTransfer.setData('text/clip', c.dataset.src));
}
$('#pickFiles').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'files' }); if (r.paths.length) importPaths(r.paths); });
$('#pickFolder').onclick = () => guard(async () => { const r = await api('POST', '/api/pick', { kind: 'folder' }); if (r.paths.length) importPaths(r.paths); });
async function importPaths(paths) { await guard(async () => { const r = await api('POST', `/api/projects/${P.name}/import`, { paths }); setProject(r.project); toast(`Imported ${r.added.length} clip(s)`); }); }
const dz = $('#dropZone');
for (const el of [dz, $('#library')]) {
  el.ondragover = e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dz.classList.add('over'); } };
  el.ondragleave = () => dz.classList.remove('over');
  el.ondrop = e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); dz.classList.remove('over');
    const fd = new FormData(); for (const f of e.dataTransfer.files) fd.append('files', f);
    toast('Uploading…');
    guard(async () => { const r = await api('POST', `/api/projects/${P.name}/upload`, fd); setProject(r.project); toast(`Imported ${r.added.length} clip(s)`); });
  };
}

// ------------------------------------------------------------------ library: immich
let immichVids = [];
async function loadImmich() {
  const box = $('#immichList'); box.innerHTML = '<div class="hint">Loading…</div>';
  try {
    immichVids = await api('GET', `/api/immich/videos?date=${$('#immichDate').value}&days=${$('#immichDays').value}`);
  } catch (e) { box.innerHTML = `<div class="hint">${esc(e.message)}<br><br><button class="btn small" onclick="openSettings()">Configure Immich</button></div>`; return; }
  if (!immichVids.length) { box.innerHTML = '<div class="hint">No videos on that day.</div>'; return; }
  const have = new Set(P.clips.map(c => c.name));
  box.innerHTML = immichVids.map(v => `<div class="card ${have.has(v.filename) ? 'inproj' : ''}" draggable="true" data-id="${v.id}">
      <input type="checkbox" class="imsel" ${have.has(v.filename) ? 'disabled' : ''}>
      <img src="${v.thumb_url}" loading="lazy" draggable="false">
      <div class="info"><div class="name">${esc((v.taken_at || '').replace('T', ' ').slice(11, 16))} ${esc(v.filename)}</div><div class="meta">${esc((v.duration || '').replace(/^0?0:|\.\d+$/g, ''))}${v.width ? ` · ${v.width}×${v.height}` : ''}${v.city ? ' · ' + esc(v.city) : ''}${have.has(v.filename) ? ' · imported' : ''}</div></div>
      <button class="btn small" data-imp="${v.id}">${have.has(v.filename) ? '✓' : '+'}</button></div>`).join('');
  $$('[data-imp]', box).forEach(b => b.onclick = () => importImmich([immichVids.find(v => v.id === b.dataset.imp)]));
  $$('.card', box).forEach(c => c.ondragstart = e => e.dataTransfer.setData('text/immich', JSON.stringify(immichVids.find(v => v.id === c.dataset.id))));
}
$('#immichLoad').onclick = loadImmich;
$('#immichDate').onchange = loadImmich;
$('#immichAddAll').onclick = () => { const have = new Set(P.clips.map(c => c.name)); importImmich(immichVids.filter(v => !have.has(v.filename))); };
$('#immichAddSel').onclick = () => { const ids = $$('#immichList .card').filter(c => $('.imsel', c).checked).map(c => c.dataset.id); importImmich(immichVids.filter(v => ids.includes(v.id))); };
async function importImmich(assets) {
  if (!assets.length) return toast('Nothing to import');
  await guard(async () => {
    const j = await api('POST', `/api/projects/${P.name}/import-immich`, { assets: assets.map(a => ({ id: a.id, filename: a.filename })) });
    watchJob(j, async () => { await refresh(); loadImmich(); toast(`Imported ${assets.length} clip(s)`); });
  });
}

// ------------------------------------------------------------------ jobs
function watchJob(j, onDone) {
  job = j;
  const bar = $('#jobBar'); bar.classList.remove('hidden'); $('#renderDone').classList.add('hidden');
  $('#previewBtn').disabled = $('#renderBtn').disabled = true;
  clearInterval(pollTimer);
  const label = { preview: 'Rendering preview', render: 'Rendering final video', import: 'Importing' }[j.kind] || j.kind;
  pollTimer = setInterval(async () => {
    try { j = await api('GET', `/api/jobs/${j.id}`); } catch { return; }
    $('#jobBar .fill').style.width = `${Math.round(j.progress * 100)}%`;
    $('#jobBar .msg').textContent = `${label} ${Math.round(j.progress * 100)}%${j.secs ? ' · ' + fmt(j.secs) : ''}${j.message ? ' · ' + j.message : ''} (${j.elapsed}s)`;
    if (j.status !== 'running') {
      clearInterval(pollTimer); job = null; bar.classList.add('hidden');
      $('#previewBtn').disabled = $('#renderBtn').disabled = false;
      if (j.status === 'error') toast(`${label} failed: ${j.error.split('\n').slice(-3).join(' ')}`, true);
      else if (j.status === 'cancelled') toast('Cancelled');
      else { j.warnings?.forEach(w => toast(w, true)); if (onDone) await onDone(j); }
    }
  }, 400);
}
$('#jobCancel').onclick = () => job && api('POST', `/api/jobs/${job.id}/cancel`);
$('#previewBtn').onclick = () => startRender('preview');
$('#renderBtn').onclick = () => startRender('render');
function startRender(kind) {
  if (!P.timeline.length) return toast('Timeline is empty');
  guard(async () => {
    const j = await api('POST', `/api/projects/${P.name}/${kind}`);
    const wasPlaying = !player.paused, t = player.currentTime;
    watchJob(j, async () => {
      await refresh();
      if (kind === 'preview') { setMode('timeline'); player.currentTime = t || 0; if (wasPlaying) player.play(); toast('Preview ready'); }
      else { $('#renderDone').classList.remove('hidden'); toast('Render complete'); }
    });
  });
}
$('#revealBtn').onclick = () => P.final && api('POST', '/api/reveal', { path: P.final.path });
$('#openBtn').onclick = () => P.final && api('POST', '/api/open', { path: P.final.path });

// ------------------------------------------------------------------ yaml / command
$('#yamlApply').onclick = () => guard(async () => { setProject(await api('PUT', `/api/projects/${P.name}/yaml`, { yaml: $('#yaml').value })); $('#yamlMsg').textContent = 'applied'; setTimeout(() => $('#yamlMsg').textContent = '', 1500); });
$('#yamlRevert').onclick = () => { $('#yaml').value = P.yaml; };
$('#yaml').onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#yamlApply').click(); } if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } };
$('#showCmd').onclick = () => guard(async () => { const r = await api('GET', `/api/projects/${P.name}/command`); modal(`<h2>ffmpeg command</h2><pre>${esc(r.command)}</pre><div class="row"><button class="btn" id="m_cancel">Close</button></div>`); });

// ------------------------------------------------------------------ project creation / settings
$('#projectSelect').onchange = e => openProject(e.target.value);
$('#newProjectBtn').onclick = newProjectDialog; $('#welcomeNew').onclick = newProjectDialog;
function newProjectDialog() {
  const today = new Date().toISOString().slice(0, 10);
  modal(`<h2>New vlog</h2>
    <div class="field"><label>Folder name (date)</label><input id="m_n" type="text" value="${today}"></div>
    <div class="field"><label>Title (for the opening card)</label><input id="m_t" type="text" placeholder="${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}"></div>
    <div class="check"><input type="checkbox" id="m_o" checked><label for="m_o">Start with an opening title card</label></div>
    <div class="row"><button class="btn primary" id="m_ok">Create</button><button class="btn" id="m_cancel">Cancel</button></div>`);
  $('#m_ok').onclick = () => guard(async () => { const p = await api('POST', '/api/projects', { name: $('#m_n').value, title: $('#m_t').value || null, opening: $('#m_o').checked }); closeModal(); await loadProjects(p.name); });
}
$('#settingsBtn').onclick = openSettings;
async function openSettings() {
  const s = await api('GET', '/api/settings');
  modal(`<h2>Settings</h2>
    <div class="field"><label>Immich URL</label><input id="s_url" type="text" value="${esc(s.immich_url)}" placeholder="http://immich.local:2283"></div>
    <div class="field"><label>Immich API key</label><input id="s_key" type="password" value="${esc(s.immich_api_key)}" placeholder="Immich → Account settings → API keys"></div>
    <div class="field"><label>Vlogs folder</label><input id="s_dir" type="text" value="${esc(s.vlogs_dir)}"></div>
    <div class="field"><label>Default subtitle on opening card</label><input id="s_sub" type="text" value="${esc(s.default_title_subtitle)}" placeholder="e.g. a daily vlog"></div>
    <div class="field"><label>Default music file</label><input id="s_music" type="text" value="${esc(s.default_music)}" placeholder="optional"></div>
    <div class="field"><label>Default orientation</label><select id="s_or">${['auto', 'portrait', 'landscape', 'square'].map(v => `<option ${v === s.default_orientation ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Default transition</label><select id="s_tr">${['cut', 'fade', 'dip'].map(v => `<option ${v === s.default_transition ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Font</label><input id="s_font" type="text" value="${esc(s.font)}"></div>
    <p class="muted">Saved to ${esc(s.config_file)}</p>
    <div class="row"><button class="btn primary" id="m_ok">Save</button><button class="btn" id="m_cancel">Cancel</button></div>`);
  $('#m_ok').onclick = () => guard(async () => {
    await api('PUT', '/api/settings', { immich_url: $('#s_url').value, immich_api_key: $('#s_key').value, vlogs_dir: $('#s_dir').value, default_title_subtitle: $('#s_sub').value, default_music: $('#s_music').value, default_orientation: $('#s_or').value, default_transition: $('#s_tr').value, font: $('#s_font').value });
    closeModal(); await immichStatus(); await loadProjects(P && P.name); toast('Settings saved');
  });
}
async function immichStatus() {
  const el = $('#immichStatus');
  const s = await api('GET', '/api/immich/status').catch(() => ({ ok: false, error: 'offline' }));
  el.className = 'status ' + (s.ok ? 'ok' : s.configured ? 'bad' : '');
  el.title = s.ok ? `Immich: connected as ${s.user}` : `Immich: ${s.error || 'not configured'}`;
}

// ------------------------------------------------------------------ modal / tabs / keys
function modal(html, onOk) {
  $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden');
  const first = $('#modalBody input[type=text], #modalBody input'); if (first) setTimeout(() => first.focus(), 30);
  const c = $('#m_cancel'); if (c) c.onclick = closeModal;
  if (onOk && $('#m_ok')) $('#m_ok').onclick = onOk;
  $('#modalBody').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && $('#m_ok')) { e.preventDefault(); $('#m_ok').click(); } if (e.key === 'Escape') closeModal(); };
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
$$('#library .tab').forEach(t => t.onclick = () => { $$('#library .tab').forEach(x => x.classList.toggle('active', x === t)); $$('#library .tabpanel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + t.dataset.tab)); });

document.addEventListener('keydown', e => {
  if (!P || !$('#modal').classList.contains('hidden')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); startRender(e.shiftKey ? 'render' : 'preview'); return; }
  if (e.metaKey || e.ctrlKey) return;
  const s = seg();
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': $('#setIn').click(); break;
    case 'o': $('#setOut').click(); break;
    case 't': $('#titleHere').click(); break;
    case 's': $('#splitHere').click(); break;
    case 'c': setMode(mode === 'clip' ? 'timeline' : 'clip'); break;
    case 'Backspace': case 'Delete': if (s) { e.preventDefault(); $('#segDelete').click(); } break;
    case 'ArrowLeft': if (player.src) { e.preventDefault(); player.pause(); player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 1 : 1 / 30)); } break;
    case 'ArrowRight': if (player.src) { e.preventDefault(); player.pause(); player.currentTime = player.currentTime + (e.shiftKey ? 1 : 1 / 30); } break;
    case 'ArrowUp': case 'ArrowDown': {
      if (!P.timeline.length) break;
      e.preventDefault(); const i = P.timeline.findIndex(x => x.id === sel);
      const n = e.key === 'ArrowUp' ? Math.max(0, i - 1) : Math.min(P.timeline.length - 1, i + 1);
      select(P.timeline[n].id); break;
    }
  }
});
window.addEventListener('resize', () => P && renderTimeline());

// ------------------------------------------------------------------ boot
(async () => { await immichStatus(); await guard(loadProjects); })();

// ================================================================== recording
const REC = { stream: null, recorder: null, chunks: [], mode: 'clip', ctx: null, raf: 0, start: 0, playFrom: 0, timer: 0 };
$('#recordBtn').onclick = openRecorder;
document.addEventListener('keydown', e => { if (P && e.key === 'r' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) && $('#modal').classList.contains('hidden')) openRecorder(); });

function pickMime(kind) {
  const cands = kind === 'voiceover'
    ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return cands.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

async function openRecorder() {
  if (!navigator.mediaDevices) return toast('Recording needs a secure context (localhost is fine)', true);
  const portrait = P.layout && P.layout.orientation === 'portrait';
  modal(`<div id="recBox">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Record</h2>
      <div class="seg"><button class="tab active" data-rm="clip">Camera clip</button><button class="tab" data-rm="voiceover">Voiceover</button></div></div>
    <video id="recPreview" autoplay muted playsinline class="${portrait ? 'portrait' : ''}"></video>
    <div class="meter"><div class="lvl" id="recLvl"></div></div>
    <div class="recgrid">
      <div class="field"><label>Camera</label><select id="recCam"></select></div>
      <div class="field"><label>Microphone</label><select id="recMic"></select></div>
      <div class="field"><label>Quality</label><select id="recQ"><option value="1080">1080p</option><option value="720">720p</option><option value="2160">4K (if supported)</option></select></div>
      <div class="field"><label>Options</label><div class="inline">
        <label class="check" style="margin:0"><input type="checkbox" id="recMirror" checked> mirror preview</label>
        <label class="check" style="margin:0"><input type="checkbox" id="recCover" ${portrait ? 'checked' : ''}> crop to fill frame</label></div></div>
    </div>
    <div id="recVoHint" class="muted hidden">The preview plays from <b id="recVoAt">${fmt(playheadTime())}</b> while you talk. Use headphones so the speakers don't bleed into the mic. Clip audio is ducked under your voice.</div>
    <div class="recctl"><button class="recbtn" id="recGo" title="Start / stop"></button><span id="recTime">0:00.0</span><span id="recStatus" class="muted"></span><span class="spacer"></span><button class="btn" id="m_cancel">Close</button></div>
  </div>`);
  $('#m_cancel').onclick = closeRecorder;
  $$('[data-rm]').forEach(b => b.onclick = () => { $$('[data-rm]').forEach(x => x.classList.toggle('active', x === b)); REC.mode = b.dataset.rm; applyRecMode(); startPreview(); });
  $('#recCam').onchange = $('#recMic').onchange = $('#recQ').onchange = startPreview;
  $('#recMirror').onchange = e => $('#recPreview').classList.toggle('nomirror', !e.target.checked);
  $('#recGo').onclick = () => REC.recorder && REC.recorder.state === 'recording' ? stopRecording() : startRecording();
  REC.mode = 'clip';
  try {
    // ask once so device labels are populated
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    tmp.getTracks().forEach(t => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, key) => {
      const list = devs.filter(d => d.kind === kind);
      sel.innerHTML = list.map(d => `<option value="${d.deviceId}">${esc(d.label || kind)}</option>`).join('') || '<option value="">none</option>';
      const saved = localStorage.getItem(key); if (saved && list.some(d => d.deviceId === saved)) sel.value = saved;
      sel.onchange = () => { localStorage.setItem(key, sel.value); startPreview(); };
    };
    fill($('#recCam'), 'videoinput', 'kv.cam'); fill($('#recMic'), 'audioinput', 'kv.mic');
  } catch (e) { toast('Camera/microphone permission denied: ' + e.message, true); }
  applyRecMode();
  startPreview();
}
function applyRecMode() {
  const vo = REC.mode === 'voiceover';
  $('#recPreview').classList.toggle('hidden', vo);
  $('#recCam').closest('.field').classList.toggle('hidden', vo);
  $('#recQ').closest('.field').classList.toggle('hidden', vo);
  $('#recVoHint').classList.toggle('hidden', !vo);
  $('#recVoAt').textContent = fmt(playheadTime());
}
async function startPreview() {
  stopStream();
  const q = +$('#recQ').value;
  const constraints = {
    audio: { deviceId: $('#recMic').value ? { exact: $('#recMic').value } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    video: REC.mode === 'voiceover' ? false : { deviceId: $('#recCam').value ? { exact: $('#recCam').value } : undefined, width: { ideal: q === 2160 ? 3840 : q === 720 ? 1280 : 1920 }, height: { ideal: q === 2160 ? 2160 : q }, frameRate: { ideal: 30 } },
  };
  try {
    REC.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) { $('#recStatus').textContent = 'cannot open device: ' + e.message; return; }
  const v = $('#recPreview'); v.srcObject = REC.stream;
  const vt = REC.stream.getVideoTracks()[0];
  $('#recStatus').textContent = vt ? `${vt.getSettings().width}×${vt.getSettings().height} · ${pickMime(REC.mode).split(';')[0]}` : pickMime(REC.mode).split(';')[0];
  // level meter
  try {
    REC.ctx = REC.ctx || new AudioContext();
    const src = REC.ctx.createMediaStreamSource(REC.stream);
    const an = REC.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; const rms = Math.sqrt(s / buf.length); const db = 20 * Math.log10(rms || 1e-6); $('#recLvl').style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`; REC.raf = requestAnimationFrame(tick); };
    cancelAnimationFrame(REC.raf); tick();
  } catch { }
}
function stopStream() { cancelAnimationFrame(REC.raf); if (REC.stream) { REC.stream.getTracks().forEach(t => t.stop()); REC.stream = null; } }
function closeRecorder() { if (REC.recorder && REC.recorder.state === 'recording') return toast('Stop the recording first'); stopStream(); closeModal(); }

function startRecording() {
  if (!REC.stream) return toast('No input device', true);
  const mime = pickMime(REC.mode);
  REC.chunks = [];
  REC.recorder = new MediaRecorder(REC.stream, { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
  REC.recorder.ondataavailable = e => { if (e.data.size) REC.chunks.push(e.data); };
  REC.recorder.onstop = uploadRecording;
  REC.start = performance.now();
  if (REC.mode === 'voiceover') {
    REC.playFrom = playheadTime();
    if (mode !== 'timeline') setMode('timeline');
    if (P.preview && player.src) { player.currentTime = REC.playFrom; player.play().catch(() => { }); }
  }
  REC.recorder.start(250);
  $('#recGo').classList.add('on');
  REC.timer = setInterval(() => { $('#recTime').textContent = fmt((performance.now() - REC.start) / 1000); if (REC.mode === 'voiceover' && player.ended) stopRecording(); }, 100);
}
function stopRecording() {
  clearInterval(REC.timer); $('#recGo').classList.remove('on');
  if (REC.mode === 'voiceover') player.pause();
  if (REC.recorder && REC.recorder.state === 'recording') REC.recorder.stop();
}
async function uploadRecording() {
  const blob = new Blob(REC.chunks, { type: REC.recorder.mimeType || 'video/webm' });
  const secs = (performance.now() - REC.start) / 1000;
  if (secs < 0.5) return toast('Too short, discarded');
  const fd = new FormData();
  fd.append('file', blob, 'rec.' + (blob.type.includes('mp4') ? 'mp4' : 'webm'));
  fd.append('kind', REC.mode); fd.append('at', REC.mode === 'voiceover' ? REC.playFrom : 0); fd.append('add', 'true');
  fd.append('fit', $('#recCover').checked ? 'cover' : 'contain');
  $('#recStatus').textContent = `saving ${fmt(secs)} recording…`;
  await guard(async () => {
    const r = await api('POST', `/api/projects/${P.name}/record`, fd);
    setProject(r.project);
    toast(REC.mode === 'voiceover' ? `Voiceover added at ${fmt(REC.playFrom)}` : 'Recording added to timeline');
    if (r.id && REC.mode === 'clip') select(r.id);
    $('#recStatus').textContent = 'saved'; $('#recTime').textContent = '0:00.0';
  });
}

// ================================================================== voiceover lane
let selVo = null;
function renderVoLane() {
  const lane = $('#voLane'), track = $('#voTrack');
  const vos = P.voiceovers || [];
  lane.classList.toggle('hidden', !vos.length);
  track.innerHTML = '';
  if (!vos.length || !P.layout) return;
  const total = Math.max(P.layout.total, 0.1);
  for (const v of vos) {
    const el = document.createElement('div');
    el.className = 'vo' + (v.id === selVo ? ' selected' : '');
    el.style.left = `${v.at / total * 100}%`; el.style.width = `${Math.max(1.5, (v.duration || 1) / total * 100)}%`;
    el.textContent = `${v.id} ${fmt(v.at)}`; el.title = v.file;
    el.onclick = () => { selVo = v.id; sel = null; $$('#timeline .block').forEach(b => b.classList.remove('selected')); renderVoLane(); renderVoInspector(v); };
    track.appendChild(el);
  }
}
function renderVoInspector(v) {
  const el = $('#segInspector');
  el.innerHTML = `<h3>Narration</h3><div class="muted" style="margin-bottom:8px">${esc(v.file)} · ${fmt(v.duration || 0)}${v.lufs != null ? ` · ${v.lufs.toFixed(1)} LUFS` : ''}</div>` +
    field('Starts at (timeline)', `<div class="inline"><input type="text" id="voAt" value="${fmt(v.at, 2)}"><button class="btn small" id="voAtPh" title="use playhead">⟵ playhead</button></div>`) +
    field('Volume', `<input type="range" id="voVol" min="0" max="2" step="0.1" value="${v.volume}">`) +
    `<div class="check"><input type="checkbox" id="voDuck" ${v.duck_clips ? 'checked' : ''}><label for="voDuck">Duck clip audio under this</label></div>` +
    `<div class="row"><button class="btn small" id="voPlay">▶ Listen</button><button class="btn small danger" id="voDel">Delete</button></div><audio id="voAudio" src="${v.url || ''}"></audio>`;
  const patch = body => guard(async () => { setProject(await api('PATCH', `/api/projects/${P.name}/voiceovers/${v.id}`, body)); const nv = P.voiceovers.find(x => x.id === v.id); if (nv) renderVoInspector(nv); });
  $('#voAt').onchange = e => patch({ at: e.target.value }); $('#voAt').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#voAtPh').onclick = () => patch({ at: playheadTime() });
  $('#voVol').onchange = e => patch({ volume: +e.target.value });
  $('#voDuck').onchange = e => patch({ duck_clips: e.target.checked });
  $('#voPlay').onclick = () => { const a = $('#voAudio'); a.paused ? a.play() : a.pause(); };
  $('#voDel').onclick = () => guard(async () => { setProject(await api('DELETE', `/api/projects/${P.name}/voiceovers/${v.id}`)); selVo = null; renderInspector(); });
}
