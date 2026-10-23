"""User settings: ~/.config/krisvideos/config.yaml"""
from __future__ import annotations

import os
from dataclasses import dataclass, asdict
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
    font: str = "Avenir Next"
    port: int = 8765

    @property
    def vlogs_path(self) -> Path:
        return Path(self.vlogs_dir).expanduser()

    @classmethod
    def load(cls) -> "Config":
        c = cls()
        if CONFIG_FILE.exists():
            data = yaml.safe_load(CONFIG_FILE.read_text()) or {}
            for k, v in data.items():
                if hasattr(c, k) and v is not None:
                    setattr(c, k, v)
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
