"""`vlog` command line. Every command edits project.yaml and/or runs ffmpeg.

    vlog new [NAME] [--title T]              create ~/Vlogs/NAME (default: today)
    vlog add PROJECT FILE...                 import clips (local files)
    vlog pull PROJECT [--date YYYY-MM-DD]    pull a day's videos from Immich
    vlog title PROJECT "Text" [--sub S] [--dur 3] [--at INDEX]
    vlog title-at PROJECT 0:32 "Text"        split the timeline at 0:32 and cut to a title card
    vlog caption PROJECT SEG "Text"          lower-third over a segment (SEG = id like s3, or index)
    vlog trim PROJECT SEG --in 0:03 --out 0:14
    vlog set PROJECT SEG key=value ...       e.g. mute=true speed=1.5 transition=fade
    vlog rm PROJECT SEG                      remove a segment
    vlog move PROJECT SEG INDEX              reorder
    vlog music PROJECT FILE [--volume 0.18]
    vlog voiceover PROJECT FILE --at 0:12          narration layer at a timeline time (GUI can record these)
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

from . import media, render
from .config import Config
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


def _seg(p: Project, ref: str):
    if ref.isdigit():
        return p.timeline[int(ref)]
    return p.timeline[p.index_of(ref)]


def _import(p: Project, path: Path) -> str:
    rel = media.import_file(p, path)
    media.prepare_async(p, rel)
    return rel


def cmd_new(cfg, a):
    name = a.name or dt.date.today().isoformat()
    folder = cfg.vlogs_path / name
    if (folder / "project.yaml").exists():
        sys.exit(f"project already exists: {folder}")
    p = Project.new(folder, title=a.title or name)
    p.output.orientation = cfg.default_orientation
    p.style.font = cfg.font
    p.style.transition = cfg.default_transition
    if cfg.default_music:
        p.music.file = cfg.default_music
    if a.opening:
        p.add_title(a.title or _pretty_date(name), cfg.default_title_subtitle, 3.0)
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
    p.add_title(a.text, a.sub or "", a.dur, at=a.at)
    p.save()
    print("ok")


def title_at(p: Project, t: float, text: str, subtitle: str = "", duration: float = 3.0) -> None:
    """Split the timeline at output time t and insert a title card there."""
    layout = render.compute_layout(p)
    pl, offset = render.locate(layout, t)
    if pl is None:
        p.add_title(text, subtitle, duration)
        return
    idx = pl.index
    if pl.seg.kind == "title" or offset < 0.25:
        p.add_title(text, subtitle, duration, at=idx)
        return
    if pl.duration - offset < 0.25:
        p.add_title(text, subtitle, duration, at=idx + 1)
        return
    seg = pl.seg
    split_src = pl.src_in + offset * seg.speed
    second = Overlay  # noqa (keep import used)
    from copy import deepcopy
    tail = deepcopy(seg)
    tail.id = p.next_id()
    tail.in_ = split_src
    tail.out = pl.src_out
    tail.caption = None
    tail.transition = None
    kept = []
    for ov in seg.overlays:
        if ov.at >= offset:
            ov2 = deepcopy(ov)
            ov2.at = ov.at - offset
            kept.append(ov2)
    tail.overlays = kept
    seg.out = split_src
    seg.overlays = [ov for ov in seg.overlays if ov.at < offset]
    p.timeline.insert(idx + 1, tail)
    p.add_title(text, subtitle, duration, at=idx + 1)


def cmd_title_at(cfg, a):
    p = _project(cfg, a.project)
    title_at(p, parse_time(a.time), a.text, a.sub or "", a.dur)
    p.save()
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
    s = _seg(p, a.seg)
    if a.in_ is not None:
        s.in_ = parse_time(a.in_)
    if a.out is not None:
        s.out = None if a.out in ("end", "none") else parse_time(a.out)
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
        elif isinstance(cur, float):
            v = float(v)
        setattr(s, k, v)
    p.save()
    print("ok")


def cmd_rm(cfg, a):
    p = _project(cfg, a.project)
    s = _seg(p, a.seg)
    p.remove(s.id)
    p.save()
    print("ok")


def cmd_move(cfg, a):
    p = _project(cfg, a.project)
    s = _seg(p, a.seg)
    p.move(s.id, a.index)
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


def cmd_show(cfg, a):
    p = _project(cfg, a.project)
    layout = render.compute_layout(p)
    print(f"{p.title}  [{layout.width}x{layout.height} @ {layout.fps}fps]  total {fmt_time(layout.total)}")
    for pl in layout.placed:
        s = pl.seg
        tr = "" if pl.transition == "cut" else f" ({pl.transition} {pl.transition_duration}s)"
        if s.kind == "title":
            desc = f"TITLE  {s.text!r}" + (f" / {s.subtitle!r}" if s.subtitle else "")
        else:
            desc = f"CLIP   {s.src}  [{fmt_time(pl.src_in)} - {fmt_time(pl.src_out)}]"
            if s.speed != 1:
                desc += f" x{s.speed}"
            if s.mute:
                desc += " muted"
            if s.caption:
                desc += f"  caption={s.caption!r}"
            for ov in s.overlays:
                desc += f"  overlay@{fmt_time(ov.at)}={ov.text!r}"
        print(f"  {s.id:>4}  {fmt_time(pl.start):>7} - {fmt_time(pl.end):<7} {desc}{tr}")
    for v in p.voiceovers:
        print(f"  {v.id:>4}  {fmt_time(v.at):>7}          VOICE  {v.file} vol={v.volume}{'' if v.duck_clips else ' no-duck'}")
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
    s = sub.add_parser("title"); s.add_argument("project"); s.add_argument("text"); s.add_argument("--sub"); s.add_argument("--dur", type=float, default=3.0); s.add_argument("--at", type=int); s.set_defaults(fn=cmd_title)
    s = sub.add_parser("title-at"); s.add_argument("project"); s.add_argument("time"); s.add_argument("text"); s.add_argument("--sub"); s.add_argument("--dur", type=float, default=3.0); s.set_defaults(fn=cmd_title_at)
    s = sub.add_parser("caption"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("text"); s.add_argument("--at"); s.add_argument("--dur", type=float); s.add_argument("--position", default="bottom"); s.set_defaults(fn=cmd_caption)
    s = sub.add_parser("trim"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("--in", dest="in_"); s.add_argument("--out"); s.set_defaults(fn=cmd_trim)
    s = sub.add_parser("set"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("pairs", nargs="+"); s.set_defaults(fn=cmd_set)
    s = sub.add_parser("rm"); s.add_argument("project"); s.add_argument("seg"); s.set_defaults(fn=cmd_rm)
    s = sub.add_parser("move"); s.add_argument("project"); s.add_argument("seg"); s.add_argument("index", type=int); s.set_defaults(fn=cmd_move)
    s = sub.add_parser("music"); s.add_argument("project"); s.add_argument("file"); s.add_argument("--volume", type=float); s.set_defaults(fn=cmd_music)
    s = sub.add_parser("voiceover"); s.add_argument("project"); s.add_argument("file", help="audio file, or 'rm' with --at ID"); s.add_argument("--at", help="timeline time (or voiceover id with rm)"); s.add_argument("--volume", type=float); s.set_defaults(fn=cmd_voiceover)
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
