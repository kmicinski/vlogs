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
(default `~/Vlogs`), the masthead image and opening-card kicker/subtitle, the seconds of black
between masthead and date card (`intro_black_hold`), title-card colors for new vlogs
(`title_bg/fg/accent`), default music, orientation.

## Daily flow

1. **Project name ▸ New vlog** (⌘N). You get the standard intro automatically: the show's
   **masthead** image (2.5 s), a dip to black, then the date card ("Daily Vlogs / Friday,
   October 23", 2 s), with the intro **sting** (a slice of a song) fading in over the masthead
   and out as the first clip cuts in. Put the playhead at the start and press `R` to record
   yourself in front of it. Timings, the song and where in it to start are in Settings ▸ App.
2. **+ Add ▸ From Immich** (or Files) → pick the day → *Add all*. With *Trim each clip before
   it goes on the timeline* on (the default), the new clips then open one by one in the
   **trimmer**: drag the yellow handles (or play and press `I` / `O`) around the part you want
   and press `⏎` to add it and move to the next clip; `⇧⏎` adds it and lets you pick another
   part of the same clip; `N` skips (skipped clips stay in *+ Add ▸ In this project*).
3. Edit on the timeline. Drag the red playhead (or anywhere on the ruler) to scrub; the player
   plays the timeline **live from proxies**, including title cards, captions, crossfades, music
   and narration. Mark a part with `I` and `O` (or shift-drag the ruler, or `X` for the whole
   clip), then `⌫` cuts it out and closes the gap, or `K` keeps only that part. `S` splits,
   `Q`/`W` trim the clip's start/end to the playhead, `T` cuts to a title card, drag blocks to
   reorder. Double-click a clip to re-trim it against the whole source. Clips are drawn at
   log-scaled widths so short ones stay visible (**Log / Linear** in the bar switches it).
   Click a block for the inspector (captions, speed, fit, title colors and layout…). ⌘Z undoes
   anything. ⌘-scroll zooms.
   **Pictures over the video**: drop an image on the window, paste one (⌘V), or
   *+ Add ▸ Picture over the video*. It appears at the playhead for 3 seconds on the pink lane
   above the clips: drag it to move it, drag its ends to change how long it shows. In the
   inspector pick *Full screen*, *Large*, *Half* or *Small* and a spot on the 3×3 grid, or drag
   the picture around on the video and pull a corner to resize it. Pictures (and voiceovers)
   stay on the frames they were placed over when you trim, move or delete clips.
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

**Markers while you record:** press **Space** whenever you'll want to show something (an
artifact, a screenshot, a photo). Each press leaves a ◆ marker on the take; afterwards the
timeline shows a pink **+** above each marker on the pictures lane. Click it to pick the pictures
for that spot (they're placed one after another from the marker), or jump between markers with
`,` / `.` and paste (⌘V) or drop pictures there. `M` adds or removes a marker at the playhead.

- **Camera clip**: a talking-head segment that lands on the timeline like any other clip.
  "Crop to fill frame" (default for portrait vlogs) center-crops a 16:9 camera into 9:16.
- **Voiceover**: the preview plays from the playhead while you talk. The narration becomes a
  layer on the *Narration* lane under the timeline, starting at that time; clip audio is
  ducked under your voice. Wear headphones. Narration layers are `voiceovers:` in the YAML.

Audio mixing: every clip and voiceover is measured (LUFS) on import and auto-gained toward
a common level (*Match clip & voice levels*), music ducks under speech, and the final mix
is loudness-normalized. Per-clip volume/mute and fit are in the inspector.

The record sheet warns, loudly, when the selected microphone isn't a good one (a webcam or
computer mic instead of the DJI Mic Mini, a Yeti or an audio interface), and switches to a good
mic automatically when one is plugged in. If the mic is unplugged mid-take, recording stops and
the take so far is kept.

Keyboard: `space` play · `I`/`O` mark in/out · `X` mark clip · `⌫` cut out marked part ·
`K` keep only marked part · `M` marker · `,`/`.` previous/next marker · `Q`/`W` trim start/end to playhead · `T` title here · `S` split ·
`R` record · `⌫` delete · `↑↓` select · `[` `]` reorder · `←→` frame step · `⌘Z` undo ·
`⌘+/−/0` zoom · `F` fullscreen · `?` help · `⌘⏎` render preview · `⇧⌘⏎` export.

## The script (`project.yaml`)

```yaml
title: Thursday, October 22
output: {orientation: auto}          # auto | portrait | landscape | square
style: {transition: cut}             # cut | fade | dip ; also fade_in/out, fonts, colors
music: {file: ~/Music/lofi.mp3, volume: 0.18, duck: true}
timeline:
- image: assets/masthead.png         # image card (the show's masthead); fit: cover to crop instead
  duration: 3
- title: ''                          # a plain black card: the "fade to black" beat
  duration: 2.8
  bg: '#000000'
  transition: fade
  transition_duration: 1.0
- title: Thursday, October 22
  kicker: Daily Vlogs                # small tracked-out line above the title
  duration: 3
  transition: fade
- clip: clips/IMG_4821.MOV
  in: 0:03                           # source-clip times; seconds or m:ss
  out: 0:14
  caption: coffee first              # lower-third for the whole clip
  markers: [12.3, 40.1]              # ◆ moments to come back to (source-clip seconds; Space while recording)
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
images:                                 # pictures over the video; box = centre x/y + width as fractions of the frame
- {image: assets/dog.jpg, at: 0:20, for: 3}                              # full screen
- {image: assets/map.png, at: 0:31, for: 4, box: {x: 0.78, y: 0.24, w: 0.32}}   # small, top right
stings:                                 # music cues anchored to segments (follow them when the edit changes)
- {file: audio/sting.mp3, from: s1, to: s3, start: 0:06.5, volume: 0.7, fade_in: 0.6, fade_out: 1.0}
```

## CLI

```
vlog new [2026-10-22] [--title "..."]      vlog pull 2026-10-22 [--date ...]   (from Immich)
vlog add PROJ file.mov ...                 vlog show PROJ
vlog title PROJ "Lunch" [--sub ..] [--kicker ..] [--image f.png] [--dur 2] [--at INDEX]
vlog masthead PROJ [--at INDEX]            insert the configured masthead image card
vlog title-at PROJ 0:32 "Lunch"            split at 0:32 on the output timeline, insert card
vlog image PROJ pic.jpg --at 0:20 [--for 3] [--size full|large|half|small] [--pos tl|t|tr|l|c|r|bl|b|br]
vlog cut PROJ 0:12 0:15                    cut out that stretch of the output timeline (closes the gap)
vlog keep PROJ 0:12 0:15                   trim the clip(s) there so only that stretch remains
vlog caption PROJ s3 "coffee first" [--at 2 --dur 3]
vlog trim PROJ s3 --in 0:03 --out 0:14     vlog set PROJ s3 speed=1.5 mute=true transition=fade
vlog rm PROJ s3 · vlog move PROJ s3 0 · vlog music PROJ file.mp3 [--volume 0.2]
vlog voiceover PROJ narration.m4a --at 0:12   (vlog voiceover PROJ rm --at v1 to remove)
vlog sting PROJ song.mp3 --from s1 --to s3 [--start 0:06.5] [--volume 0.7]   (`intro` = the configured song; rm --id m1)
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
