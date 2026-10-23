"""ffprobe wrapper with on-disk cache (cache/<name>.probe.json)."""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path

VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".mkv", ".avi", ".webm", ".mts", ".m2ts", ".3gp"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".aiff", ".ogg"}


@dataclass
class MediaInfo:
    path: str
    duration: float
    width: int            # display width after rotation
    height: int
    fps: float
    has_audio: bool
    has_video: bool
    rotation: int
    hdr: bool
    color_transfer: str
    codec: str
    size: int
    mtime: float
    created: str = ""     # creation_time tag if present

    @property
    def portrait(self) -> bool:
        return self.height > self.width

    def to_dict(self) -> dict:
        d = asdict(self)
        d["portrait"] = self.portrait
        return d


def _run_ffprobe(path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def _parse_fps(s: str | None) -> float:
    if not s or s == "0/0":
        return 0.0
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b) if float(b) else 0.0
    return float(s)


def probe(path: Path, cache_dir: Path | None = None) -> MediaInfo:
    path = Path(path)
    st = path.stat()
    cache_file = None
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / (path.name + ".probe.json")
        if cache_file.exists():
            try:
                d = json.loads(cache_file.read_text())
                if d.get("size") == st.st_size and abs(d.get("mtime", 0) - st.st_mtime) < 1:
                    d.pop("portrait", None)
                    return MediaInfo(**d)
            except Exception:
                pass
    raw = _run_ffprobe(path)
    v = next((s for s in raw.get("streams", []) if s.get("codec_type") == "video"
              and s.get("disposition", {}).get("attached_pic", 0) == 0), None)
    a = next((s for s in raw.get("streams", []) if s.get("codec_type") == "audio"), None)
    fmt = raw.get("format", {})
    duration = float(fmt.get("duration") or (v or {}).get("duration") or (a or {}).get("duration") or 0)
    width = height = 0
    fps = 0.0
    rotation = 0
    transfer = ""
    codec = ""
    if v:
        width, height = int(v.get("width", 0)), int(v.get("height", 0))
        fps = _parse_fps(v.get("avg_frame_rate")) or _parse_fps(v.get("r_frame_rate"))
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rotation = int(round(float(sd["rotation"])))
        if not rotation and v.get("tags", {}).get("rotate"):
            rotation = int(v["tags"]["rotate"])
        if rotation % 180 != 0:
            width, height = height, width
        transfer = v.get("color_transfer", "") or ""
        codec = v.get("codec_name", "")
    hdr = transfer in ("smpte2084", "arib-std-b67")
    created = (fmt.get("tags", {}) or {}).get("creation_time", "") or ((v or {}).get("tags", {}) or {}).get("creation_time", "")
    info = MediaInfo(
        path=str(path), duration=duration, width=width, height=height, fps=fps,
        has_audio=a is not None, has_video=v is not None, rotation=rotation, hdr=hdr,
        color_transfer=transfer, codec=codec, size=st.st_size, mtime=st.st_mtime, created=created,
    )
    if cache_file is not None:
        cache_file.write_text(json.dumps(asdict(info)))
    return info


def is_video(path: Path) -> bool:
    return Path(path).suffix.lower() in VIDEO_EXTS
