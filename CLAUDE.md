# KrisVideos — notes for Claude

Daily-vlog editor. Python + ffmpeg core, FastAPI/vanilla-JS GUI, `vlog` CLI. See README.md.

## How to help Kris edit a vlog
The user wants to say things like "cut to a title card 'Lunch' at 0:32" or "mute the second clip
and speed it up" and have it happen. Do it by editing the project's `project.yaml` directly (the
GUI reloads it within ~3s) or with the CLI, then run a preview:

```sh
vlog show 2026-10-22                      # see ids, timeline times, source in/out
vlog title-at 2026-10-22 0:32 "Lunch"     # timeline-time → splits the clip there
vlog cut 2026-10-22 0:12 0:15             # "cut out 12 to 15 s": ripple delete in timeline time
vlog keep 2026-10-22 0:12 0:15            # "keep just 12–15 s of that clip": trim to the range
vlog image 2026-10-22 ~/Desktop/map.png --at 0:31 --for 4 --size small --pos tr   # picture over the video
vlog set 2026-10-22 s4 mute=true speed=1.5
vlog preview 2026-10-22                   # out/preview.mp4 (half-res, seconds)
vlog render 2026-10-22 --open             # final 1080p
```
Title cards: `title:` (+ `subtitle`, `kicker` small line above, `bg`/`fg`, `layout`) or `image:`
(a still, `fit: contain|cover`; text optional). New vlogs start with the intro from `cli.add_opening`:
masthead image card → fade → black card (`bg: '#000000'`, its length = hold + both fades) → date
card with kicker "Daily Vlogs". The masthead lives in config (`masthead_image`) and is copied to
`<project>/assets/`. A camera take recorded with the playhead at a segment's start is inserted in
front of that segment (so recording at 0:00 puts Kris before the masthead); otherwise it appends.
`project.stings` are the music: cues anchored to segment ids (`from`/`to`, `start` offset into the
file, fade in/out, `loop`, `credit` text + `credit_pos`/`credit_for`); `render.sting_span` maps them
to timeline times; they are mixed before the (legacy, looping) music bus and never duck clips.
`edits.split_segment`/`cut_range` keep a cue over both pieces of a split clip; `edits.split_sting`
splits a cue at a timeline time into two seamless pieces (splitting the clip there), `continue_sting`
/`last_cue_with` pick a song up where it stopped. Server: `POST stings` takes `from`/`to`, `range:
[a, b]` (splits the clips at both ends) or `whole: true`, plus `continue: true`; `POST stings/{id}/
split {at}` and `/continue`. When Kris says "put music over 0:32 to 1:10" → `vlog sting PROJ song
--range 0:32 1:10`; "split the music here" → `vlog sting PROJ split --id m1 --at T`; "the music
should keep going into the next clip" → `--continue` or change `to`. A credit (license text) on a cue
is drawn by `titles.render_credit` in a corner (`style.credit_position`/`credit_seconds` defaults)
when the cue starts; `render.credit_spans` lists them. `project.music` (the green loop under
everything) still exists for old projects; the GUI offers "Turn into music over the clips". GUI menu
(`musicMenu`): "Continue the intro song here" is the default (target = marked range > selected clip >
clip under the playhead), "Other music here…" opens `musicSheet` (song picker, `GET/POST
/api/projects/{name}/songs`, draggable start window with audition).
The intro sting comes from config `intro_sting`.
Renaming: `edits.retitle(p, title)` (cards showing the old title follow), `edits.redate(p, date, new_name)`
(the opening date card and a title that was just the date follow), `cli.move_project` renames the folder;
`POST /api/projects/{name}/rename {title?, date?, name?, today?}` returns `{project, name}`; GUI: switcher
"Rename this vlog…" / "Move this vlog to today". When Kris says "I forgot to make yesterday's vlog, make this
one today's" → `vlog rename PROJ --today`; "call it Lake day" → `vlog rename PROJ --title "Lake day"`.
Projects live in `~/Vlogs/<name>/` (configurable: `vlog config`). Times in the YAML are
*source-clip* seconds for `in`/`out`; `vlog title-at` takes *output-timeline* time.
`in`/`out` accept `12.5` or `0:12.5`. Segment ids (`s3`) are stable; the GUI shows them in `vlog show`.

Markers are `segment.markers` (source-clip seconds, so trims/splits keep them on their moment):
Space during a recording posts them to `record/{id}/marker` (kept in the recording manifest, so
recovered takes keep them); `finalize_recording` puts them on the new clip, or for narration on
the clips that were playing. `vlog show` prints them in timeline time (`markers@1:02.1,…`): when
Kris says "add these pictures at my markers", place `images` entries at those times.

Pictures over the video are `project.images` (`ImageLayer`: `at`/`for` in timeline time, `box`
x/y/w fractions or none for full screen, `fit`, `fade`); `render.py` overlays them on the joined
picture (PNG from `titles.render_layer`), the GUI shows them on the pink lane above the clips and
in the player (`paintLayers`, drag/resize in `layerPointer`). Server `commit()` runs
`edits.follow_content(before, after)` so pictures and voiceovers stay on their frames through any
clip edit (except raw script saves); CLI trim/rm/move do the same.

Picture in picture: a clip segment may carry `pip:` (`Pip`: `clip`, `offset`, `speed`, `box` x/y/w[/h]
fractions, `fit`, `shape` round|rect|circle, `hidden`) and `box:` (where the main picture goes; None =
whole frame). pip time = `offset` + `speed` × main source time (`Pip.time`), so trims/splits never
touch it and the inset can run at its own speed (a 4x timelapse in a frame); `edits.swap_pip` exchanges
the two (mapping in/out/markers through offset/speed and keeping the piece's length),
`edits.insert_pip(p, t, src, in, out, speed, layout, pos)` puts a video over the clip at
timeline time `t` (splits the clip so it comes in at `t` and goes away when the in→out part ends; with no
`out` the file's whole length is used, so it never runs past its footage); layout `full` = B-roll (the inset
covers the picture: `box (0.5,0.5,1,1)`, rendered as a plain overlay with no mask/shadow) while the clip's
sound carries on; `Pip.volume` (0 = silent, default) mixes the inset's own sound in, level-matched like a
clip (`amix` after the clip's chain). Server `POST segments {kind: "pip", src, at_time, in, out, speed,
layout: "full" | "corner:br", volume?}`; `PATCH segments/{id} {pip: {volume}}`; CLI `vlog frame PROJ file
--at 0:32 --layout full [--in 0:05 --out 0:20 --speed 4 --sound 0.3]`, `vlog pip PROJ s3 --layout full
--sound 0.5`; the trimmer's targets "Over the video at the playhead" (default label) and "In a small frame…"
use it. When Kris says "put this clip over the video while I keep talking" → `--layout full` (sound off);
"let me hear it a bit" → `--sound 0.3`. When the footage runs out before the clip piece does (a trim that
outgrew it), the inset dissolves out over `render.PIP_FADE` (0.5 s, alpha fade + `eof_action=pass`, its sound
`afade`s with it) and the clip shows again; the live player mirrors it (`syncPip`: `pend`, `PIP_FADE`) and
never calls play() on an ended `<video>` (that restarts it from frame 0: the old first/last-frame flicker).
A full inset can't be dragged. Clip `speed` takes any positive number
(GUI: log slider 0.1–1000× + typed number); above `render.MUTE_ABOVE` (20×) the clip's audio is
dropped; the live player steps frames for clips faster than 16× (`VP.drive`). `edits.pip_layout(seg, corner|corner-large|stacked|hidden,
(W, H), aspect, pos)` sets the standard layouts (the JS `pipLayoutBoxes` mirrors it). `render.py` places
the main in its box (scale + pad) and overlays the inset (Pillow mask PNG + `alphamerge`, shadow PNG).
Screen takes: the recorder's *Screen* tab records the shared screen and the camera as two
MediaRecorders in one session (`record/start` body `pip: {...}`, chunks with `?track=pip`,
`record/{id}/sync` posts the start offset); `finalize_recording` ingests both (`REC_<id>-screen.mp4`,
`REC_<id>-cam.mp4`) and builds the segment. GUI: `VP.syncPip` shows the inset from its proxy in
`#pipBox` (drag/resize → `PATCH segments/{id}` `pip: {box}`); inspector `pipInspectorHtml` uses
`pip_layout: "corner:br"`, `pip_swap`, `pip: null`. CLI: `vlog pip`; `vlog show` prints `pip=…`.
When Kris says "show the screen big and me small" → `pip_layout corner` (or `--swap` first if the
camera is the main clip); "put me on top" → `stacked`; "just the screen" → `hidden`.

Timeline edits in output time live in `edits.py` (`split_segment`, `insert_index_at`, `title_at`,
`cut_range`, `keep_range`, `set_in`): they keep overlays on their frames and move voiceovers with
their pictures. Server: `POST /split` `/cut` `/keep`; `POST /segments` takes `in`/`out` and
`at_time` (insert at a timeline time, splitting there) and returns `new_id`. Imports take
`add: false` (Immich jobs report `added`) so the GUI can open the clips in the trimmer instead.

Preparing clips (`media.prepare`, run by `prepare_async` at low priority via `_nice`): thumbnail, loudness
(`_audio_stats` uses `ebur128`, not `loudnorm`'s measuring mode which is 10× slower), the loudness after the
voice polish measured *without* the denoiser (`voice_chain(..., measure=True)`: loudness-neutral, seconds per
minute saved), and a proxy only when `media.needs_proxy(info)` (= not `browser_playable`: HDR, HEVC, >1080p).
`filmstrip` decodes keyframes only with `-hwaccel videotoolbox -skip_frame nokey` when the frames are ≥
`KEYFRAME_STRIP_SPACING` apart (falls back to a full decode). The Immich job downloads everything, makes
thumbnails and calls `prepare_async`; nothing waits on a transcode. The GUI trimmer (`TR.items`) plays a
clip's own file when the browser can (`canPlaySource`: HEVC on a Mac) instead of waiting for a proxy.
Trimmer queue: each item keeps `in/out/speed/take`; Enter = `trQueue`, N = `trSkip`, deciding the last one
runs `trAddAll` → `POST /api/projects/{name}/segments/batch {items: [{src, in, out, speed}], at_time?}`
(one undo step; `POST /segments` kind clip also takes `speed`). The preview plays at the item's speed
(`trRate`; >16× is stepped).

GUI timeline (`app.js`): blocks get log-scaled widths (`layoutTimeline`, `TL`), time is linear
inside a block, and `tToX`/`xToT` map everything (ruler, lanes, marks, playhead). Marks are `MK`
(timeline time). The trimmer (`openTrimmer`, `TR`) is the source viewer for import queues, library
clips and re-trimming a timeline clip. Mic warnings: `micQuality` (GOOD_MIC / BAD_MIC label regexes
plus trusted labels in localStorage `kv.goodMics`).

GUI player: `web/app.js` `VP` plays the timeline live from clip proxies (two `<video>` layers +
two HTML title-card layers so fades/dips crossfade; `AUD` plays music + narration `<audio>` with
approximate ducking and per-clip LUFS gain) and switches to `out/preview.mp4` when it is newer
than project.yaml. Timeline blocks show per-range filmstrips (`GET /strip`) and waveforms
(`GET /wave`). Every mutating endpoint goes through `commit(p)` which records undo history
(`cache/history.json`, `POST /undo` `/redo`, `vlog undo`). Segment joins: runs of cuts use one
`concat` with v+a together; fades join runs with xfade/acrossfade.
Recording: MediaRecorder chunks are POSTed to `record/start` → `record/{id}/chunk?seq=n` (appended
+ fsynced to `cache/recordings/<id>.part`) → `record/{id}/finish`; `GET /recordings` lists
unfinished sessions for recovery. The legacy one-shot `POST /record` still exists;
`media.ingest_recording` *remuxes* a browser-playable take (`-c copy`, milliseconds) to `clips/REC_*.mp4`
(or `.webm`), makes the thumbnail, and leaves proxy + loudness to `prepare_async`; it only transcodes
when the copy fails (odd codec, HDR, >1080p). Voiceovers become `audio/VO_*.m4a`. Until a proxy
exists, `project_json` reports the source itself as `proxy_url` for `media.browser_playable` files. Voiceovers are
`project.voiceovers` (output-timeline `at`), mixed in `render.py` after the segment join with
sidechain ducking of clip audio; music ducking keys off that bus. Level matching uses cached
per-file LUFS (`cache/*.loud.json`, `media.measure_loudness`) with ±12 dB gain toward
`audio.target_lufs`. `fit: cover` clips are excluded from the auto-orientation vote.
Clip `channel:` (auto | stereo | left | right | mix): `media.audio_analysis` measures per-channel RMS with
the LUFS pass (`cache/<name>.loud.json`, `one_sided`), `media.effective_channel` resolves `auto` (a one-sided
take → that channel to both ears, via `media.CHANNEL_PAN` in render.py's clip audio chain; LUFS for the
gain are measured on that result, `cache/<name>.loud.<ch>.json`); the live player routes the element through
Web Audio (`VP.route`) and the inspector has a *Channels* select. When Kris says "my mic only recorded on
the right / the audio is only in one ear" → `vlog set PROJ sN channel=right` (auto usually already did it;
`vlog show` prints `audio=auto→right to both ears`).
Voice polish: `media.voice_chain(denoise, model, pregain)` (pre-gain to -23 LUFS, highpass 90 Hz, anlmdn
denoise or arnndn if `<config>/rnnoise.rnnn` exists, deesser, EQ 250/3k/9k, acompressor 2.5:1) goes on every
clip and voiceover when `audio.polish` (default on; `segment.polish`/`voiceover.polish` auto|on|off override,
`render.polish_on`); level matching uses the loudness measured after the chain (`media.voice_filters`, cache
`*.loud[.ch].voice.json` keyed by the chain string) and `media.VOICE_LIMITER` follows the gain. GUI: inspector
*Voice* select, settings *Polish voices* + *Noise reduction*; the live player approximates with pre-gain + EQ
(`VP.route(el, mode, fx)`). CLI: `vlog set PROJ s4 polish=off`, `vlog set PROJ audio polish=off denoise=6`.
When Kris says "my audio sounds muffled/noisy/harsh" → check polish is on, raise/lower `denoise`; "leave this
clip as recorded" → `polish=off` on that segment. A take remembers its microphone (`segment.mic`: the browser's
device label, sent by the recorder as `record/start {mic}`, kept in the manifest); `render.polish_on(p, setting, mic)`
treats `auto` as off for a good mic (`media.good_mic`, the Python twin of app.js `GOOD_MIC`: DJI, Rode, Shure, interfaces…),
so DJI takes stay as recorded and the Anker webcam-class takes get polished. Clips imported from files have no `mic`.
`finalize_recording` writes `polish: off` onto a good-mic take so the decision is remembered on the clip itself;
changing it needs an explicit force: `PATCH segments/{id} {polish: "on", force: true}` (409 without it), the GUI's
Voice select asks "Clean it up anyway?", `vlog set PROJ sN polish=on --force`. Mics Kris marks as good in the recorder
("trust this mic") go to config `good_mics` (`PUT /api/settings {good_mics}`) and count like the built-in list
(`media.good_mic(label, cfg.good_mics)`; segment JSON `good_mic`). Level matching (gain only) still applies to them.
On 2026-11-15 Kris wanted the polish off "most of the tracks": the one-channel takes were the DJI receiver, the stereo
desk take the Anker, so `audio.polish: false` + `polish: on` on the Anker pieces.
The polished sound of each clip is cached as `cache/<name>.voice.<ch>.<hash>.flac` (`media.polished_audio`, 16-bit,
written `VOICE_HEADROOM` down): the denoiser is single-threaded at ~9× realtime and ffmpeg runs the whole filter graph
in one thread, so with it inline a 15-min export took 25 min. `media.prepare` builds it in the background after import;
`render.render` builds the missing ones in parallel first (`render.voice_jobs` → `media.polish_many`, `status()` →
`job.message` "polishing voice tracks…"); `build_plan` uses the file as an extra `-ss in -t len -i` input when it is
there, else the inline chain (same sound within 0.1 dB). Faster-than-1× clips and insets put `fps=N` right after the
`setpts` speed change so the HDR tone-map / scale only see kept frames (a 4× HDR B-roll: 0.5× → 1.6× realtime).
Jobs: `POST render` while an export runs returns the running job (the GUI joins it; a preview no longer cancels an
export); `openProject` re-attaches to a running job after a reload (`GET /api/jobs`).
The final master (`render.MASTER_LUFS` -16) is a static gain + true-peak limiter when `match_levels` is on
(single-pass `loudnorm` is an AGC that pumped room noise up between phrases); `loudnorm` only when it is off.
Lens correction (the wide-angle webcam's barrel distortion): a take remembers its camera
like its mic (`segment.cam`: the browser's device label, sent by the recorder as `record/start {cam}`, kept in the
manifest; on a screen take it goes on whichever picture came from the camera, `Pip.cam` for the inset, and
`edits.swap_pip` moves it along). Config `lenses: [{match, k1, k2}]` (`match` = substring or regex on the camera label,
`config.lens_for`, `clean_lenses`; `PUT /api/settings {lenses}`, `vlog config lenses='[{match: Anker, k1: -0.12}]'`) says
how to straighten each camera; a clip can say `lens: off` or carry its own `lens: {k1, k2}` (`Segment.lens`: None =
the camera's entry, "off", or a tuple; `project.lens_value` parses all spellings; `PATCH segments/{id} {lens: null |
"off" | {k1, k2}}`, `vlog set PROJ sN lens=-0.12,0.02|off|auto`). `render.lens_params(seg.lens, seg.cam, cfg.lenses)` →
`render.lens_filter` puts `lenscorrection=k1=..:k2=..:i=bilinear` in the clip's `vchain` right after the speed `setpts`
and before the scale (after the HDR tone-map for HDR sources: the filter is 8-bit); the inset's `pchain` gets it for
`pip.cam`. `build_plan(..., lenses=)` defaults to `Config.load().lenses`. Segment JSON: `cam`, `lens` (own setting),
`lens_effective` (what the export applies), `lens_source` (camera | clip | off), `lens_match` (the config entry hit).
`vlog show` prints `cam='…'  lens=-0.120,+0.020 (camera|this clip)`. GUI inspector *Lens*: k1/k2 sliders
(-0.5…0.5, step 0.005), mode *For this camera* (rewrites the matching `lenses` entry, or adds one named after the
label) / *Every clip in this vlog* (`POST segments/patch {ids: all clips, patch: {lens}}`; `lensModeOf` reads it back
as `all` when every clip carries the same own setting) / *This clip only* / *No correction*; a clip with no `cam` gets a
*shot with…* select (`knownCameras()`: the vlog's takes, the config entries, the browser's cameras → `PATCH {cam}`),
the multi-selection inspector has a *Lens (every clip)* row (same as the first / each camera's own / off), the recorder
shows `#recLens` under the camera (straightened, or "straighten it…" → `openCalibration`), and a corrected still from
`GET /api/projects/{name}/frame?src&t&k1&k2&w`
(one ffmpeg JPEG, cached in `cache/<name>.frame.<t>.<k1>.<k2>.<w>.jpg`, debounced 250 ms). The live player applies it
too: `VP.lensApply(video, k, fit)` lays a WebGL canvas twin (`canvas.lensgl`, shader = the lenscorrection formula,
r² = 4(dx²+dy²)/(w²+h²)) over the `<video>` (which keeps playing with `visibility: hidden`; the twin copies its
opacity/geometry each frame, so fades and boxes still work); `present` uses `segment.lens_effective`, `syncPip` the
inset's `pip.lens_effective` (pip JSON), the inspector sliders preview through `VP.lensOverride(segId, k)`.
Automatic calibration (`calib.py`): `GET /calibration` is a printable 10×7 checkerboard (24 mm squares,
`calib.pattern_png`); the GUI sheet `openCalibration(camLabel)` (inspector "Measure it automatically…", settings
"Straighten a camera lens…") opens the camera, POSTs a JPEG every 650 ms to `POST /api/calibration/{id}/frame`
(`/start {cam}` first); `calib.find_board` (OpenCV `findChessboardCornersSB`) returns the inner corners, each
distinct view (centroid moved ≥3 % of the width) is kept, `coverage` is a 3×3 grid; `/solve` runs `calib.fit`
(plumb-line: `undistort_points` inverts ffmpeg's dst→src model by Newton, `straightness` = RMS distance of each
board row/column from its best-fit line, coarse grid over k1 ∈ [-0.6, 0.3] × k2 ∈ [-0.3, 0.3] then three refinements)
→ `{k1, k2, rms_before, rms_after, improvement, boards, coverage}`; the sheet auto-solves once the grid is covered
(≥6 views, or 14 anywhere), shows the live picture corrected through the same WebGL twin, and `/save` writes the
entry via `calib.save_lens` (updates the `lenses` entry the label already falls under, else adds `{match: label}`).
`/preview.jpg?k1&k2` remaps the last frame with `cv2.remap` (same model). CLI `vlog calibrate CAM img...`
(`--pattern out.png`, `--dry-run`). Synthetic check: a board distorted with `lenscorrection=k1=0.22:k2=0.05` fits to
k1 ≈ -0.206, lines 0.56 → 0.035 px; ffmpeg with the fit → 0.02 px. When Kris says "the webcam makes the walls bend /
fix the fisheye" → calibrate (or set the camera's entry, k1 ≈ -0.1 … -0.2 for a 110° webcam, k2 small); "leave this
clip as shot" → `lens=off`.

Selection, groups, unlinked sound (GUI `SELS` set + primary `sel`/`selVo`; `select(id, {toggle, range})`,
`selectVo`, `selectAll`, `paintSelection`): click = the clip and its group, ⌘-click toggles, ⇧-click = the range of
timeline indices from the last clicked (`selAnchor`); `renderMultiInspector` for >1 selected (Group ⌘G / Ungroup ⇧⌘G
→ `POST segments/group|ungroup {ids}`, Mute, Unlink/Link ⌘L, Delete ⌫ → `POST segments/remove {ids}` (segments and
vN layers, one undo step, `edits.remove_many`), speed/voice/transition for all → `POST segments/patch {ids, patch}`
(`apply_patch` = the PATCH body applied per segment), Move ←/→ = `moveSelection`); drag-and-drop moves the whole
selection; `Segment.group` is a tag (`edits.group` → `p.next_group()`, `ungroup`); `.block.grouped` draws a coloured
bar (`--gc`). Unlinking: `edits.detach_audio(p, sid)` turns the clip's sound into a `Voiceover` of `kind: clip`
(`file`=the clip, `in`/`out`/`speed`/`channel`/`mic`/`from` = the segment id, `at` = its timeline start; the clip
gets `mute: true`), `relink_audio(p, vid)` reverses it; `POST segments/{sid}/unlink` → `new_id`, `POST
voiceovers/{vid}/link` → `seg_id`; `PATCH voiceovers/{vid}` also takes `in`/`out`/`speed`/`channel` for that kind;
segment JSON `audio_unlinked` (layer id), `group`; layer JSON `kind, from, from_present, in, out, speed, channel,
mic, duration, url (proxy/src), lufs, channel_effective, polished, pregain`. GUI: A1 block of an unlinked clip is
hatched "⛓ on A2"; kind-clip layers draw on an **A2** lane (`.snd`, waveform from `/wave?start&end`, rows packed when
they overlap, `voDrag` moves them in time → `PATCH {at}`), narration stays on VO; `AUD` plays them from the clip's
proxy/src at `in + (t-at)·speed`, `playbackRate = speed`, routed like a clip. `render.py` already mixes kind-clip
layers through `sound_chain` (`-ss in -t len` input). `edits.follow_content` keeps them on their frames through clip
edits. CLI `vlog group|ungroup PROJ s3 s4`, `vlog unlink PROJ s3`, `vlog link PROJ v2`; `vlog show` prints
`group=g1` and `SOUND … (unlinked from s3)`. When Kris says "move these three together" → group them; "I want the
sound of this clip under the next one" → unlink, drag the A2 block (or `PATCH at`).

Parallel export (`render.render(p, mode, workers=)`, config `render_workers` 0 = one per core, `--workers` on
preview/render, settings `render_workers`): `render_parallel` cuts the timeline into shards at safe points
(`shard_bounds`: candidates every half second on whole frames outside `no_split_zones` — transitions, title cards,
caption/picture/credit fades, inset dissolves, global fades, `EDGE_GUARD` 0.6 s; never < `MIN_SHARD` 4 s, about
`SHARDS_PER_WORKER` 3 per worker), runs one video-only ffmpeg per shard (`build_plan(..., window=(t0, t1),
part="video")` → `<project>/cache/render/<mode>/vNNN.mp4`) on a thread pool plus one audio-only pass
(`part="audio"` → `audio.m4a`), then stitches with the concat demuxer `-c copy`. Exactness: every segment is cut to
`nf = round(end·FPS) − round(start·FPS)` frames (`fps=N,tpad=stop=3:stop_mode=clone,trim=end_frame=nf`, inputs read
+0.25 s spare), so shards match a single pass frame for frame (PSNR ≥ 43 dB vs serial in tests) and never drift from
the audio; `window_layout` clips the layout to a window (`Placed.skip`/`cut_end`, captions and `timed_overlay` images
/credits clipped, global fade-in only in the first window / fade-out in the last); inputs get `-an`/`-vn` so a video
shard never decodes sound; `_hwdec` adds `-hwaccel videotoolbox` for HDR HEVC. A 15-min real vlog: ~8 min single
pass → 185 s (≈4.9× realtime) on 14 cores. `workers=1` is the old single pass (tests that inspect the graph use it).
Two export bugs found on 2026-11-19 (the picture ran 1.7 s ahead of the sound by the end, and an unlinked take's sound
played over the intro): (1) a screen take stores a frame only when the screen changes (a still screen: one a second,
`REC_*-screen.mp4` is VFR), and a browser take's sound outlasts its picture by up to a second, so a piece whose seek
landed in such a gap, or ran past the last frame, came out short (`tpad=stop=3` padded 3 frames) and every later
picture was early. Every clip (and inset) is now read from `SEEK_BACK` (3 s) before its in point and never past
`probe.video_end - 1` (`_lead_in`), and `_grid_chain` heads the video chain with `fps=FPS/speed` (the grid first: gaps
are filled by cloning, a faster clip is decimated before the tone-map/scale), `tpad=stop=N:stop_mode=clone` (the last
frame cloned on for as long as the piece needs), `trim=start=back:end=…` (the lead-in off again), `settb=AVTB` (fps
leaves a 1/rate timebase that would wreck the later `setpts=PTS/speed`), `setpts=PTS-STARTPTS`; the `exact` tail pads
with `tpad=stop=nf`; the sound read along with the picture gets `atrim=start=back`; `window_layout` drops a piece that
rounds to no frame. (2) ffmpeg 7.1's `adelay` stamps the silence it inserts with garbage pts when its input was seeked
(`-ss`: an unlinked AAC take, a polished cache read from its in point), so the layer played at 0: every delay goes
through `_delay(seconds)` = `adelay=…:all=1,asetpts=N/SR/TB`. Kind-clip layers also end at their out point
(`atrim=duration`). Scratchpad tests: `test_vfr.py` (frame gaps / short footage, serial = parallel), `test_layers.py`
(layer placement, raw and polished).

## Development
- `uv sync`; run with `.venv/bin/vlog ...`; GUI: `.venv/bin/vlog serve --port 8799`.
- Test with synthetic clips (`ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30 ...`) and
  `KRISVIDEOS_CONFIG_DIR=<tmp>` so the real config/vlogs are untouched.
- `vlog preview PROJ --dry-run` prints the ffmpeg command. Rendering goes through one
  `filter_complex`; segments are joined pairwise with `concat` (cut) or `xfade`/`acrossfade`.
  Every segment must end at `settb=AVTB`, `yuv420p`, 48k stereo, with `fps=N` placed *after*
  trim/setpts/fade (those drop the constant-frame-rate flag and xfade then refuses the input).
- This ffmpeg (Homebrew 9.x) has **no drawtext/zscale**: all text is Pillow PNG overlays
  (`titles.py`), HDR→SDR goes through VideoToolbox `scale_vt` with a swscale fallback.
- `ffmpeg -vsync` is gone; use `-fps_mode`.
- Rebuild the app bundle after moving the repo: `uv run python scripts/make_app.py`.
