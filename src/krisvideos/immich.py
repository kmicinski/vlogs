"""Minimal Immich REST client: list a day's videos, thumbnails, download originals."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Iterable

import httpx


class ImmichError(RuntimeError):
    pass


class Immich:
    def __init__(self, url: str, api_key: str, timeout: float = 30.0):
        if not url or not api_key:
            raise ImmichError("Immich URL and API key are not configured (Settings, or IMMICH_URL / IMMICH_API_KEY)")
        self.base = url.rstrip("/")
        if not self.base.endswith("/api"):
            self.base += "/api"
        self.client = httpx.Client(base_url=self.base, headers={"x-api-key": api_key, "Accept": "application/json"},
                                   timeout=timeout, follow_redirects=True)

    # ------------------------------------------------------------ basic
    def ping(self) -> dict:
        r = self.client.get("/server/ping")
        r.raise_for_status()
        return r.json()

    def me(self) -> dict:
        r = self.client.get("/users/me")
        r.raise_for_status()
        return r.json()

    # ------------------------------------------------------------ search
    def videos_on(self, day: dt.date, days: int = 1, tz_offset_hours: float | None = None) -> list[dict]:
        """Videos taken on `day` (local), newest last. Uses /search/metadata with pagination."""
        start = dt.datetime.combine(day, dt.time.min)
        end = start + dt.timedelta(days=days)
        if tz_offset_hours is None:
            tz_offset_hours = -(dt.datetime.now() - dt.datetime.utcnow()).total_seconds() / 3600 * -1
        tz = dt.timezone(dt.timedelta(hours=tz_offset_hours))
        body = {
            "type": "VIDEO",
            "takenAfter": start.replace(tzinfo=tz).isoformat(),
            "takenBefore": end.replace(tzinfo=tz).isoformat(),
            "order": "asc",
            "size": 250,
            "page": 1,
            "withExif": True,
        }
        items: list[dict] = []
        while True:
            r = self.client.post("/search/metadata", json=body)
            if r.status_code >= 400:
                raise ImmichError(f"Immich search failed: {r.status_code} {r.text[:200]}")
            data = r.json().get("assets", {})
            items.extend(data.get("items", []))
            nxt = data.get("nextPage")
            if not nxt:
                break
            body["page"] = int(nxt)
        return [self._summarize(a) for a in items]

    def recent_videos(self, limit: int = 60) -> list[dict]:
        body = {"type": "VIDEO", "order": "desc", "size": limit, "page": 1, "withExif": True}
        r = self.client.post("/search/metadata", json=body)
        if r.status_code >= 400:
            raise ImmichError(f"Immich search failed: {r.status_code} {r.text[:200]}")
        items = r.json().get("assets", {}).get("items", [])
        return [self._summarize(a) for a in items]

    @staticmethod
    def _summarize(a: dict) -> dict:
        exif = a.get("exifInfo") or {}
        return {
            "id": a["id"],
            "filename": a.get("originalFileName") or a.get("originalPath", "").split("/")[-1],
            "taken_at": a.get("localDateTime") or a.get("fileCreatedAt"),
            "duration": a.get("duration"),
            "width": exif.get("exifImageWidth"),
            "height": exif.get("exifImageHeight"),
            "size": exif.get("fileSizeInByte"),
            "favorite": a.get("isFavorite", False),
            "city": exif.get("city"),
        }

    # ------------------------------------------------------------ binary
    def thumbnail(self, asset_id: str, size: str = "preview") -> tuple[bytes, str]:
        r = self.client.get(f"/assets/{asset_id}/thumbnail", params={"size": size})
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "image/jpeg")

    def download(self, asset_id: str, dst: Path, filename: str | None = None) -> Path:
        dst.mkdir(parents=True, exist_ok=True)
        with self.client.stream("GET", f"/assets/{asset_id}/original") as r:
            r.raise_for_status()
            name = filename
            if not name:
                cd = r.headers.get("content-disposition", "")
                if "filename=" in cd:
                    name = cd.split("filename=")[-1].strip('"; ')
            name = name or f"{asset_id}.mov"
            path = dst / name
            tmp = path.with_name(path.name + ".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
            tmp.rename(path)
        return path
