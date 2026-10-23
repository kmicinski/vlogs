"""Project schema: the YAML "video language" for a vlog, plus timeline math.

A project folder looks like:

    2026-10-22/
      project.yaml      <- the script (this module)
      clips/            <- original media (pulled from Immich or imported)
      cache/            <- probe json, proxies, thumbnails, rendered title PNGs
      out/              <- preview.mp4 and final renders

Segment types in `timeline`:
  - title:  a full-frame title card (text, subtitle, duration)
  - clip:   a slice of a media file (in/out, speed, mute, caption, overlays)
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import yaml

from .timeutil import parse_time

PROJECT_FILE = "project.yaml"


def _slug(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.strip()).strip("-").lower()
    return s or "untitled"


@dataclass
class Overlay:
    """Text shown over a clip for a window of time (clip-relative seconds)."""
    text: str
    at: float = 0.0            # seconds into the (trimmed) clip
    duration: float | None = None  # None = until clip end
    position: str = "bottom"   # bottom | top | center
    style: str = "caption"     # caption (pill) | big (large centered text)

    @classmethod
    def from_dict(cls, d: dict) -> "Overlay":
        if isinstance(d, str):
            return cls(text=d)
        return cls(
            text=str(d.get("text", "")),
            at=parse_time(d.get("at", 0)),
            duration=parse_time(d["for"]) if d.get("for") is not None else None,
            position=d.get("position", "bottom"),
            style=d.get("style", "caption"),
        )

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"text": self.text, "at": round(self.at, 3)}
        if self.duration is not None:
            d["for"] = round(self.duration, 3)
        if self.position != "bottom":
            d["position"] = self.position
        if self.style != "caption":
            d["style"] = self.style
        return d


@dataclass
class Voiceover:
    """An audio layer (narration) laid over the output timeline."""
    file: str                       # project-relative (audio/VO_....m4a)
    at: float = 0.0                 # output-timeline seconds
    volume: float = 1.0
    duck_clips: bool = True         # lower clip audio while this plays
    id: str = ""
    note: str = ""

    @classmethod
    def from_dict(cls, d: dict, idx: int) -> "Voiceover":
        return cls(file=str(d["file"]), at=parse_time(d.get("at", 0)), volume=float(d.get("volume", 1.0)),
                   duck_clips=bool(d.get("duck_clips", True)), id=str(d.get("id") or f"v{idx+1}"), note=str(d.get("note") or ""))

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"file": self.file, "at": round(self.at, 3)}
        if self.volume != 1.0:
            d["volume"] = self.volume
        if not self.duck_clips:
            d["duck_clips"] = False
        if self.note:
            d["note"] = self.note
        d["id"] = self.id
        return d


@dataclass
class Segment:
    kind: str                       # "clip" | "title"
    id: str = ""
    # clip fields
    src: str = ""                   # path relative to project folder (clips/IMG_1234.MOV)
    in_: float = 0.0
    out: float | None = None        # None = clip end
    speed: float = 1.0
    mute: bool = False
    volume: float = 1.0
    caption: str | None = None      # convenience: a lower-third shown for the whole clip
    fit: str = "contain"            # contain (letterbox) | cover (crop to fill the canvas)
    overlays: list[Overlay] = field(default_factory=list)
    # title fields
    text: str = ""
    subtitle: str = ""
    duration: float = 3.0
    # shared
    transition: str | None = None   # transition INTO this segment: cut | fade | dip (None = project default)
    transition_duration: float | None = None
    note: str = ""                  # free-form, ignored by renderer

    # ------------------------------------------------------------------ io
    @classmethod
    def from_dict(cls, d: dict, idx: int) -> "Segment":
        if "clip" in d or "src" in d:
            seg = cls(kind="clip", src=str(d.get("clip") or d.get("src")))
            seg.in_ = parse_time(d.get("in", 0))
            seg.out = parse_time(d["out"]) if d.get("out") is not None else None
            seg.speed = float(d.get("speed", 1.0) or 1.0)
            seg.mute = bool(d.get("mute", False))
            seg.volume = float(d.get("volume", 1.0))
            seg.caption = d.get("caption")
            seg.fit = str(d.get("fit") or "contain")
            seg.overlays = [Overlay.from_dict(o) for o in d.get("overlays", []) or []]
        elif "title" in d:
            seg = cls(kind="title", text=str(d.get("title") or ""))
            seg.subtitle = str(d.get("subtitle") or "")
            seg.duration = float(parse_time(d.get("duration", 3)))
        else:
            raise ValueError(f"timeline entry #{idx} must have `clip:` or `title:`: {d}")
        seg.id = str(d.get("id") or f"s{idx+1}")
        seg.transition = d.get("transition")
        if d.get("transition_duration") is not None:
            seg.transition_duration = float(d["transition_duration"])
        seg.note = str(d.get("note") or "")
        return seg

    def to_dict(self) -> dict:
        d: dict[str, Any] = {}
        if self.kind == "clip":
            d["clip"] = self.src
            if self.in_:
                d["in"] = round(self.in_, 3)
            if self.out is not None:
                d["out"] = round(self.out, 3)
            if self.speed != 1.0:
                d["speed"] = self.speed
            if self.mute:
                d["mute"] = True
            if self.volume != 1.0:
                d["volume"] = self.volume
            if self.caption:
                d["caption"] = self.caption
            if self.fit != "contain":
                d["fit"] = self.fit
            if self.overlays:
                d["overlays"] = [o.to_dict() for o in self.overlays]
        else:
            d["title"] = self.text
            if self.subtitle:
                d["subtitle"] = self.subtitle
            d["duration"] = self.duration
        if self.transition:
            d["transition"] = self.transition
        if self.transition_duration is not None:
            d["transition_duration"] = self.transition_duration
        if self.note:
            d["note"] = self.note
        d["id"] = self.id
        return d


@dataclass
class Output:
    orientation: str = "auto"       # auto | portrait | landscape | square
    width: int | None = None        # explicit override
    height: int | None = None
    fps: int = 30
    codec: str = "h264"             # h264 | hevc
    quality: str = "high"           # high | medium
    filename: str = ""              # default: <project-name>.mp4


@dataclass
class Style:
    font: str = "Avenir Next"
    title_bg: str = "#0b0b0f"
    title_fg: str = "#ffffff"
    title_accent: str = "#9aa0b4"   # subtitle color
    caption_bg: str = "#000000a0"   # RGBA hex
    caption_fg: str = "#ffffff"
    transition: str = "cut"         # default transition between segments: cut | fade | dip
    transition_duration: float = 0.5
    fade_in: float = 0.5            # fade from black at start
    fade_out: float = 0.8           # fade to black at end
    title_fade: float = 0.4         # title cards fade their text in/out


@dataclass
class Music:
    file: str = ""
    volume: float = 0.18
    duck: bool = True               # lower music under speech
    start: float = 0.0              # offset into music file
    fade_out: float = 3.0


@dataclass
class Audio:
    normalize: bool = True          # loudness-normalize the final mix
    match_levels: bool = True       # auto-gain each clip/voiceover toward the same loudness
    target_lufs: float = -18.0
    master_volume: float = 1.0


@dataclass
class Project:
    name: str
    folder: Path
    title: str = ""
    date: str = ""
    output: Output = field(default_factory=Output)
    style: Style = field(default_factory=Style)
    music: Music = field(default_factory=Music)
    audio: Audio = field(default_factory=Audio)
    timeline: list[Segment] = field(default_factory=list)
    voiceovers: list[Voiceover] = field(default_factory=list)
    extra: dict = field(default_factory=dict)    # unknown top-level keys, preserved

    # ------------------------------------------------------------------ paths
    @property
    def path(self) -> Path:
        return self.folder / PROJECT_FILE

    @property
    def clips_dir(self) -> Path:
        return self.folder / "clips"

    @property
    def cache_dir(self) -> Path:
        return self.folder / "cache"

    @property
    def out_dir(self) -> Path:
        return self.folder / "out"

    @property
    def audio_dir(self) -> Path:
        return self.folder / "audio"

    def ensure_dirs(self) -> None:
        for d in (self.folder, self.clips_dir, self.cache_dir, self.out_dir, self.audio_dir):
            d.mkdir(parents=True, exist_ok=True)

    def resolve(self, rel: str) -> Path:
        p = Path(rel).expanduser()
        return p if p.is_absolute() else (self.folder / p)

    def output_filename(self) -> str:
        return self.output.filename or f"{_slug(self.title or self.name)}.mp4"

    # ------------------------------------------------------------------ io
    @classmethod
    def new(cls, folder: Path, title: str = "", date: str = "") -> "Project":
        folder = Path(folder)
        date = date or dt.date.today().isoformat()
        p = cls(name=folder.name, folder=folder, title=title or folder.name, date=date)
        return p

    @classmethod
    def load(cls, folder: Path) -> "Project":
        folder = Path(folder)
        path = folder / PROJECT_FILE
        data = yaml.safe_load(path.read_text()) or {}
        return cls.from_dict(data, folder)

    @classmethod
    def from_dict(cls, data: dict, folder: Path) -> "Project":
        folder = Path(folder)
        known = {"title", "date", "output", "style", "music", "audio", "timeline", "voiceovers"}
        p = cls(name=folder.name, folder=folder)
        p.title = str(data.get("title") or folder.name)
        p.date = str(data.get("date") or "")
        p.output = _fill(Output, data.get("output"))
        p.style = _fill(Style, data.get("style"))
        p.music = _fill(Music, data.get("music"))
        p.audio = _fill(Audio, data.get("audio"))
        p.timeline = [Segment.from_dict(s, i) for i, s in enumerate(data.get("timeline") or [])]
        p.voiceovers = [Voiceover.from_dict(v, i) for i, v in enumerate(data.get("voiceovers") or [])]
        p.extra = {k: v for k, v in data.items() if k not in known}
        p.renumber_ids()
        return p

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"title": self.title, "date": self.date}
        for key, obj, default in (("output", self.output, Output()), ("style", self.style, Style())):
            c = _compact(asdict(obj), default)
            if c:
                d[key] = c
        if self.music.file:
            d["music"] = _compact(asdict(self.music), Music(), keep={"file"})
        au = _compact(asdict(self.audio), Audio())
        if au:
            d["audio"] = au
        d.update(self.extra)
        d["timeline"] = [s.to_dict() for s in self.timeline]
        if self.voiceovers:
            d["voiceovers"] = [v.to_dict() for v in self.voiceovers]
        return d

    def save(self) -> None:
        self.ensure_dirs()
        header = (
            "# krisvideos project. Edit freely; the app reloads on change.\n"
            "# Times accept seconds (12.5) or m:ss (0:12.5). `in`/`out` are source-clip times.\n"
        )
        self.path.write_text(header + yaml.safe_dump(self.to_dict(), sort_keys=False, allow_unicode=True, width=100))

    # ------------------------------------------------------------------ edits
    def renumber_ids(self) -> None:
        seen: set[str] = set()
        for i, s in enumerate(self.timeline):
            if not s.id or s.id in seen:
                s.id = f"s{i+1}"
                n = i + 1
                while s.id in seen:
                    n += 1
                    s.id = f"s{n}"
            seen.add(s.id)

    def add_voiceover(self, file: str, at: float, **kw) -> Voiceover:
        ids = {v.id for v in self.voiceovers}
        n = len(self.voiceovers) + 1
        while f"v{n}" in ids:
            n += 1
        vo = Voiceover(file=file, at=at, id=f"v{n}", **kw)
        self.voiceovers.append(vo)
        self.voiceovers.sort(key=lambda v: v.at)
        return vo

    def voiceover(self, vid: str) -> Voiceover:
        for v in self.voiceovers:
            if v.id == vid:
                return v
        raise KeyError(vid)

    def index_of(self, seg_id: str) -> int:
        for i, s in enumerate(self.timeline):
            if s.id == seg_id:
                return i
        raise KeyError(seg_id)

    def next_id(self) -> str:
        ids = {s.id for s in self.timeline}
        n = len(self.timeline) + 1
        while f"s{n}" in ids:
            n += 1
        return f"s{n}"

    def add_clip(self, src: str, at: int | None = None, **kw) -> Segment:
        seg = Segment(kind="clip", src=src, id=self.next_id(), **kw)
        self._insert(seg, at)
        return seg

    def add_title(self, text: str, subtitle: str = "", duration: float = 3.0, at: int | None = None) -> Segment:
        seg = Segment(kind="title", text=text, subtitle=subtitle, duration=duration, id=self.next_id())
        self._insert(seg, at)
        return seg

    def _insert(self, seg: Segment, at: int | None) -> None:
        if at is None or at >= len(self.timeline):
            self.timeline.append(seg)
        else:
            self.timeline.insert(max(0, at), seg)

    def remove(self, seg_id: str) -> Segment:
        return self.timeline.pop(self.index_of(seg_id))

    def move(self, seg_id: str, new_index: int) -> None:
        seg = self.remove(seg_id)
        self.timeline.insert(max(0, min(new_index, len(self.timeline))), seg)


def _fill(cls, data):
    data = data or {}
    obj = cls()
    for k, v in data.items():
        if hasattr(obj, k) and v is not None:
            cur = getattr(obj, k)
            if isinstance(cur, bool):
                v = bool(v)
            elif isinstance(cur, int) and not isinstance(cur, bool):
                v = int(v)
            elif isinstance(cur, float):
                v = float(v)
            setattr(obj, k, v)
    return obj


def _compact(d: dict, default_obj, keep: set | None = None) -> dict:
    """Drop keys equal to their defaults so the YAML stays short."""
    defaults = asdict(default_obj)
    return {k: v for k, v in d.items() if (keep and k in keep) or defaults.get(k) != v}
