"""Ingest: copy media into a project, make browser-friendly proxies and thumbnails."""
from __future__ import annotations

import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .probe import MediaInfo, probe
from .project import CHANNELS, Project

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
    measure_loudness(p.resolve(src_rel), p.cache_dir, "auto")    # + one-sided detection


def media_status(p: Project, src_rel: str) -> dict:
    return {"proxy": proxy_path(p, src_rel).exists(), "thumb": thumb_path(p, src_rel).exists()}


def browser_playable(info: MediaInfo | None) -> bool:
    """Can a browser <video> play the source file as-is (so it can stand in for the proxy)?"""
    return bool(info and info.has_video and not info.hdr and info.codec in ("h264", "vp8", "vp9", "av1")
                and max(info.width, info.height) <= 1920)


# --------------------------------------------------------------------------- loudness

# pan filters that copy one channel to both ears / sum both to mono (segment.channel)
CHANNEL_PAN = {
    "left": "pan=stereo|c0=c0|c1=c0",
    "right": "pan=stereo|c0=c1|c1=c1",
    "mix": "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1",
}
ONE_SIDED_DB = 20.0     # a channel this far below the other (and the other above -45 dB RMS) is "dead"


def _loud_cache(path: Path, cache_dir: Path | None, channel: str = "stereo") -> Path | None:
    if not cache_dir:
        return None
    return cache_dir / (path.name + (".loud.json" if channel == "stereo" else f".loud.{channel}.json"))


def _read_cache(f: Path | None, path: Path) -> dict | None:
    import json
    if f and f.exists():
        try:
            d = json.loads(f.read_text())
            if d.get("size") == path.stat().st_size:
                return d
        except Exception:
            pass
    return None


def _audio_stats(path: Path, af: str) -> tuple[float | None, list[float]]:
    """One ffmpeg pass over the audio: (integrated LUFS or None if silent, per-channel RMS dB)."""
    import json, re
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-vn", "-i", str(path), "-af",
                        af + "astats=measure_overall=none:measure_perchannel=RMS_level,loudnorm=print_format=json",
                        "-f", "null", "-"], capture_output=True, text=True)
    lufs: float | None = None
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if m:
        try:
            v = float(json.loads(m.group(0))["input_i"])
            lufs = v if v > -60 else None
        except Exception:
            lufs = None
    rms = []
    for v in re.findall(r"Channel: \d+\s*\n.*?RMS level dB: (\S+)", r.stderr, re.S):
        try:
            rms.append(max(-120.0, float(v)))
        except ValueError:
            rms.append(-120.0)
    return lufs, rms


def audio_analysis(path: Path, cache_dir: Path | None = None) -> dict:
    """Loudness (LUFS) and per-channel RMS (dB) of a file's audio as recorded; cached in
    cache/<name>.loud.json. `one_sided` is "left"/"right" when only that channel carries sound (a mic
    plugged into one channel), else None. lufs is None for no/silent audio."""
    import json
    path = Path(path)
    cache = _loud_cache(path, cache_dir)
    d = _read_cache(cache, path)
    if d and "rms" in d:
        return d
    lufs, rms = _audio_stats(path, "")
    side = None
    if len(rms) == 2:
        l, r = rms
        if l > -45 and r < l - ONE_SIDED_DB:
            side = "left"
        elif r > -45 and l < r - ONE_SIDED_DB:
            side = "right"
    d = {"size": path.stat().st_size, "lufs": lufs, "rms": [round(x, 1) for x in rms], "one_sided": side}
    if cache:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d))
    return d


def effective_channel(path: Path, cache_dir: Path | None, channel: str = "auto", compute: bool = True) -> str:
    """What a segment's `channel` setting means for this file: stereo | left | right | mix.
    auto → the live channel of a one-sided take, else stereo; left/right/mix on a mono file → stereo.
    compute=False only looks at the cache (unknown → stereo)."""
    path = Path(path)
    d = (audio_analysis(path, cache_dir) if compute else _read_cache(_loud_cache(path, cache_dir), path)) or {}
    if channel in CHANNEL_PAN:
        return channel if len(d.get("rms") or [0, 0]) >= 2 else "stereo"
    if channel == "stereo":
        return "stereo"
    return d.get("one_sided") or "stereo"


def measure_loudness(path: Path, cache_dir: Path | None = None, channel: str = "stereo") -> float | None:
    """Integrated loudness (LUFS) of a file's audio *as it will be heard* for `channel` (see
    effective_channel); cached. None if no/silent audio."""
    import json
    path = Path(path)
    ch = effective_channel(path, cache_dir, channel)
    if ch == "stereo":
        return audio_analysis(path, cache_dir).get("lufs")
    cache = _loud_cache(path, cache_dir, ch)
    d = _read_cache(cache, path)
    if d:
        return d.get("lufs")
    lufs, _ = _audio_stats(path, CHANNEL_PAN[ch] + ",")
    if cache:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"size": path.stat().st_size, "lufs": lufs}))
    return lufs


def cached_loudness(path: Path, cache_dir: Path | None, channel: str = "auto") -> float | None:
    """measure_loudness from the cache only (None when not measured yet)."""
    path = Path(path)
    ch = effective_channel(path, cache_dir, channel, compute=False)
    d = _read_cache(_loud_cache(path, cache_dir, ch), path)
    return d.get("lufs") if d else None


def one_sided(path: Path, cache_dir: Path | None) -> str | None:
    """The only live channel of a file ("left"/"right") from the cache; None if stereo or not measured."""
    d = _read_cache(_loud_cache(Path(path), cache_dir), Path(path))
    return d.get("one_sided") if d else None


def level_gain_db(lufs: float | None, target: float, limit: float = 12.0) -> float:
    """Gain (dB) that moves `lufs` to `target`, clamped to ±limit."""
    if lufs is None:
        return 0.0
    return max(-limit, min(limit, target - lufs))


# --------------------------------------------------------------------------- recordings

# Input flags that let ffmpeg read a recording whose last chunk was cut off by a crash.
_TOLERANT = ["-fflags", "+genpts+discardcorrupt+igndts", "-err_detect", "ignore_err"]


def ingest_recording(p: Project, blob: Path, kind: str, stamp: str, container: str = "webm") -> str:
    """Transcode a browser MediaRecorder stream (webm/mp4, possibly truncated) into a project asset.
    kind='clip' -> clips/REC_<stamp>.mp4 (H.264 + AAC); kind='voiceover' -> audio/VO_<stamp>.m4a.
    Returns the project-relative path."""
    p.ensure_dirs()
    fmt = ["-f", "matroska" if container == "webm" else "mp4"]
    if kind == "voiceover":
        dst = p.audio_dir / f"VO_{stamp}.m4a"
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *_TOLERANT, *fmt, "-i", str(blob), "-vn",
               "-af", "aresample=48000,highpass=f=70", "-c:a", "aac", "-b:a", "160k", "-ac", "1", "-movflags", "+faststart", str(dst)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-500:])
        rel = f"audio/{dst.name}"
        measure_loudness(dst, p.cache_dir)
        return rel
    # Fast path: the browser already encoded H.264/AAC (or VP8/VP9/Opus); just rewrite the container so the
    # file has a proper header/duration. Takes milliseconds, and the result plays in the browser as-is.
    try:
        binfo = probe(blob)
        has_audio = binfo.has_audio
    except Exception:
        binfo, has_audio = None, True
    if browser_playable(binfo):
        ext = ".mp4" if binfo.codec == "h264" else ".webm"
        dst = p.clips_dir / f"REC_{stamp}{ext}"
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *_TOLERANT, *fmt, "-i", str(blob), "-c", "copy",
               "-metadata", f"creation_time={stamp}"]
        cmd += ["-movflags", "+faststart"] if ext == ".mp4" else ["-cues_to_front", "1"]
        r = subprocess.run(cmd + [str(dst)], capture_output=True, text=True)
        if r.returncode == 0 and dst.exists() and dst.stat().st_size > 1000:
            try:
                info = probe(dst, p.cache_dir)
                if info.duration > 0 and browser_playable(info):
                    rel = f"clips/{dst.name}"
                    try:
                        make_thumbnail(p, rel)
                    except Exception:
                        pass
                    prepare_async(p, rel)      # proxy + loudness in the background
                    return rel
            except Exception:
                pass
        dst.unlink(missing_ok=True)
    dst = p.clips_dir / f"REC_{stamp}.mp4"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *_TOLERANT, *fmt, "-i", str(blob),
           "-vf", "scale='min(1920,iw)':-2,fps=30,format=yuv420p", "-c:v", "h264_videotoolbox", "-b:v", "12M",
           "-profile:v", "high", "-color_primaries:v", "bt709", "-color_trc:v", "bt709", "-colorspace:v", "bt709"]
    cmd += (["-af", "aresample=48000", "-c:a", "aac", "-b:a", "192k", "-ac", "2"] if has_audio else ["-an"])
    cmd += ["-movflags", "+faststart", "-metadata", f"creation_time={stamp}", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and has_audio:  # audio track may be unusable in a truncated file; keep the video
        cmd[cmd.index("-af"):cmd.index("-af") + 8] = ["-an"]
        r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists() or dst.stat().st_size < 1000:
        dst.unlink(missing_ok=True)
        raise RuntimeError(r.stderr[-500:] or "empty output")
    rel = f"clips/{dst.name}"
    probe(dst, p.cache_dir)
    try:
        make_thumbnail(p, rel)
    except Exception:
        pass
    prepare_async(p, rel)
    return rel


# --------------------------------------------------------------------------- filmstrips

def filmstrip(p: Project, src_rel: str, n: int = 8, start: float = 0.0, end: float | None = None, height: int = 72) -> Path:
    """n evenly spaced frames between start and end tiled into one JPEG (from the proxy when available)."""
    import hashlib
    src = proxy_path(p, src_rel) if proxy_path(p, src_rel).exists() else p.resolve(src_rel)
    info = probe(p.resolve(src_rel), p.cache_dir)
    end = info.duration if end is None else min(end, info.duration)
    start = max(0.0, min(start, end))
    dur = max(0.05, end - start)
    key = hashlib.sha1(f"v2|{src_rel}|{n}|{start:.2f}|{end:.2f}|{height}|{src.stat().st_mtime}".encode()).hexdigest()[:16]
    out = p.cache_dir / "strips" / f"{key}.jpg"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    fw = int(height * info.width / max(1, info.height)) if info.width and info.height else height
    fw += fw % 2
    # pick frame i at start + (i + 0.5) * dur / n. Input seeking resets timestamps to 0 at the seek
    # point, so the thresholds are measured from there, not from the start of the file.
    seek = max(0.0, start - 0.5)
    sel = "+".join(f"lt(prev_pts*TB,{start - seek + (i + 0.5) * dur / n:.3f})*gte(pts*TB,{start - seek + (i + 0.5) * dur / n:.3f})" for i in range(n))
    vf = f"select='{sel}',scale={fw}:{height},tile={n}x1"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{seek:.3f}", "-t", f"{dur + 1.5:.3f}",
           "-i", str(src), "-vf", vf, "-frames:v", "1", "-fps_mode", "passthrough", "-q:v", "5", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        # fallback: evenly sampled by fps
        vf = f"fps={n / dur:.6f},scale={fw}:{height},tile={n}x1"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
                        "-i", str(src), "-vf", vf, "-frames:v", "1", "-q:v", "5", str(out)], capture_output=True)
    if not out.exists():
        raise RuntimeError("filmstrip failed")
    return out


# --------------------------------------------------------------------------- waveforms

def waveform(p: Project, src_rel: str, start: float = 0.0, end: float | None = None, width: int = 800, height: int = 40,
             color: str = "ffffff") -> Path:
    """Transparent PNG of the audio envelope between start and end (seconds)."""
    import hashlib
    src = p.resolve(src_rel)
    pr = proxy_path(p, src_rel)
    use = pr if pr.exists() else src
    info = probe(src, p.cache_dir)
    end = info.duration if end is None else min(end, info.duration)
    start = max(0.0, min(start, end))
    dur = max(0.05, end - start)
    key = hashlib.sha1(f"{src_rel}|{start:.2f}|{end:.2f}|{width}|{height}|{color}".encode()).hexdigest()[:16]
    out = p.cache_dir / "waves" / f"{key}.png"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    if not info.has_audio:
        from PIL import Image
        Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(out)
        return out
    fc = f"aformat=channel_layouts=mono,showwavespic=s={width}x{height}:colors=#{color}:scale=sqrt:filter=peak"
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
                        "-i", str(use), "-vn", "-filter_complex", fc, "-frames:v", "1", str(out)], capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        from PIL import Image
        Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(out)
    return out


def sort_by_capture_time(p: Project, rels: list[str]) -> list[str]:
    def key(rel):
        try:
            info = probe(p.resolve(rel), p.cache_dir)
            return (info.created or "", rel)
        except Exception:
            return ("", rel)
    return sorted(rels, key=key)
