# KrisVideos — notes for Claude

Daily-vlog editor. Python + ffmpeg core, FastAPI/vanilla-JS GUI, `vlog` CLI. See README.md.

## How to help Kris edit a vlog
The user wants to say things like "cut to a title card 'Lunch' at 0:32" or "mute the second clip
and speed it up" and have it happen. Do it by editing the project's `project.yaml` directly (the
GUI reloads it within ~3s) or with the CLI, then run a preview:

```sh
vlog show 2026-10-22                      # see ids, timeline times, source in/out
vlog title-at 2026-10-22 0:32 "Lunch"     # timeline-time → splits the clip there
vlog set 2026-10-22 s4 mute=true speed=1.5
vlog preview 2026-10-22                   # out/preview.mp4 (half-res, seconds)
vlog render 2026-10-22 --open             # final 1080p
```
Projects live in `~/Vlogs/<name>/` (configurable: `vlog config`). Times in the YAML are
*source-clip* seconds for `in`/`out`; `vlog title-at` takes *output-timeline* time.
`in`/`out` accept `12.5` or `0:12.5`. Segment ids (`s3`) are stable; the GUI shows them in `vlog show`.

Recording: the browser's MediaRecorder posts a webm/mp4 blob to `POST /record`;
`media.ingest_recording` transcodes it to `clips/REC_*.mp4` or `audio/VO_*.m4a`. Voiceovers are
`project.voiceovers` (output-timeline `at`), mixed in `render.py` after the segment join with
sidechain ducking of clip audio; music ducking keys off that bus. Level matching uses cached
per-file LUFS (`cache/*.loud.json`, `media.measure_loudness`) with ±12 dB gain toward
`audio.target_lufs`. `fit: cover` clips are excluded from the auto-orientation vote.

## Development
- `uv sync`; run with `.venv/bin/vlog ...`; GUI: `.venv/bin/vlog serve --port 8799`.
- Test with synthetic clips (`ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30 ...`) and
  `KRISVIDEOS_CONFIG_DIR=<tmp>` so the real config/vlogs are untouched.
- `vlog preview PROJ --dry-run` prints the ffmpeg command. Rendering goes through one
  `filter_complex`; segments are joined pairwise with `concat` (cut) or `xfade`/`acrossfade`.
  Every segment must end at `settb=AVTB`, `fps=N`, `yuv420p`, 48k stereo, or xfade breaks.
- This ffmpeg (Homebrew 9.x) has **no drawtext/zscale**: all text is Pillow PNG overlays
  (`titles.py`), HDR→SDR goes through VideoToolbox `scale_vt` with a swscale fallback.
- `ffmpeg -vsync` is gone; use `-fps_mode`.
- Rebuild the app bundle after moving the repo: `uv run python scripts/make_app.py`.
