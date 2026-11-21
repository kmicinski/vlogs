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

Renaming: the vlog switcher (the title at the top left) has *Rename this vlog…* (title, day, folder) and
*Move this vlog to today* for the day you forgot to make it: the date is updated, the opening date card
shows the new day, a title that was just the date follows, and a folder named after the day is renamed.
`vlog rename PROJ --today` / `--title` / `--date` / `--name` do the same.

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
2. **+ Add ▸ From Immich** (or Files) → pick the day → *Add all*. With *Pick each clip's part and
   speed before it goes on the timeline* on (the default), the new clips open in the **trimmer**
   as a queue: a strip of the clips along the top, the current one playing below. Drag the yellow
   handles (or play and press `I` / `O`) around the part you want, set a **speed** (8× turns a
   minute of walking into 7½ s; the preview plays at that speed) and press `⏎` to queue it; `N`
   leaves a clip out; `J` / `L` or a click on the strip go back to an earlier clip, whose marks are
   kept. When the last clip is decided, everything queued goes on the timeline together, in order,
   as one undo step (*Add N queued* does it earlier). `⇧⏎` adds the current part right away and lets
   you pick another part of the same clip. Clips you leave out stay in *+ Add ▸ In this project*.
   Trimming starts the moment a clip has landed: the browser plays camera takes and iPhone HEVC
   clips directly, so nothing waits for a proxy.
3. Edit on the timeline. Drag the red playhead (or anywhere on the ruler) to scrub; the player
   plays the timeline **live from proxies**, including title cards, captions, crossfades, music
   and narration. Mark a part with `I` and `O` (or shift-drag the ruler, or `X` for the whole
   clip), then `⌫` cuts it out and closes the gap, or `K` keeps only that part. `S` splits,
   `Q`/`W` trim the clip's start/end to the playhead, `T` cuts to a title card, drag blocks to
   reorder. Double-click a clip to re-trim it against the whole source. Clips are drawn at
   log-scaled widths so short ones stay visible (**Log / Linear** in the bar switches it).
   Click a block for the inspector (captions, speed, fit, title colors and layout…). ⌘Z undoes
   anything. ⌘-scroll zooms. **Speed** is a log slider from 0.1× to 1000× with a box to type any
   number (60× makes a minute into a second; above 20× the sound is dropped, timelapse style).
   **Music** (`♫ Music` in the bar, or *+ Add ▸ Music…*) goes on the orange lane, anchored to the
   clips. The default, **Continue the intro song here**, picks the intro song up where it last
   stopped, over the marked range (`I`/`O` — the clips are split there so it starts and stops
   exactly where you marked), else the selected clip, else the clip under the playhead. Songs
   already in the vlog get their own *Continue "…" here*. **Other music here…** opens a sheet:
   pick a song, drag the window on the song strip to choose where in it the music begins (▶
   listens from there), choose what it plays over (range / clip / whole vlog), fades, *Repeat*,
   and an optional credit. Splitting a clip keeps the song playing over both halves; select the
   music and **✂ Split at playhead** makes two pieces that play on seamlessly, each with its own
   fades, volume, *Through* range or delete. A **credit** (license / attribution text) shows in
   small text in a corner when the music comes in (corner and seconds per cue, defaults in
   Settings ▸ This vlog).
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
- **Screen**: share a screen or a window (the browser's picker; the *Screen* tab) and talk over
  it. Pick a layout before you start: *Screen · me in a corner*, *Me · screen in a corner*,
  *Stacked* (portrait: you in a square on top, the screen below; landscape: side by side) or
  *Screen only*. The screen and the camera are recorded as **two synced clips**, so the layout
  is only a starting point: select the clip afterwards and change it in the inspector
  (*Video over this clip*: over the picture, small / large inset, corner, stacked, hide, rounded / square / circle,
  **⇄ Swap** to make the other one big), or drag the inset around on the video and pull a
  corner to resize it. Split the clip (`S`) to change the layout partway through. Tick
  *include computer sound* to record what the Mac is playing along with your mic (if the
  share offers it). Any clip can get a video over it: *+ Put a video over this clip…*, or
  pick a clip from *+ Add ▸ In this project* and choose **Over the video at the playhead** (B-roll: its picture replaces the clip's for as long as it runs while the clip's sound carries on; *Its sound* in the inspector mixes its own in) or **In a small frame over the clip at the
  playhead** in the trimmer: the clip under the playhead is split so the frame comes in there and
  goes away when the framed part ends. The inset has its own **speed** on top of the clip's (a 4×
  timelapse in a corner while you talk) and a *Starts at* time in its own file.
- **Voiceover**: the preview plays from the playhead while you talk. The narration becomes a
  layer on the *Narration* lane under the timeline, starting at that time; clip audio is
  ducked under your voice. Wear headphones. Narration layers are `voiceovers:` in the YAML.
  A layer is handled like a clip's sound: a mic that only reached one channel is heard in both
  ears (the inspector's *Channels* select overrides it), and **✂ Split at playhead** (in the
  inspector, or the toolbar's ✂ with the layer selected) cuts it into two pieces that play on
  from each other, so a piece can be dragged elsewhere, trimmed (*In → out*) or deleted. Any
  layer may carry `in:`/`out:` (seconds in its file) and `channel:` in the YAML.

Audio mixing: every clip and voiceover is measured (LUFS) on import and auto-gained toward
a common level (*Match clip & voice levels*), music ducks under speech, and the final mix
is loudness-normalized. Per-clip volume/mute and fit are in the inspector. A take whose mic only
reached one channel (a DJI Mic plugged into the right input) is detected on import and that channel
is copied to both ears, in the live player and the render; the inspector's *Channels* select overrides
it (stereo as recorded, left or right to both ears, mix to mono) — `channel:` in the YAML.

Preparing clips is cheap by design: a new clip gets a thumbnail (one frame) and two quick audio passes
for its loudness, all at low CPU priority in the background, and a 540p proxy *only* when the browser
cannot play the source itself (HDR, HEVC, above 1080p) — a camera take or an SDR H.264 clip is used as
it is, like Premiere plays its sources. An 8-minute 1080p take is ready in about four seconds. Imports
from Immich download everything first and prepare in the background, so the trimmer opens right away.
Filmstrips decode keyframes only, in hardware.

Voice polish (on by default, *Settings → This vlog → Polish voices*): every clip and narration goes
through a gentle produced-voice chain in the render — the take is brought to a fixed level, rumble
below 90 Hz is cut, room noise and hiss are reduced (~10 dB; *Noise reduction* sets how much, 0 turns
it off), sibilance is tamed, a little mud is taken out at 250 Hz with a touch of presence at 3 kHz
and air above 9 kHz, and a slow 2.5:1 compressor evens out quiet asides and emphatic bits; the usual
level matching is measured *after* the polish and a limiter catches the peaks. It is meant to still
sound like you, not like a radio voice. The inspector's *Voice* select turns it off (or forces it on)
per clip or narration (`polish: on|off` in the YAML; `audio.polish` / `audio.denoise` for the vlog).
The live player only approximates it (level + EQ), so judge it in a preview. For better noise
reduction drop an RNNoise model at `~/.config/krisvideos/rnnoise.rnnn`.

The record sheet warns, loudly, when the selected microphone isn't a good one (a webcam or
computer mic instead of the DJI Mic Mini, a Yeti or an audio interface), and switches to a good
mic automatically when one is plugged in. If the mic is unplugged mid-take, recording stops and
the take so far is kept.

Wide-angle webcams bend straight lines near the edges (barrel distortion). Every take remembers
the camera it was shot with (like its mic), and the inspector's **Lens** section straightens it in
the export: two sliders (k1 for the bulge, k2 for the fine edges; a little below zero is usually
right), a corrected still of the current frame to judge by, and a choice of *For this camera*
(saved in the app settings, so every clip from that camera — past and future — is corrected the
same way), *Every clip in this vlog* (the same numbers written onto all of them — for a vlog
whose clips don't say which camera shot them), *This clip only*, or *No correction*. A clip
without a camera name (an imported file, or a take from before the app kept camera names) has a
*shot with…* picker that tells it its camera, so the camera's saved correction applies to it
too; with several clips selected the inspector's *Lens (every clip)* row sets them all at once;
the recorder says under the camera whether that camera is straightened yet and offers to measure
it. The player, the still, previews and the export all apply it (the player draws such clips
through a WebGL twin of the video with the same formula). In the YAML a clip may carry `cam:`
(the camera's name) and `lens: off` or
`lens: {k1: -0.12, k2: 0.02}`; the per-camera table is `lenses:` in
`~/.config/krisvideos/config.yaml` (`match` is a substring or regex of the camera's name).

You don't have to guess the numbers: **Measure it automatically…** (in the Lens section, or
*Straighten a camera lens…* in the vlog settings) opens the camera, and you hold up the printed
checkerboard (`/calibration` prints it; a phone or tablet showing that page works too). Every
distinct view of the board adds rows and columns that ought to be straight; once the 3 × 3 grid
over the picture is green the correction is measured, the live picture switches to the
straightened view, and *Save* keeps it for that camera. `vlog calibrate "Anker PowerConf"
photo1.jpg photo2.jpg …` does the same from photos (`vlog calibrate --pattern board.png` writes
the pattern).

**Selecting several things.** Click selects a clip, ⇧-click selects everything between it and the
last one you clicked, ⌘-click adds one or takes it out again (⌘A selects all). The inspector then
acts on all of them: mute, speed, voice, transition, move, delete. ⌘G **groups** the selection so
those clips select, drag and delete together from then on (a coloured bar marks them; ⇧⌘G
ungroups). ⌘L **unlinks** a clip's sound from its picture: the clip goes quiet and its sound
becomes a block on the **A2** track that you can drag in time, trim, speed up or delete on its own
(⌘L on that block, or *Link back* in its inspector, puts it back on the clip). Overlapping sounds
stack in rows.

Keyboard: `space` play · `I`/`O` mark in/out · `X` mark clip · `⌫` cut out marked part ·
`K` keep only marked part · `M` marker · `,`/`.` previous/next marker · `Q`/`W` trim start/end to playhead · `T` title here · `S` split ·
`R` record · `⌫` delete · `↑↓` select (⇧ extends) · ⇧/⌘-click select a range / toggle · `⌘A` all · `⌘G`/`⇧⌘G` group/ungroup ·
`⌘L` unlink/link a clip's sound · `[` `]` reorder · `←→` frame step · `⌘Z` undo ·
`⌘+/−/0` zoom · `F` fullscreen · `?` help · `⌘⏎` render preview · `⇧⌘⏎` export.

## The script (`project.yaml`)

```yaml
title: Thursday, October 22
output: {orientation: auto}          # auto | portrait | landscape | square
style: {transition: cut}             # cut | fade | dip ; also fade_in/out, fonts, colors
music: {file: ~/Music/lofi.mp3, volume: 0.18, duck: true, credit: "Music: … (CC BY 3.0)"}   # old-style loop under everything
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
- clip: clips/IMG_4831.MOV
  channel: right                        # the mic was only on the right: copy it to both ears
                                        # (auto by default: a one-sided take is detected and mirrored)
  overlays:
  - {text: look at this dog, at: 1.5, for: 3, style: big, position: center}
- clip: clips/REC_20261023-183012.mp4   # recorded in the app
  fit: cover                            # crop to fill instead of letterbox
- clip: clips/REC_20261030-104452-screen.mp4   # a screen take: the screen, with the camera in a box over it
  pip: {clip: clips/REC_20261030-104452-cam.mp4, box: {x: 0.82, y: 0.84, w: 0.3}, shape: round}
                                        # pip time = offset + speed × clip source time; h omitted = the camera's own aspect
- clip: clips/IMG_4840.MOV              # a 4x timelapse in a frame over this clip, from 0:05 of its file
  pip: {clip: clips/IMG_4850.MOV, offset: 5, speed: 4, box: {x: 0.19, y: 0.19, w: 0.3}}
- clip: clips/REC_20261030-104452-screen.mp4   # the same take, stacked: screen in the lower box, camera square on top
  box: {x: 0.5, y: 0.78, w: 1, h: 0.44}
  pip: {clip: clips/REC_20261030-104452-cam.mp4, box: {x: 0.5, y: 0.28, w: 1, h: 0.5625}, shape: rect}
voiceovers:
- {file: audio/VO_20261023-183401.m4a, at: 0:12, volume: 1.0, duck_clips: true}
images:                                 # pictures over the video; box = centre x/y + width as fractions of the frame
- {image: assets/dog.jpg, at: 0:20, for: 3}                              # full screen
- {image: assets/map.png, at: 0:31, for: 4, box: {x: 0.78, y: 0.24, w: 0.32}}   # small, top right
stings:                                 # music, anchored to segments (splits with them; follows them when the edit changes)
- {file: audio/sting.mp3, from: s1, to: s3, start: 0:06.5, volume: 0.7, fade_in: 0.6, fade_out: 1.0}
- {file: audio/city-lights.mp3, from: s5, to: s9, start: 0:12, loop: true, fade_out: 0,
   credit: "Music: city lights by Snoozy Beats\nCC BY 3.0", credit_pos: tr, credit_for: 6}
- {file: audio/city-lights.mp3, from: s10, to: s12, start: 1:02, fade_in: 0}   # …continued after a split
```

## CLI

```
vlog new [2026-10-22] [--title "..."]      vlog pull 2026-10-22 [--date ...]   (from Immich)
vlog rename 2026-10-22 --today             forgot to make it that day? move it to today (date card, title, folder)
vlog rename 2026-10-22 --title "Lake day"  retitle (a title card showing the old title follows)
vlog add PROJ file.mov ...                 vlog show PROJ
vlog title PROJ "Lunch" [--sub ..] [--kicker ..] [--image f.png] [--dur 2] [--at INDEX]
vlog masthead PROJ [--at INDEX]            insert the configured masthead image card
vlog title-at PROJ 0:32 "Lunch"            split at 0:32 on the output timeline, insert card
vlog image PROJ pic.jpg --at 0:20 [--for 3] [--size full|large|half|small] [--pos tl|t|tr|l|c|r|bl|b|br]
vlog cut PROJ 0:12 0:15                    cut out that stretch of the output timeline (closes the gap)
vlog keep PROJ 0:12 0:15                   trim the clip(s) there so only that stretch remains
vlog caption PROJ s3 "coffee first" [--at 2 --dur 3]
vlog trim PROJ s3 --in 0:03 --out 0:14     vlog set PROJ s3 speed=1.5 mute=true transition=fade   (speed: any number, e.g. 60)
vlog set PROJ s3 channel=right             # one-channel mic: right (or left) to both ears; mix; stereo; auto
vlog set PROJ s3 lens=-0.12,0.02           # straighten a wide-angle webcam (or lens=off / lens=auto = the camera's setting)
vlog config lenses='[{match: Anker, k1: -0.12, k2: 0.02}]'   # the per-camera table (match = substring/regex of the camera name)
vlog calibrate "Anker PowerConf" board1.jpg board2.jpg ...   # measure k1/k2 from photos of the checkerboard and save them for that camera
vlog group PROJ s3 s4 s5 · vlog ungroup PROJ s3   # clips that select, move and delete together in the GUI
vlog unlink PROJ s3 · vlog link PROJ v2       # a clip's sound as its own A2 block (and back)
vlog rm PROJ s3 · vlog move PROJ s3 0 · vlog music PROJ file.mp3 [--volume 0.2]
vlog pip PROJ s3 [cam.mp4] [--layout corner|corner-large|stacked|hidden] [--pos br] [--shape round|rect|circle] [--speed 4] [--in 0:05] [--swap] [--rm]
                                           a clip in a box over s3 (picture in picture); --swap makes the inset the big one
vlog frame PROJ clip.mp4 --at 0:32 --layout full [--in 0:05 --out 0:20] [--speed 4] [--sound 0.3]   B-roll: the video over the clip at 0:32 for its in→out part; the clip's sound carries on (--sound mixes its own in)
vlog frame PROJ clip.mp4 --at 0:32 [--pos tl]      the same in a small frame (picture in picture)
vlog voiceover PROJ narration.m4a --at 0:12   (vlog voiceover PROJ rm --id v1 to remove)
vlog voiceover PROJ split --id v1 --at 0:45    # two pieces that play on from each other; then vlog set PROJ v2 at=1:10
vlog set PROJ v2 channel=right in=0:04 out=0:12   # a layer takes channel/in/out/at/volume/polish like a clip
vlog sting PROJ song.mp3 --from s1 --to s3 [--start 0:06.5] [--volume 0.7] [--loop] [--credit "Music: …" --credit-pos tr]
vlog sting PROJ song.mp3 --range 0:32 1:10 | --whole   music over that stretch (clips split at both ends) / the whole vlog
vlog sting PROJ song.mp3 --continue --from s5   pick the song up where its last cue stopped  (`intro` = the configured song)
vlog sting PROJ split --id m1 --at 0:45     split a cue at 0:45 into two that play on (the clip is split there too); rm --id m1 removes
vlog preview PROJ [--open] · vlog render PROJ [--open] [--workers N] · vlog serve [--open]
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
