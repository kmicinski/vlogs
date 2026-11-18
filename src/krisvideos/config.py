"""User settings: ~/.config/krisvideos/config.yaml"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path

import yaml

CONFIG_DIR = Path(os.environ.get("KRISVIDEOS_CONFIG_DIR", Path.home() / ".config" / "krisvideos"))
CONFIG_FILE = CONFIG_DIR / "config.yaml"


@dataclass
class Config:
    vlogs_dir: str = str(Path.home() / "Vlogs")
    immich_url: str = ""            # e.g. http://immich.home:2283
    immich_api_key: str = ""
    default_orientation: str = "auto"
    default_title_subtitle: str = ""   # e.g. "daily vlog"
    default_music: str = ""            # path to a music file used for new projects
    default_transition: str = "cut"
    default_title_kicker: str = ""     # small line above the opening card's title, e.g. "Daily Vlogs"
    masthead_image: str = ""           # image shown as a card before the opening title (the show's "masthead")
    intro_black_hold: float = 0.0      # extra seconds of pure black between masthead and opening card (0 = just the dip)
    intro_masthead_seconds: float = 2.5
    intro_title_seconds: float = 2.0
    intro_sting: str = ""              # music cue played over the masthead + opening card
    intro_sting_start: float = 0.0     # offset into that file
    intro_sting_volume: float = 0.7
    font: str = "Avenir Next"
    title_bg: str = "#0b0b0f"          # title-card colors for new projects
    title_fg: str = "#ffffff"
    title_accent: str = "#9aa0b4"
    port: int = 8765
    good_mics: list = field(default_factory=list)   # mic labels Kris marked as good (besides media.GOOD_MIC_RE): takes stay as recorded
    render_workers: int = 0            # ffmpegs run at once by an export (0 = one per core; 1 = the old single pass)
    # lens corrections for wide-angle cameras: [{match: "Anker", k1: -0.12, k2: 0.02}, ...]. `match` is a
    # substring (case-insensitive) or a regex tested against the camera label a take was recorded with
    # (Segment.cam); the first hit applies in the export unless the clip says otherwise (`lens: off` / own k1,k2).
    lenses: list = field(default_factory=list)

    @property
    def vlogs_path(self) -> Path:
        return Path(self.vlogs_dir).expanduser()

    @classmethod
    def load(cls) -> "Config":
        c = cls()
        if "KRISVIDEOS_CONFIG_DIR" in os.environ:
            # An explicitly pointed config dir is a sandbox (tests, a second library): its vlogs live next
            # to it, never in the real ~/Vlogs — even when its config.yaml is missing.
            c.vlogs_dir = str(CONFIG_DIR / "vlogs")
        if CONFIG_FILE.exists():
            data = yaml.safe_load(CONFIG_FILE.read_text()) or {}
            for k, v in data.items():
                if hasattr(c, k) and v is not None:
                    setattr(c, k, v)
        c.lenses = clean_lenses(c.lenses)
        # env overrides
        c.immich_url = os.environ.get("IMMICH_URL", c.immich_url)
        c.immich_api_key = os.environ.get("IMMICH_API_KEY", c.immich_api_key)
        return c

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(yaml.safe_dump(asdict(self), sort_keys=False))

    def public(self) -> dict:
        d = asdict(self)
        d["immich_api_key"] = "••••" + self.immich_api_key[-4:] if self.immich_api_key else ""
        d["immich_configured"] = bool(self.immich_url and self.immich_api_key)
        d["config_file"] = str(CONFIG_FILE)
        return d


def clean_lenses(items) -> list[dict]:
    """Normalize a `lenses` list: dicts with a non-empty `match` and float k1/k2 (others dropped)."""
    out: list[dict] = []
    for it in items or []:
        if not isinstance(it, dict) or not str(it.get("match") or "").strip():
            continue
        try:
            k1, k2 = float(it.get("k1") or 0.0), float(it.get("k2") or 0.0)
        except (TypeError, ValueError):
            continue
        out.append({"match": str(it["match"]).strip(), "k1": round(k1, 4), "k2": round(k2, 4)})
    return out


def lens_for(cam: str, lenses: list) -> dict | None:
    """The first `lenses` entry whose `match` is found in the camera label (substring, else regex)."""
    if not cam:
        return None
    for it in lenses or []:
        m = str(it.get("match") or "")
        if not m:
            continue
        if m.lower() in cam.lower():
            return it
        try:
            if re.search(m, cam, re.IGNORECASE):
                return it
        except re.error:
            pass
    return None
