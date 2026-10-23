"""Ingest: copy media into a project, make browser-friendly proxies and thumbnails."""
from __future__ import annotations

import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .probe import MediaInfo, probe
from .project import Project

PROXY_H = 540
_pool = ThreadPoolExecutor(max_workers=2)


def proxy_path(p: Project, src_rel: str) -> Path:
    return p.cache_dir / (Path(src_rel).name + ".proxy.mp4")


def thumb_path(p: Project, src_rel: str) -> Path:
    return p.cache_dir / (Path(src_rel).name + ".thumb.jpg")


def _hdr_vf(info: MediaInfo, w: int, h: int) -> list[str]:
    if info.hdr:
        return ["hwupload", f"scale_vt=w={w}:h={h}:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709",
                "hwdownload", "format=p010le"]
    return []


def make_thumbnail(p: Project, src_rel: str, t: float | None = None, force: bool = False) -> Path:
    src = p.resolve(src_rel)
    dst = thumb_path(p, src_rel)
    if dst.exists() and not force:
        return dst
    info = probe(src, p.cache_dir)
    if t is None:
        t = min(1.0, info.duration / 2)
    fw, fh = _fit_dims(info, 480, 480)
    vf = ",".join(_hdr_vf(info, fw, fh) + [f"scale={fw}:{fh}", "format=yuv420p"])
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if info.hdr:
        cmd += ["-init_hw_device", "videotoolbox=vt", "-filter_hw_device", "vt"]
    cmd += ["-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", "-vf", vf, "-q:v", "4", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and info.hdr:  # software fallback
        vf = f"scale={fw}:{fh}:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709,format=yuv420p"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", str(src),
                        "-frames:v", "1", "-vf", vf, "-q:v", "4", str(dst)], check=True)
    elif r.returncode != 0:
        raise RuntimeError(r.stderr)
    return dst


def _fit_dims(info: MediaInfo, max_w: int, max_h: int) -> tuple[int, int]:
    if info.width <= 0 or info.height <= 0:
        return max_w, max_h
    r = min(max_w / info.width, max_h / info.height, 1.0)
    w, h = int(info.width * r), int(info.height * r)
    return w - w % 2, h - h % 2


def make_proxy(p: Project, src_rel: str, force: bool = False) -> Path:
    """H.264 540p proxy that any browser can scrub. Keeps the source's duration/timing."""
    src = p.resolve(src_rel)
    dst = proxy_path(p, src_rel)
    if dst.exists() and not force:
        return dst
    info = probe(src, p.cache_dir)
    fw, fh = _fit_dims(info, 960, PROXY_H) if not info.portrait else _fit_dims(info, PROXY_H, 960)
    vf = ",".join(_hdr_vf(info, fw, fh) + [f"scale={fw}:{fh}", "fps=30", "format=yuv420p"])
    tmp = dst.with_suffix(".tmp.mp4")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if info.hdr:
        cmd += ["-init_hw_device", "videotoolbox=vt", "-filter_hw_device", "vt"]
    cmd += ["-i", str(src), "-vf", vf, "-c:v", "h264_videotoolbox", "-b:v", "2M", "-profile:v", "main",
            "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    cmd += (["-c:a", "aac", "-b:a", "96k", "-ac", "2"] if info.has_audio else ["-an"])
    cmd += ["-movflags", "+faststart", str(tmp)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and info.hdr:
        vf = f"scale={fw}:{fh}:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709,fps=30,format=yuv420p"
        cmd = [c for c in cmd if c not in ("-init_hw_device", "videotoolbox=vt", "-filter_hw_device", "vt")]
        cmd[cmd.index("-vf") + 1] = vf
        r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    tmp.rename(dst)
    return dst


def import_file(p: Project, src: Path, copy: bool = True) -> str:
    """Bring a media file into clips/. Returns the project-relative path."""
    src = Path(src).expanduser().resolve()
    p.ensure_dirs()
    dst = p.clips_dir / src.name
    if dst.exists() and dst.stat().st_size == src.stat().st_size:
        return f"clips/{dst.name}"
    if dst.exists():
        stem, suf = src.stem, src.suffix
        n = 2
        while (p.clips_dir / f"{stem}_{n}{suf}").exists():
            n += 1
        dst = p.clips_dir / f"{stem}_{n}{suf}"
    if copy:
        shutil.copy2(src, dst)
    else:
        dst.symlink_to(src)
    return f"clips/{dst.name}"


def prepare_async(p: Project, src_rel: str) -> None:
    """Kick off thumbnail + proxy generation in the background."""
    def work():
        try:
            prepare(p, src_rel)
        except Exception as e:  # pragma: no cover
            print(f"[media] prepare failed for {src_rel}: {e}")
    _pool.submit(work)


def prepare(p: Project, src_rel: str) -> None:
    make_thumbnail(p, src_rel)
    make_proxy(p, src_rel)
    measure_loudness(p.resolve(src_rel), p.cache_dir)


def media_status(p: Project, src_rel: str) -> dict:
    return {"proxy": proxy_path(p, src_rel).exists(), "thumb": thumb_path(p, src_rel).exists()}


# --------------------------------------------------------------------------- loudness

def measure_loudness(path: Path, cache_dir: Path | None = None) -> float | None:
    """Integrated loudness (LUFS) of a file's audio via ffmpeg loudnorm; cached. None if no/silent audio."""
    import json, re
    path = Path(path)
    cache = (cache_dir / (path.name + ".loud.json")) if cache_dir else None
    if cache and cache.exists():
        try:
            d = json.loads(cache.read_text())
            if d.get("size") == path.stat().st_size:
                return d.get("lufs")
        except Exception:
            pass
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-vn", "-i", str(path), "-af",
                        "loudnorm=print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    lufs: float | None = None
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if m:
        try:
            v = float(json.loads(m.group(0))["input_i"])
            lufs = v if v > -60 else None
        except Exception:
            lufs = None
    if cache:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"size": path.stat().st_size, "lufs": lufs}))
    return lufs


def level_gain_db(lufs: float | None, target: float, limit: float = 12.0) -> float:
    """Gain (dB) that moves `lufs` to `target`, clamped to ±limit."""
    if lufs is None:
        return 0.0
    return max(-limit, min(limit, target - lufs))


# --------------------------------------------------------------------------- recordings

def ingest_recording(p: Project, blob: Path, kind: str, stamp: str) -> str:
    """Transcode a browser MediaRecorder blob (webm/mp4) into a proper project asset.
    kind='clip' -> clips/REC_<stamp>.mp4 (H.264 + AAC); kind='voiceover' -> audio/VO_<stamp>.m4a.
    Returns the project-relative path."""
    p.ensure_dirs()
    if kind == "voiceover":
        dst = p.audio_dir / f"VO_{stamp}.m4a"
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(blob), "-vn",
               "-af", "aresample=48000,highpass=f=70", "-c:a", "aac", "-b:a", "160k", "-ac", "1", "-movflags", "+faststart", str(dst)]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        rel = f"audio/{dst.name}"
        measure_loudness(dst, p.cache_dir)
        return rel
    dst = p.clips_dir / f"REC_{stamp}.mp4"
    info = probe(blob)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(blob),
           "-vf", "scale='min(1920,iw)':-2,fps=30,format=yuv420p", "-c:v", "h264_videotoolbox", "-b:v", "12M",
           "-profile:v", "high", "-color_primaries:v", "bt709", "-color_trc:v", "bt709", "-colorspace:v", "bt709"]
    cmd += (["-af", "aresample=48000", "-c:a", "aac", "-b:a", "192k", "-ac", "2"] if info.has_audio else ["-an"])
    cmd += ["-movflags", "+faststart", "-metadata", f"creation_time={stamp}", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-500:])
    rel = f"clips/{dst.name}"
    probe(dst, p.cache_dir)
    prepare(p, rel)
    measure_loudness(dst, p.cache_dir)
    return rel
