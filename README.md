# KrisVideos

Push-button daily-vlog editor for Mac. Clips come in from Immich (or Finder), you tap a
few buttons (or tell Claude what you want), and a finished 1080p video comes out.

- **One file is the edit.** Every vlog is a folder with a readable `project.yaml`
  (clips, trims, title cards, captions, music). The GUI, the `vlog` CLI, and Claude all
  edit that same file.
- **ffmpeg does the work**, hardware-accelerated on Apple Silicon. A 3-minute vlog renders
  in well under a minute; previews take a few seconds.
- **iPhone-friendly**: HEVC, HDR (HLG/Dolby Vision) and portrait clips are normalized to
  SDR H.264 with correct orientation; mixed portrait/landscape is letterboxed.

## Install

```sh
brew install ffmpeg uv          # already done on this machine
cd ~/projects/krisvideos
uv sync                         # creates .venv
uv tool install -e .            # puts `vlog` on your PATH
uv run python scripts/make_app.py   # builds dist/KrisVideos.app
```

Drag `dist/KrisVideos.app` to Applications (or run it from `dist/`). It starts the local
server and opens the GUI in a chromeless Chrome window. Or run `vlog serve --open`.

Settings (gear icon, or `vlog config key=value`) live in `~/.config/krisvideos/config.yaml`:
Immich URL + API key (Immich → Account settings → API keys), the vlogs folder
(default `~/Vlogs`), default subtitle, music, orientation.

## Daily flow

1. **New** → today's date. You get an opening title card automatically.
2. **Immich tab** → Load → *Add all to timeline* (or drag individual clips in).
3. Click clips to trim (Clip mode: scrub, press `I`/`O`), type captions, drag to reorder.
4. Press **Preview** (⌘⏎). Scrub it; press `T` to *cut to a title card here*, `S` to split.
5. Press **Render** → *Show in Finder* → AirDrop / iMessage.

Keyboard: `space` play · `I`/`O` in/out · `T` title at playhead · `S` split · `C` toggle
Clip/Timeline · `⌫` delete · `↑↓` select · `←→` frame step · `⌘⏎` preview · `⇧⌘⏎` render.

## The script (`project.yaml`)

```yaml
title: Thursday, October 22
output: {orientation: auto}          # auto | portrait | landscape | square
style: {transition: cut}             # cut | fade | dip ; also fade_in/out, fonts, colors
music: {file: ~/Music/lofi.mp3, volume: 0.18, duck: true}
timeline:
- title: Thursday, October 22
  subtitle: a daily vlog
  duration: 3
- clip: clips/IMG_4821.MOV
  in: 0:03                           # source-clip times; seconds or m:ss
  out: 0:14
  caption: coffee first              # lower-third for the whole clip
- title: Lunch
  duration: 2
  transition: dip                    # transition *into* this segment
- clip: clips/IMG_4830.MOV
  speed: 1.5
  mute: true
  overlays:
  - {text: look at this dog, at: 1.5, for: 3, style: big, position: center}
```

## CLI

```
vlog new [2026-10-22] [--title "..."]      vlog pull 2026-10-22 [--date ...]   (from Immich)
vlog add PROJ file.mov ...                 vlog show PROJ
vlog title PROJ "Lunch" [--sub ..] [--dur 2] [--at INDEX]
vlog title-at PROJ 0:32 "Lunch"            split at 0:32 on the output timeline, insert card
vlog caption PROJ s3 "coffee first" [--at 2 --dur 3]
vlog trim PROJ s3 --in 0:03 --out 0:14     vlog set PROJ s3 speed=1.5 mute=true transition=fade
vlog rm PROJ s3 · vlog move PROJ s3 0 · vlog music PROJ file.mp3 [--volume 0.2]
vlog preview PROJ [--open] · vlog render PROJ [--open] · vlog serve [--open]
```
`PROJ` is a folder name under `~/Vlogs` (or a path). Segments are addressed by id (`s3`) or index.

## Layout

```
src/krisvideos/
  project.py   schema + YAML + timeline edits      render.py   ffmpeg graph builder / runner
  titles.py    Pillow title cards & captions       media.py    import, proxies, thumbnails
  immich.py    Immich REST client                  server.py   FastAPI backend
  cli.py       `vlog`                              web/        the GUI (vanilla JS)
scripts/make_app.py   builds dist/KrisVideos.app
```
Each vlog folder: `project.yaml`, `clips/` (originals), `cache/` (proxies, thumbs, title
PNGs, probe json), `out/` (`preview.mp4`, final `<title>.mp4`).
