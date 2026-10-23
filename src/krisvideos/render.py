"""Build and run one ffmpeg command that renders a whole project.

The graph: every segment is conformed to the output canvas (scale+pad, fps,
yuv420p, 48k stereo), text is overlaid from Pillow-rendered PNGs, then segments
are joined pairwise (concat for cuts, xfade/acrossfade for fades), then music is
mixed under with optional ducking, then global fades and loudness normalization.
"""
from __future__ import annotations

import os
import re
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import media, titles
from .probe import MediaInfo, probe
from .project import Overlay, Project, Segment

AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
CANVAS = {"portrait": (1080, 1920), "landscape": (1920, 1080), "square": (1080, 1080)}


@dataclass
class Placed:
    """A segment placed on the output timeline."""
    seg: Segment
    index: int
    start: float
    duration: float        # effective duration on the timeline (after speed)
    transition: str        # transition INTO this segment ("cut" for first)
    transition_duration: float
    info: MediaInfo | None = None
    src_in: float = 0.0
    src_out: float = 0.0

    @property
    def end(self) -> float:
        return self.start + self.duration

    def to_dict(self) -> dict:
        d = {
            "id": self.seg.id, "kind": self.seg.kind, "index": self.index,
            "start": round(self.start, 3), "end": round(self.end, 3), "duration": round(self.duration, 3),
            "transition": self.transition, "transition_duration": self.transition_duration,
            "src_in": round(self.src_in, 3), "src_out": round(self.src_out, 3),
        }
        return d


@dataclass
class Layout:
    width: int
    height: int
    fps: int
    placed: list[Placed]
    total: float
    orientation: str


@dataclass
class Plan:
    cmd: list[str]
    output: Path
    layout: Layout
    hdr_mode: str = "vt"
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- layout

def _even(n: float) -> int:
    n = int(round(n))
    return n if n % 2 == 0 else n - 1


def probe_project(p: Project) -> dict[str, MediaInfo]:
    infos: dict[str, MediaInfo] = {}
    for s in p.timeline:
        if s.kind == "clip" and s.src not in infos:
            path = p.resolve(s.src)
            if not path.exists():
                raise FileNotFoundError(f"clip not found: {s.src}")
            infos[s.src] = probe(path, p.cache_dir)
    return infos


def pick_orientation(p: Project, infos: dict[str, MediaInfo]) -> str:
    if p.output.orientation != "auto":
        return p.output.orientation
    # Vote by total duration. Clips set to crop-to-fill (e.g. webcam recordings) adapt to any
    # canvas, so they only vote when nothing else does.
    votes = {"contain": [0.0, 0.0], "cover": [0.0, 0.0]}
    for s in p.timeline:
        if s.kind == "clip" and s.src in infos:
            info = infos[s.src]
            dur = (info.duration if s.out is None else s.out) - s.in_
            votes[s.fit if s.fit == "cover" else "contain"][0 if info.portrait else 1] += max(0.0, dur)
    por, land = votes["contain"] if sum(votes["contain"]) > 0 else votes["cover"]
    if por == 0 and land == 0:
        return "landscape"
    return "portrait" if por >= land else "landscape"


def compute_layout(p: Project, infos: dict[str, MediaInfo] | None = None, scale: float = 1.0) -> Layout:
    infos = infos if infos is not None else probe_project(p)
    orientation = pick_orientation(p, infos)
    if p.output.width and p.output.height:
        w, h = p.output.width, p.output.height
    else:
        w, h = CANVAS[orientation]
        res = p.output.resolution if p.output.resolution in (720, 1080, 2160) else 1080
        w, h = w * res / 1080, h * res / 1080
    w, h = _even(w * scale), _even(h * scale)
    placed: list[Placed] = []
    t = 0.0
    for i, s in enumerate(p.timeline):
        if s.kind == "clip":
            info = infos[s.src]
            src_in = max(0.0, min(s.in_, info.duration))
            src_out = info.duration if s.out is None else max(src_in, min(s.out, info.duration))
            dur = (src_out - src_in) / max(0.05, s.speed)
        else:
            info, src_in, src_out = None, 0.0, 0.0
            dur = max(0.2, s.duration)
        trans = "cut" if i == 0 else (s.transition or p.style.transition or "cut")
        tdur = 0.0
        if i > 0 and trans != "cut":
            tdur = s.transition_duration if s.transition_duration is not None else p.style.transition_duration
            tdur = max(0.0, min(tdur, placed[-1].duration / 2, dur / 2))
            if tdur <= 0.05:
                trans, tdur = "cut", 0.0
        t -= tdur
        placed.append(Placed(seg=s, index=i, start=t, duration=dur, transition=trans,
                             transition_duration=tdur, info=info, src_in=src_in, src_out=src_out))
        t += dur
    return Layout(width=w, height=h, fps=int(p.output.fps or 30), placed=placed, total=max(0.0, t),
                  orientation=orientation)


def locate(layout: Layout, t: float) -> tuple[Placed | None, float]:
    """Map an output-timeline time to (placed segment, seconds into that segment)."""
    for pl in layout.placed:
        if pl.start <= t < pl.end:
            return pl, t - pl.start
    if layout.placed and t >= layout.total:
        pl = layout.placed[-1]
        return pl, pl.duration
    return None, 0.0


# --------------------------------------------------------------------------- graph

def _hdr_chain(mode: str, fit_w: int, fit_h: int) -> str:
    if mode == "vt":
        return (f"hwupload,scale_vt=w={fit_w}:h={fit_h}:color_matrix=bt709:color_primaries=bt709:"
                f"color_transfer=bt709,hwdownload,format=p010le,")
    if mode == "sw":
        return (f"scale={fit_w}:{fit_h}:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:"
                f"intent=perceptual,")
    return ""


def _fit(iw: int, ih: int, W: int, H: int) -> tuple[int, int]:
    if iw <= 0 or ih <= 0:
        return W, H
    r = min(W / iw, H / ih)
    return _even(iw * r), _even(ih * r)


def _atempo(speed: float) -> str:
    """Chain atempo filters so every factor stays in [0.5, 100]."""
    parts = []
    s = speed
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    while s > 100:
        parts.append("atempo=100")
        s /= 100
    parts.append(f"atempo={s:.4f}")
    return ",".join(parts)


def _hexcolor(s: str) -> str:
    return "0x" + s.strip().lstrip("#")[:6]


def build_plan(p: Project, mode: str = "final", hdr_mode: str = "vt", infos=None) -> Plan:
    """mode: 'final' or 'preview' (half-res, fast encode)."""
    infos = infos if infos is not None else probe_project(p)
    scale = 0.5 if mode == "preview" else 1.0
    layout = compute_layout(p, infos, scale=scale)
    W, H, FPS = layout.width, layout.height, layout.fps
    st = p.style
    warnings: list[str] = []
    if not layout.placed:
        raise ValueError("timeline is empty")

    inputs: list[str] = []
    filters: list[str] = []
    n_in = 0

    def add_input(args: list[str]) -> int:
        nonlocal n_in
        inputs.extend(args)
        n_in += 1
        return n_in - 1

    v_labels: list[str] = []
    a_labels: list[str] = []
    any_hdr = False

    for pl in layout.placed:
        s, i = pl.seg, pl.index
        dur = pl.duration
        if s.kind == "title":
            bg, fg = s.bg or st.title_bg, s.fg or st.title_fg
            png = titles.render_title_card(p.cache_dir, W, H, s.text, s.subtitle, font=st.font, bg=bg,
                                           fg=fg, accent=st.title_accent, layout=s.layout)
            k = add_input(["-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(png)])
            tf = min(st.title_fade, dur / 3)
            fade = ""
            if tf > 0:
                c = _hexcolor(bg)
                fade = f",fade=t=in:st=0:d={tf:.3f}:c={c},fade=t=out:st={dur - tf:.3f}:d={tf:.3f}:c={c}"
            filters.append(f"[{k}:v]format=yuv420p,setsar=1,fps={FPS},trim=duration={dur:.3f},setpts=PTS-STARTPTS{fade},settb=AVTB[v{i}]")
            filters.append(f"anullsrc=r=48000:cl=stereo:d={dur:.3f}[a{i}]")
        else:
            info = pl.info
            assert info is not None
            src = p.resolve(s.src)
            seek = ["-ss", f"{pl.src_in:.3f}"] if pl.src_in > 0 else []
            k = add_input(seek + ["-t", f"{(pl.src_out - pl.src_in):.3f}", "-i", str(src)])
            vchain = ["setpts=PTS-STARTPTS"]
            if s.speed != 1.0:
                vchain.append(f"setpts=PTS/{s.speed}")
            fw, fh = _fit(info.width, info.height, W, H)
            if info.hdr and hdr_mode != "none":
                any_hdr = True
                vchain.append(_hdr_chain(hdr_mode, fw, fh).rstrip(","))
            if s.fit == "cover":
                vchain.append(f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=bicubic,crop={W}:{H}")
            else:
                vchain.append(f"scale={fw}:{fh}:flags=bicubic")
                if (fw, fh) != (W, H):
                    vchain.append(f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black")
            vchain.append(f"setsar=1,fps={FPS},format=yuv420p,trim=duration={dur:.3f},setpts=PTS-STARTPTS")
            filters.append(f"[{k}:v]{','.join(vchain)}[vb{i}]")
            cur = f"vb{i}"
            # captions/overlays
            ovs = list(s.overlays)
            if s.caption:
                ovs.insert(0, Overlay(text=s.caption, at=0.0, duration=None))
            for j, ov in enumerate(ovs):
                a = max(0.0, min(ov.at, dur))
                b = dur if ov.duration is None else min(dur, a + ov.duration)
                if b - a < 0.1:
                    continue
                png = titles.render_caption(p.cache_dir, W, H, ov.text, font=st.font, bg=st.caption_bg,
                                            fg=st.caption_fg, position=ov.position, style=ov.style)
                ko = add_input(["-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(png)])
                f_in = min(0.3, (b - a) / 3)
                filters.append(
                    f"[{ko}:v]format=rgba,fade=t=in:st={a:.3f}:d={f_in:.3f}:alpha=1,"
                    f"fade=t=out:st={b - f_in:.3f}:d={f_in:.3f}:alpha=1[ov{i}_{j}]")
                filters.append(
                    f"[{cur}][ov{i}_{j}]overlay=0:0:eof_action=pass:enable='between(t,{a:.3f},{b:.3f})'[vo{i}_{j}]")
                cur = f"vo{i}_{j}"
            filters.append(f"[{cur}]settb=AVTB[v{i}]")
            # audio
            if info.has_audio and not s.mute and s.volume > 0:
                achain = ["asetpts=PTS-STARTPTS"]
                if s.speed != 1.0:
                    achain.append(_atempo(s.speed))
                achain.append(AUDIO_FMT)
                gain = 0.0
                if p.audio.match_levels:
                    gain = media.level_gain_db(media.measure_loudness(src, p.cache_dir), p.audio.target_lufs)
                if s.volume != 1.0 or abs(gain) > 0.1:
                    achain.append(f"volume={s.volume}*{10 ** (gain / 20):.4f}")
                achain.append(f"atrim=duration={dur:.3f},asetpts=PTS-STARTPTS,apad=whole_dur={dur:.3f}")
                filters.append(f"[{k}:a]{','.join(achain)}[a{i}]")
            else:
                filters.append(f"anullsrc=r=48000:cl=stereo:d={dur:.3f}[a{i}]")
        v_labels.append(f"v{i}")
        a_labels.append(f"a{i}")

    # join segments: runs of cut-joined segments go through ONE concat filter with video and
    # audio together (ffmpeg pads the shorter stream per segment, keeping A/V in sync); runs are
    # joined to each other with xfade / acrossfade.
    groups: list[list[int]] = [[0]]
    for n, pl in enumerate(layout.placed[1:], start=1):
        if pl.transition == "cut" or pl.transition_duration <= 0:
            groups[-1].append(n)
        else:
            groups.append([n])

    def join_group(gi: int, idxs: list[int]) -> tuple[str, str]:
        if len(idxs) == 1:
            return v_labels[idxs[0]], a_labels[idxs[0]]
        ins = "".join(f"[{v_labels[i]}][{a_labels[i]}]" for i in idxs)
        filters.append(f"{ins}concat=n={len(idxs)}:v=1:a=1[gv{gi}][ga{gi}]")
        return f"gv{gi}", f"ga{gi}"

    V, A = join_group(0, groups[0])
    acc = sum(layout.placed[i].duration for i in groups[0])
    for gi, idxs in enumerate(groups[1:], start=1):
        gv, ga = join_group(gi, idxs)
        pl = layout.placed[idxs[0]]
        d = pl.transition_duration
        kind = "fadeblack" if pl.transition == "dip" else "fade"
        filters.append(f"[{V}][{gv}]xfade=transition={kind}:duration={d:.3f}:offset={acc - d:.3f}[V{gi}]")
        filters.append(f"[{A}][{ga}]acrossfade=d={d:.3f}:c1=tri:c2=tri[A{gi}]")
        acc += sum(layout.placed[i].duration for i in idxs) - d
        V, A = f"V{gi}", f"A{gi}"
    total = layout.total

    # global video fades
    vf = []
    if st.fade_in > 0:
        vf.append(f"fade=t=in:st=0:d={min(st.fade_in, total / 2):.3f}")
    if st.fade_out > 0:
        fo = min(st.fade_out, total / 2)
        vf.append(f"fade=t=out:st={total - fo:.3f}:d={fo:.3f}")
    vf.append("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709")
    filters.append(f"[{V}]{','.join(vf)}[vout]")

    # voiceovers (narration layers), mixed over the segment audio with optional ducking
    vos = [v for v in p.voiceovers if p.resolve(v.file).exists() and v.at < total]
    for v in p.voiceovers:
        if not p.resolve(v.file).exists():
            warnings.append(f"voiceover file not found: {v.file}")
    if vos:
        labels = []
        for n, v in enumerate(vos):
            kv = add_input(["-i", str(p.resolve(v.file))])
            gain = media.level_gain_db(media.measure_loudness(p.resolve(v.file), p.cache_dir), p.audio.target_lufs) if p.audio.match_levels else 0.0
            filters.append(f"[{kv}:a]{AUDIO_FMT},volume={v.volume}*{10 ** (gain / 20):.4f},"
                           f"adelay={int(v.at * 1000)}:all=1,atrim=duration={total:.3f},apad=whole_dur={total:.3f}[vo{n}]")
            labels.append(f"vo{n}")
        if len(labels) == 1:
            filters.append(f"[{labels[0]}]anull[vobus]")
        else:
            filters.append("".join(f"[{l}]" for l in labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0[vobus]")
        if any(v.duck_clips for v in vos):
            filters.append("[vobus]asplit[vomix][vokey]")
            filters.append(f"[{A}][vokey]sidechaincompress=threshold=0.03:ratio=6:attack=80:release=700:makeup=1[Aducked]")
            filters.append("[Aducked][vomix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[Avo]")
        else:
            filters.append(f"[{A}][vobus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[Avo]")
        A = "Avo"

    # music
    if p.music.file:
        mpath = p.resolve(p.music.file)
        if mpath.exists():
            seek = ["-ss", f"{p.music.start:.3f}"] if p.music.start else []
            km = add_input(["-stream_loop", "-1"] + seek + ["-i", str(mpath)])
            mfo = min(p.music.fade_out, total / 2)
            filters.append(
                f"[{km}:a]{AUDIO_FMT},atrim=duration={total:.3f},asetpts=PTS-STARTPTS,volume={p.music.volume},"
                f"afade=t=out:st={total - mfo:.3f}:d={mfo:.3f}[music]")
            if p.music.duck:
                filters.append(f"[{A}]asplit[Aspeech][Akey]")
                filters.append("[music][Akey]sidechaincompress=threshold=0.04:ratio=5:attack=150:release=900:makeup=1[ducked]")
                filters.append("[Aspeech][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[Amix]")
            else:
                filters.append(f"[{A}][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[Amix]")
            A = "Amix"
        else:
            warnings.append(f"music file not found: {p.music.file}")

    af = []
    if st.fade_in > 0:
        af.append(f"afade=t=in:st=0:d={min(st.fade_in, total / 2):.3f}")
    if st.fade_out > 0:
        fo = min(st.fade_out, total / 2)
        af.append(f"afade=t=out:st={total - fo:.3f}:d={fo:.3f}")
    if p.audio.normalize and mode == "final":
        af.append("loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000")
    if p.audio.master_volume != 1.0:
        af.append(f"volume={p.audio.master_volume}")
    filters.append(f"[{A}]{','.join(af) if af else 'anull'}[aout]")

    # encoder
    p.ensure_dirs()
    if mode == "preview":
        out = p.out_dir / "preview.mp4"
        venc = ["-c:v", "h264_videotoolbox", "-b:v", "3M", "-realtime", "1", "-profile:v", "main"]
        aenc = ["-c:a", "aac", "-b:a", "128k"]
    else:
        out = p.out_dir / p.output_filename()
        pixels = W * H * FPS
        base = {"high": 16_000_000, "medium": 9_000_000}.get(p.output.quality, 16_000_000)
        br = int(base * pixels / (1920 * 1080 * 30))
        if p.output.codec == "hevc":
            venc = ["-c:v", "hevc_videotoolbox", "-b:v", str(int(br * 0.6)), "-tag:v", "hvc1", "-profile:v", "main"]
        else:
            venc = ["-c:v", "h264_videotoolbox", "-b:v", str(br), "-profile:v", "high", "-tag:v", "avc1"]
        aenc = ["-c:a", "aac", "-b:a", "192k"]

    cmd = ["ffmpeg", "-hide_banner", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
    if any_hdr and hdr_mode == "vt":
        cmd += ["-init_hw_device", "videotoolbox=vt", "-filter_hw_device", "vt"]
    cmd += inputs
    cmd += ["-filter_complex", ";\n".join(filters), "-map", "[vout]", "-map", "[aout]"]
    cmd += venc + aenc
    cmd += ["-r", str(FPS), "-pix_fmt", "yuv420p", "-color_primaries:v", "bt709", "-color_trc:v", "bt709",
            "-colorspace:v", "bt709", "-movflags", "+faststart", "-t", f"{total:.3f}",
            "-metadata", f"title={p.title}", str(out)]
    return Plan(cmd=cmd, output=out, layout=layout, hdr_mode=hdr_mode, warnings=warnings)


# --------------------------------------------------------------------------- run

class RenderError(RuntimeError):
    pass


def run_plan(plan: Plan, progress: Callable[[float, float], None] | None = None,
             cancel: threading.Event | None = None) -> Path:
    """Run ffmpeg; progress(fraction, seconds_done). Raises RenderError on failure."""
    proc = subprocess.Popen(plan.cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    total = max(plan.layout.total, 0.001)
    err_lines: list[str] = []

    def drain_err():
        assert proc.stderr
        for line in proc.stderr:
            err_lines.append(line.rstrip())

    t = threading.Thread(target=drain_err, daemon=True)
    t.start()
    assert proc.stdout
    for line in proc.stdout:
        if cancel is not None and cancel.is_set():
            proc.kill()
            raise RenderError("cancelled")
        m = re.match(r"out_time_us=(\d+)", line)
        if m and progress:
            secs = int(m.group(1)) / 1_000_000
            progress(min(1.0, secs / total), secs)
    proc.wait()
    t.join(timeout=2)
    if proc.returncode != 0:
        raise RenderError("\n".join(err_lines[-30:]) or f"ffmpeg exited {proc.returncode}")
    if progress:
        progress(1.0, total)
    return plan.output


def render(p: Project, mode: str = "final", progress=None, cancel=None, hdr_mode: str = "vt") -> Plan:
    """Build + run, retrying with software HDR conversion if VideoToolbox path fails."""
    infos = probe_project(p)
    plan = build_plan(p, mode=mode, hdr_mode=hdr_mode, infos=infos)
    try:
        run_plan(plan, progress, cancel)
    except RenderError as e:
        if "cancelled" in str(e):
            raise
        if hdr_mode == "vt" and any(i.hdr for i in infos.values()):
            plan = build_plan(p, mode=mode, hdr_mode="sw", infos=infos)
            plan.warnings.append("VideoToolbox HDR conversion failed; used software path")
            run_plan(plan, progress, cancel)
        else:
            raise
    return plan


def cmd_string(plan: Plan) -> str:
    import shlex
    return " ".join(shlex.quote(c) for c in plan.cmd)
