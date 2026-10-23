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

1. **Project name ▸ New vlog** (⌘N). You get an opening title card automatically.
2. **+ Add ▸ From Immich** → pick the day → *Add all*.
3. Scrub the timeline (drag the ruler or the bar under the player). The player plays the
   timeline **live from proxies**, including title cards, captions, crossfades, music and
   narration, so there is nothing to wait for. Press `T` to cut to a title card at the
   playhead, `S` to split, `I`/`O` to trim to the playhead, or drag the blue handles on a
   selected clip (they snap to the playhead). Click a block for the inspector (captions,
   speed, fit, title colors and layout…). ⌘Z undoes anything. ⌘-scroll zooms.
4. **Render preview** (⌘⏎) for the exact ffmpeg output; the player switches to it
   automatically while it's up to date.
5. **Export ▾** → pick a preset (Share 1080p, Small 720p, HEVC, 4K) → *Show in Finder*.

A new vlog can pull that day's clips from Immich automatically (checkbox in *New vlog*),
in the order they were shot.

### Recording in the app
Press **⏺ Record** (or `R`). Pick any camera and microphone the Mac sees (built-in, USB
camera, capture card, audio interface). Recordings stream to disk every half second while
you record; if anything crashes mid-take, the app offers to **Recover** the partial take on
the next launch. Two modes:

- **Camera clip**: a talking-head segment that lands on the timeline like any other clip.
  "Crop to fill frame" (default for portrait vlogs) center-crops a 16:9 camera into 9:16.
- **Voiceover**: the preview plays from the playhead while you talk. The narration becomes a
  layer on the *Narration* lane under the timeline, starting at that time; clip audio is
  ducked under your voice. Wear headphones. Narration layers are `voiceovers:` in the YAML.

Audio mixing: every clip and voiceover is measured (LUFS) on import and auto-gained toward
a common level (*Match clip & voice levels*), music ducks under speech, and the final mix
is loudness-normalized. Per-clip volume/mute and fit are in the inspector.

Keyboard: `space` play · `I`/`O` trim start/end to playhead · `T` title here · `S` split ·
`R` record · `⌫` delete · `↑↓` select · `[` `]` reorder · `←→` frame step · `⌘Z` undo ·
`⌘+/−/0` zoom · `F` fullscreen · `?` help · `⌘⏎` render preview · `⇧⌘⏎` export.

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
  layout: lower                      # lower-third style; bg/fg override the project colors
  bg: "#f4efe6"
  fg: "#1d1d1f"
- clip: clips/IMG_4830.MOV
  speed: 1.5
  mute: true
  overlays:
  - {text: look at this dog, at: 1.5, for: 3, style: big, position: center}
- clip: clips/REC_20261023-183012.mp4   # recorded in the app
  fit: cover                            # crop to fill instead of letterbox
voiceovers:
- {file: audio/VO_20261023-183401.m4a, at: 0:12, volume: 1.0, duck_clips: true}
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
vlog voiceover PROJ narration.m4a --at 0:12   (vlog voiceover PROJ rm --at v1 to remove)
vlog preview PROJ [--open] · vlog render PROJ [--open] · vlog serve [--open]
vlog undo PROJ · vlog redo PROJ
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
Each vlog folder: `project.yaml`, `clips/` (originals + `REC_*` recordings), `audio/`
(`VO_*` voiceovers), `cache/` (proxies, thumbs, title PNGs, probe/loudness json), `out/`
(`preview.mp4`, final `<title>.mp4`).
