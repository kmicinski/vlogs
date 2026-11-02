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
`project.stings` are music cues anchored to segment ids (`from`/`to`, `start` offset into the file,
fade in/out); `render.sting_span` maps them to timeline times; they are mixed before the music bus
(so music ducks under them) and never duck clips. The intro sting comes from config `intro_sting`.
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

Picture in picture: a clip segment may carry `pip:` (`Pip`: `clip`, `offset`, `box` x/y/w[/h] fractions,
`fit`, `shape` round|rect|circle, `hidden`) and `box:` (where the main picture goes; None = whole frame).
pip time = main source time + `offset`, so trims/splits never touch it; `edits.swap_pip` exchanges the
two (shifting in/out/markers by the offset), `edits.pip_layout(seg, corner|corner-large|stacked|hidden,
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
