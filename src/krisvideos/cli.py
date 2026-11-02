"""`vlog` command line. Every command edits project.yaml and/or runs ffmpeg.

    vlog new [NAME] [--title T]              create ~/Vlogs/NAME (default: today)
    vlog add PROJECT FILE...                 import clips (local files)
    vlog pull PROJECT [--date YYYY-MM-DD]    pull a day's videos from Immich
    vlog title PROJECT "Text" [--sub S] [--kicker K] [--image FILE] [--dur 3] [--at INDEX]
    vlog masthead PROJECT [--at INDEX]       insert the configured masthead image card
    vlog title-at PROJECT 0:32 "Text"        split the timeline at 0:32 and cut to a title card
    vlog cut PROJECT 0:12 0:15               cut out that stretch of the output timeline (closes the gap)
    vlog keep PROJECT 0:12 0:15              trim the clip(s) there so only that stretch remains
    vlog caption PROJECT SEG "Text"          lower-third over a segment (SEG = id like s3, or index)
    vlog trim PROJECT SEG --in 0:03 --out 0:14
    vlog set PROJECT SEG key=value ...       e.g. mute=true speed=1.5 transition=fade
    vlog rm PROJECT SEG                      remove a segment
    vlog move PROJECT SEG INDEX              reorder
    vlog music PROJECT FILE [--volume 0.18]
    vlog voiceover PROJECT FILE --at 0:12          narration layer at a timeline time (GUI can record these)
    vlog sting PROJECT song.mp3 --from s1 --to s3 [--start 0:06.5]   music cue over those segments (fades in/out)
    vlog image PROJECT pic.jpg --at 0:12 [--for 3] [--size full|large|half|small] [--pos tr]   picture over the video
    vlog show PROJECT                        print the timeline
    vlog preview PROJECT [--open]            fast half-res render -> out/preview.mp4
    vlog render PROJECT [--open]             full-quality render -> out/<title>.mp4
    vlog serve [--open]                      start the GUI
"""
from __future__ import annotations

import argparse
import datetime as dt
import subprocess
import sys
from pathlib import Path

from . import edits, media, render
from .config import Config
from .edits import title_at  # noqa: F401  (re-exported: older imports use cli.title_at)
from .project import Overlay, Project
from .timeutil import fmt_time, parse_time


def _project(cfg: Config, name: str | None) -> Project:
    if name and (Path(name).expanduser() / "project.yaml").exists():
        return Project.load(Path(name).expanduser())
    name = name or dt.date.today().isoformat()
    folder = cfg.vlogs_path / name
    if not (folder / "project.yaml").exists():
        sys.exit(f"no project at {folder} (run `vlog new {name}` first)")
    return Project.load(folder)


def _snapshot(p: Project) -> Project:
    from copy import deepcopy
    return deepcopy(p)


def _seg(p: Project, ref: str):
    if ref.isdigit():
        return p.timeline[int(ref)]
    return p.timeline[p.index_of(ref)]


def _import(p: Project, path: Path) -> str:
    rel = media.import_file(p, path)
    media.prepare_async(p, rel)
    return rel


def new_project(cfg: Config, folder: Path, title: str | None, opening: bool = True) -> Project:
    """Create a project with the configured defaults and (optionally) the standard intro."""
    p = Project.new(folder, title=title or folder.name)
    p.output.orientation = cfg.default_orientation
    p.style.font = cfg.font
    p.style.transition = cfg.default_transition
    p.style.title_bg, p.style.title_fg, p.style.title_accent = cfg.title_bg, cfg.title_fg, cfg.title_accent
    if cfg.default_music:
        p.music.file = cfg.default_music
    if opening:
        add_opening(p, cfg, title or _pretty_date(folder.name))
    return p


def masthead_rel(p: Project, cfg: Config) -> str | None:
    """Copy the configured masthead image into the project (assets/) and return its relative path."""
    import shutil
    if not cfg.masthead_image:
        return None
    src = Path(cfg.masthead_image).expanduser()
    if not src.exists():
        return None
    dst_dir = p.folder / "assets"
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / ("masthead" + src.suffix.lower())
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dst)
    return f"assets/{dst.name}"


INTRO_FADE_OUT = 1.0   # masthead -> black
INTRO_FADE_IN = 0.8    # black -> opening card


def add_opening(p: Project, cfg: Config, title: str, at: int | None = None) -> None:
    """The standard intro: masthead image card -> fade to black (hold) -> opening date card.
    Without a masthead configured this is just the opening card."""
    idx = len(p.timeline) if at is None else at
    rel = masthead_rel(p, cfg)
    first = None
    if rel:
        first = p.add_title("", "", float(cfg.intro_masthead_seconds or 2.5), at=idx, image=rel)
        idx += 1
        hold = max(0.0, float(cfg.intro_black_hold))
        # the black card overlaps both fades (xfade eats into it), so pad it to leave `hold` seconds of pure black
        p.add_title("", "", round(hold + INTRO_FADE_OUT + INTRO_FADE_IN, 2), at=idx, bg="#000000", transition="fade",
                    transition_duration=INTRO_FADE_OUT, note="fade to black")
        idx += 1
    card = p.add_title(title, cfg.default_title_subtitle, float(cfg.intro_title_seconds or 2.0), at=idx,
                       kicker=cfg.default_title_kicker)
    if rel:
        card.transition, card.transition_duration = "fade", INTRO_FADE_IN
    sting = sting_rel(p, cfg)
    if sting:
        p.add_sting(sting, (first or card).id, card.id, start=float(cfg.intro_sting_start or 0),
                    volume=float(cfg.intro_sting_volume or 0.7), note="intro")


def sting_rel(p: Project, cfg: Config) -> str | None:
    """Copy the configured intro sting into the project (audio/) and return its relative path."""
    import shutil
    if not cfg.intro_sting:
        return None
    src = Path(cfg.intro_sting).expanduser()
    if not src.exists():
        return None
    p.ensure_dirs()
    dst = p.audio_dir / ("sting" + src.suffix.lower())
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dst)
    return f"audio/{dst.name}"


def cmd_new(cfg, a):
    name = a.name or dt.date.today().isoformat()
    folder = cfg.vlogs_path / name
    if (folder / "project.yaml").exists():
        sys.exit(f"project already exists: {folder}")
    p = new_project(cfg, folder, a.title, a.opening)
    p.save()
    print(f"created {p.path}")


def _pretty_date(name: str) -> str:
    try:
        return dt.date.fromisoformat(name).strftime("%A, %B %-d")
    except ValueError:
        return name


def cmd_add(cfg, a):
    p = _project(cfg, a.project)
    for f in a.files:
        rel = _import(p, Path(f))
        p.add_clip(rel)
        print(f"added {rel}")
    p.save()


def cmd_pull(cfg, a):
    from .immich import Immich
    p = _project(cfg, a.project)
    im = Immich(cfg.immich_url, cfg.immich_api_key)
    day = dt.date.fromisoformat(a.date) if a.date else (dt.date.fromisoformat(p.date) if p.date else dt.date.today())
    vids = im.videos_on(day)
    print(f"{len(vids)} videos on {day}")
    have = {s.src for s in p.timeline}
    for v in vids:
        path = im.download(v["id"], p.clips_dir, v["filename"])
        rel = f"clips/{path.name}"
        media.prepare_async(p, rel)
        if rel not in have and a.add:
            p.add_clip(rel)
        print(f"  {v['taken_at']}  {rel}")
    p.save()


def cmd_title(cfg, a):
    p = _project(cfg, a.project)
    image = None
    if a.image:
        import shutil
        src = Path(a.image).expanduser().resolve()
        if not src.exists():
            sys.exit(f"no such image: {src}")
        (p.folder / "assets").mkdir(parents=True, exist_ok=True)
        dst = p.folder / "assets" / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
        image = f"assets/{dst.name}"
    p.add_title(a.text, a.sub or "", a.dur, at=a.at, kicker=a.kicker or "", image=image)
    p.save()
    print("ok")


def cmd_masthead(cfg, a):
    p = _project(cfg, a.project)
    rel = masthead_rel(p, cfg)
    if not rel:
        sys.exit("no masthead image configured (vlog config masthead_image=/path/to/image.png)")
    p.add_title("", "", a.dur, at=a.at, image=rel)
    p.save()
    print("ok")


def cmd_title_at(cfg, a):
    p = _project(cfg, a.project)
    title_at(p, parse_time(a.time), a.text, a.sub or "", a.dur)
    p.save()
    cmd_show(cfg, a)


def cmd_cut(cfg, a):
    p = _project(cfg, a.project)
    removed = edits.cut_range(p, parse_time(a.start), parse_time(a.end))
    if removed <= 0:
        sys.exit("nothing to cut there")
    p.save()
    print(f"cut out {fmt_time(removed)}")
    cmd_show(cfg, a)


def cmd_keep(cfg, a):
    p = _project(cfg, a.project)
    removed, _ = edits.keep_range(p, parse_time(a.start), parse_time(a.end))
    if removed <= 0:
        sys.exit("nothing to trim there (the range must be inside a clip)")
    p.save()
    print(f"trimmed {fmt_time(removed)}")
    cmd_show(cfg, a)


def cmd_caption(cfg, a):
    p = _project(cfg, a.project)
    s = _seg(p, a.seg)
    if a.at is None and a.dur is None:
        s.caption = a.text
    else:
        s.overlays.append(Overlay(text=a.text, at=parse_time(a.at or 0), duration=a.dur, position=a.position))
    p.save()
    print("ok")


def cmd_trim(cfg, a):
    p = _project(cfg, a.project)
    before = _snapshot(p)
    s = _seg(p, a.seg)
    if a.in_ is not None:
        edits.set_in(s, parse_time(a.in_))
    if a.out is not None:
        s.out = None if a.out in ("end", "none") else parse_time(a.out)
    edits.follow_content(before, p)
    p.save()
    print("ok")


def cmd_set(cfg, a):
    p = _project(cfg, a.project)
    s = _seg(p, a.seg)
    for kv in a.pairs:
        k, _, v = kv.partition("=")
        k = {"in": "in_", "title": "text"}.get(k, k)
        if not hasattr(s, k):
            sys.exit(f"unknown field {k}")
        cur = getattr(s, k)
        if isinstance(cur, bool):
            v = v.lower() in ("1", "true", "yes", "on")
        elif k in ("in_", "out", "duration", "transition_duration"):
            v = None if v in ("none", "end", "") else parse_time(v)
        elif k == "image":
            v = None if v in ("none", "") else v
        elif k == "channel":
            from .project import CHANNELS
            if v not in CHANNELS:
                sys.exit(f"channel must be one of {', '.join(CHANNELS)}")
        elif isinstance(cur, float):
            v = float(v)
        setattr(s, k, v)
    p.save()
    print("ok")


def cmd_pip(cfg, a):
    """Picture in picture: a second clip in a box over a clip (the camera over a screen recording)."""
    from .probe import probe
    from .project import Pip, box4
    p = _project(cfg, a.project)
    s = _seg(p, a.seg)
    if s.kind != "clip":
        sys.exit("insets go on clips")
    if a.rm:
        s.pip = None
        s.box = None
    else:
        if a.file:
            s.pip = Pip(src=_import(p, Path(a.file)), offset=parse_time(a.offset) if a.offset else 0.0)
        if s.pip is None:
            sys.exit(f"{s.id} has no inset: give it a clip file")
        if a.offset and not a.file:
            s.pip.offset = parse_time(a.offset)
        if a.swap:
            edits.swap_pip(s)
        if a.shape:
            s.pip.shape = a.shape
        if a.box:
            s.pip.box = box4([float(x) if x not in ("", "none") else None for x in a.box.split(",")]) or s.pip.box
        if a.layout or a.pos:
            layout = render.compute_layout(p)
            try:
                pi = probe(p.resolve(s.pip.src), p.cache_dir)
                aspect = pi.height / pi.width if pi.width and pi.height else 9 / 16
            except Exception:
                aspect = 9 / 16
            name = a.layout or ("corner" if s.pip.box[3] is None and not s.pip.hidden else "corner")
            edits.pip_layout(s, name, (layout.width, layout.height), aspect, a.pos)
    p.save()
    print("ok")


def cmd_rm(cfg, a):
    p = _project(cfg, a.project)
    before = _snapshot(p)
    s = _seg(p, a.seg)
    p.remove(s.id)
    edits.follow_content(before, p)
    p.save()
    print("ok")


def cmd_move(cfg, a):
    p = _project(cfg, a.project)
    before = _snapshot(p)
    s = _seg(p, a.seg)
    p.move(s.id, a.index)
    edits.follow_content(before, p)
    p.save()
    print("ok")


def cmd_music(cfg, a):
    p = _project(cfg, a.project)
    if a.file in ("none", "off"):
        p.music.file = ""
    else:
        p.music.file = str(Path(a.file).expanduser().resolve())
        if a.volume is not None:
            p.music.volume = a.volume
    p.save()
    print("ok")


def cmd_voiceover(cfg, a):
    import shutil
    p = _project(cfg, a.project)
    if a.file in ("rm", "remove") and a.at:
        p.voiceovers = [v for v in p.voiceovers if v.id != a.at]
    else:
        src = Path(a.file).expanduser().resolve()
        p.ensure_dirs()
        dst = p.audio_dir / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
        media.measure_loudness(dst, p.cache_dir)
        vo = p.add_voiceover(f"audio/{dst.name}", parse_time(a.at or 0))
        if a.volume is not None:
            vo.volume = a.volume
    p.save()
    print("ok")


def cmd_sting(cfg, a):
    import shutil
    p = _project(cfg, a.project)
    if a.file in ("rm", "remove"):
        if not a.id:
            sys.exit("vlog sting PROJ rm --id m1")
        p.stings = [m for m in p.stings if m.id != a.id]
    else:
        if a.file == "intro":
            rel = sting_rel(p, cfg)
            if not rel:
                sys.exit("no intro sting configured (vlog config intro_sting=/path/to/song.mp3)")
        else:
            src = Path(a.file).expanduser().resolve()
            if not src.exists():
                sys.exit(f"no such file: {src}")
            p.ensure_dirs()
            dst = p.audio_dir / src.name
            if not dst.exists():
                shutil.copy2(src, dst)
            rel = f"audio/{dst.name}"
        frm = _seg(p, a.from_seg) if a.from_seg else (p.timeline[0] if p.timeline else None)
        if frm is None:
            sys.exit("timeline is empty")
        to = _seg(p, a.to_seg) if a.to_seg else frm
        kw = {}
        if a.start is not None:
            kw["start"] = parse_time(a.start)
        if a.volume is not None:
            kw["volume"] = a.volume
        if a.no_duck:
            kw["duck"] = False
        p.add_sting(rel, frm.id, to.id, **kw)
    p.save()
    print("ok")


SIZES = {"full": None, "large": 0.8, "half": 0.5, "small": 0.32}
POSITIONS = {"tl": (0, 0), "t": (1, 0), "tr": (2, 0), "l": (0, 1), "c": (1, 1), "center": (1, 1), "r": (2, 1),
             "bl": (0, 2), "b": (1, 2), "br": (2, 2)}


def image_box(size, pos: str, frame_w: int, frame_h: int, img_w: int, img_h: int, margin: float = 0.05):
    """(x, y, w) for a picture of the given size (fraction of the frame width) at one of 9 anchors."""
    if size is None:
        return None
    w = float(size)
    hf = w * frame_w / frame_h * (img_h / max(1, img_w))      # its height as a fraction of the frame height
    col, row = POSITIONS.get(pos, (1, 1))
    x = [margin + w / 2, 0.5, 1 - margin - w / 2][col]
    y = [margin + hf / 2, 0.5, 1 - margin - hf / 2][row]
    return (round(x, 4), round(y, 4), round(w, 4))


def cmd_image(cfg, a):
    import shutil
    from PIL import Image
    p = _project(cfg, a.project)
    if a.file in ("rm", "remove"):
        if not a.id:
            sys.exit("vlog image PROJ rm --id i1")
        p.images = [m for m in p.images if m.id != a.id]
        p.save()
        print("ok")
        return
    src = Path(a.file).expanduser().resolve()
    if not src.exists():
        sys.exit(f"no such file: {src}")
    (p.folder / "assets").mkdir(parents=True, exist_ok=True)
    dst = p.folder / "assets" / src.name
    if not dst.exists():
        shutil.copy2(src, dst)
    size = SIZES[a.size] if a.size in SIZES else float(a.size)
    layout = render.compute_layout(p)
    from .titles import image_size
    box = image_box(size, a.pos, layout.width, layout.height, *image_size(dst))
    m = p.add_image(f"assets/{dst.name}", parse_time(a.at or 0), a.dur, box=box)
    p.save()
    print(f"added {m.id}")


def cmd_undo(cfg, a, redo=False):
    from .server import HISTORY
    p = _project(cfg, a.project)
    ok = HISTORY.redo(p) if redo else HISTORY.undo(p)
    print("ok" if ok else "nothing to " + ("redo" if redo else "undo"))


def cmd_show(cfg, a):
    p = _project(cfg, a.project)
    layout = render.compute_layout(p)
    print(f"{p.title}  [{layout.width}x{layout.height} @ {layout.fps}fps]  total {fmt_time(layout.total)}")
    for pl in layout.placed:
        s = pl.seg
        tr = "" if pl.transition == "cut" else f" ({pl.transition} {pl.transition_duration}s)"
        if s.kind == "title":
            desc = ("IMAGE  " if s.image and not s.text else "TITLE  ") + (f"{s.text!r}" if s.text else "") + (f" / {s.subtitle!r}" if s.subtitle else "")
            if s.kicker:
                desc += f"  kicker={s.kicker!r}"
            if s.image:
                desc += f"  image={s.image}"
            if s.bg == "#000000" and not s.text and not s.image:
                desc = "BLACK  "
        else:
            desc = f"CLIP   {s.src}  [{fmt_time(pl.src_in)} - {fmt_time(pl.src_out)}]"
            if s.speed != 1:
                desc += f" x{s.speed}"
            if s.mute:
                desc += " muted"
            ch = media.effective_channel(p.resolve(s.src), p.cache_dir, s.channel, compute=False)
            if s.channel != "auto" or ch != "stereo":
                desc += f"  audio={s.channel}" + (f"→{ch} to both ears" if ch in ("left", "right") else "→mono" if ch == "mix" else "")
            if s.caption:
                desc += f"  caption={s.caption!r}"
            for ov in s.overlays:
                desc += f"  overlay@{fmt_time(ov.at)}={ov.text!r}"
            mk = [pl.start + (x - pl.src_in) / (s.speed or 1.0) for x in s.markers if pl.src_in - 1e-3 <= x <= pl.src_out + 1e-3]
            if mk:
                desc += "  markers@" + ",".join(fmt_time(t) for t in mk)
            if s.box:
                desc += f"  box x={s.box[0]:.2f} y={s.box[1]:.2f} w={s.box[2]:.2f}" + (f" h={s.box[3]:.2f}" if s.box[3] is not None else "")
            if s.pip:
                b = s.pip.box
                desc += f"  pip={s.pip.src}" + (" (hidden)" if s.pip.hidden else f" box x={b[0]:.2f} y={b[1]:.2f} w={b[2]:.2f}" + (f" h={b[3]:.2f}" if b[3] is not None else "") + (f" {s.pip.shape}" if s.pip.shape != "round" else ""))
                if s.pip.offset:
                    desc += f" offset={s.pip.offset:+.3f}"
        print(f"  {s.id:>4}  {fmt_time(pl.start):>7} - {fmt_time(pl.end):<7} {desc}{tr}")
    for v in p.voiceovers:
        print(f"  {v.id:>4}  {fmt_time(v.at):>7}          VOICE  {v.file} vol={v.volume}{'' if v.duck_clips else ' no-duck'}")
    for m in p.images:
        where = "full screen" if not m.box else f"box x={m.box[0]:.2f} y={m.box[1]:.2f} w={m.box[2]:.2f}"
        print(f"  {m.id:>4}  {fmt_time(m.at):>7} - {fmt_time(m.at + m.duration):<7} IMAGE  {m.file}  {where}")
    for m in p.stings:
        span = render.sting_span(layout, m)
        when = f"{fmt_time(span[0]):>7} - {fmt_time(span[1]):<7}" if span else "   (segments gone)   "
        print(f"  {m.id:>4}  {when} STING  {m.file} @{fmt_time(m.start)} over {m.from_id}..{m.to_id} vol={m.volume}{'' if m.duck else ' no-duck'}")
    if p.music.file:
        print(f"  music: {p.music.file} vol={p.music.volume} duck={p.music.duck}")


def _progress(frac, secs):
    bar = "#" * int(frac * 30)
    print(f"\r  [{bar:<30}] {frac * 100:5.1f}%  {fmt_time(secs)}", end="", flush=True)


def cmd_render(cfg, a, mode):
    p = _project(cfg, a.project)
    plan = render.build_plan(p, mode=mode)
    if a.dry_run:
        print(render.cmd_string(plan))
        return
    print(f"{mode}: {plan.layout.width}x{plan.layout.height}, {fmt_time(plan.layout.total)} -> {plan.output}")
    plan = render.render(p, mode=mode, progress=_progress)
    print()
    for w in plan.warnings:
        print("warning:", w)
    print(f"wrote {plan.output}")
    if a.open:
        subprocess.run(["open", str(plan.output)])


def cmd_serve(cfg, a):
    from .server import serve
    serve(cfg, port=a.port or cfg.port, open_browser=a.open)


def cmd_config(cfg, a):
    if a.pairs:
        for kv in a.pairs:
            k, _, v = kv.partition("=")
            if not hasattr(cfg, k):
                sys.exit(f"unknown setting {k}")
            setattr(cfg, k, type(getattr(cfg, k))(v))
        cfg.save()
    for k, v in cfg.public().items():
        print(f"{k}: {v}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="vlog", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("new"); s.add_argument("name", nargs="?"); s.add_argument("--title"); s.add_argument("--no-opening", dest="opening", action="store_false"); s.set_defaults(fn=cmd_new)
    s = sub.add_parser("add"); s.add_argument("project"); s.add_argument("files", nargs="+"); s.set_defaults(fn=cmd_add)
    s = sub.add_parser("pull"); s.add_argument("project"); s.add_argument("--date"); s.add_argument("--no-add", dest="add", action="store_false"); s.set_defaults(fn=cmd_pull)
    s = sub.add_parser("title"); s.add_argument("project"); s.add_argument("text"); s.add_argument("--sub"); s.add_argument("--kicker"); s.add_argument("--image"); s.add_argument("--dur", type=float, default=3.0); s.add_argument("--at", type=int); s.set_defaults(fn=cmd_title)
    s = sub.add_parser("masthead"); s.add_argument("project"); s.add_argument("--dur", type=float, default=3.0); s.add_argument("--at", type=int); s.set_defaults(fn=cmd_masthead)
    s = sub.add_parser("title-at"); s.add_argument("project"); s.add_argument("time"); s.add_argument("text"); s.add_argument("--sub"); s.add_argument("--dur", type=float, default=3.0); s.set_defaults(fn=cmd_title_at)
    s = sub.add_parser("cut", help="remove a stretch of the output timeline and close the gap"); s.add_argument("project"); s.add_argument("start"); s.add_argument("end"); s.set_defaults(fn=cmd_cut)
    s = sub.add_parser("keep", help="trim the clip(s) there to just that stretch"); s.add_argument("project"); s.add_argument("start"); s.add_argument("end"); s.set_defaults(fn=cmd_keep)
    s = sub.add_parser("caption"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("text"); s.add_argument("--at"); s.add_argument("--dur", type=float); s.add_argument("--position", default="bottom"); s.set_defaults(fn=cmd_caption)
    s = sub.add_parser("trim"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("--in", dest="in_"); s.add_argument("--out"); s.set_defaults(fn=cmd_trim)
    s = sub.add_parser("set"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("pairs", nargs="+"); s.set_defaults(fn=cmd_set)
    s = sub.add_parser("rm"); s.add_argument("project"); s.add_argument("seg"); s.set_defaults(fn=cmd_rm)
    s = sub.add_parser("pip", help="a second clip in a box over a clip (camera over a screen recording)"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("file", nargs="?", help="the inset's clip (omit to change an existing inset)"); s.add_argument("--layout", choices=list(edits.PIP_LAYOUTS), help="corner | corner-large | stacked | hidden"); s.add_argument("--pos", choices=list(edits.PIP_POSITIONS), help="corner for the corner layouts"); s.add_argument("--shape", choices=["round", "rect", "circle"]); s.add_argument("--box", help="x,y,w[,h] fractions of the frame (centre and size)"); s.add_argument("--offset", help="inset time = clip source time + offset"); s.add_argument("--swap", action="store_true", help="exchange the clip and its inset"); s.add_argument("--rm", action="store_true", help="remove the inset"); s.set_defaults(fn=cmd_pip)
    s = sub.add_parser("move"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("index", type=int); s.set_defaults(fn=cmd_move)
    s = sub.add_parser("music"); s.add_argument("project"); s.add_argument("file"); s.add_argument("--volume", type=float); s.set_defaults(fn=cmd_music)
    s = sub.add_parser("voiceover"); s.add_argument("project"); s.add_argument("file", help="audio file, or 'rm' with --at ID"); s.add_argument("--at", help="timeline time (or voiceover id with rm)"); s.add_argument("--volume", type=float); s.set_defaults(fn=cmd_voiceover)
    s = sub.add_parser("sting"); s.add_argument("project"); s.add_argument("file", help="audio file, 'intro' for the configured one, or 'rm' with --id"); s.add_argument("--from", dest="from_seg"); s.add_argument("--to", dest="to_seg"); s.add_argument("--start", help="offset into the file"); s.add_argument("--volume", type=float); s.add_argument("--no-duck", action="store_true", help="don't lower it under speech"); s.add_argument("--id"); s.set_defaults(fn=cmd_sting)
    s = sub.add_parser("image", help="a picture over the video for a few seconds"); s.add_argument("project"); s.add_argument("file", help="image file, or 'rm' with --id"); s.add_argument("--at", help="timeline time"); s.add_argument("--for", dest="dur", type=float, default=3.0); s.add_argument("--size", default="full", help="full | large | half | small | a fraction of the frame width"); s.add_argument("--pos", default="c", help="tl t tr l c r bl b br"); s.add_argument("--id"); s.set_defaults(fn=cmd_image)
    s = sub.add_parser("undo"); s.add_argument("project", nargs="?"); s.set_defaults(fn=cmd_undo)
    s = sub.add_parser("redo"); s.add_argument("project", nargs="?"); s.set_defaults(fn=lambda c, a: cmd_undo(c, a, True))
    s = sub.add_parser("show"); s.add_argument("project", nargs="?"); s.set_defaults(fn=cmd_show)
    for name, mode in (("preview", "preview"), ("render", "final")):
        s = sub.add_parser(name); s.add_argument("project", nargs="?"); s.add_argument("--open", action="store_true"); s.add_argument("--dry-run", action="store_true")
        s.set_defaults(fn=lambda cfg, a, m=mode: cmd_render(cfg, a, m))
    s = sub.add_parser("serve"); s.add_argument("--port", type=int); s.add_argument("--open", action="store_true"); s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("config"); s.add_argument("pairs", nargs="*"); s.set_defaults(fn=cmd_config)

    a = ap.parse_args(argv)
    cfg = Config.load()
    a.fn(cfg, a)


if __name__ == "__main__":
    main()
