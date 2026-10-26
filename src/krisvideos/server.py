"""Local web GUI: FastAPI backend + static single-page frontend in web/."""
from __future__ import annotations

import datetime as dt
import os
import shutil
import subprocess
import threading
import time
import uuid
import webbrowser
from pathlib import Path

import yaml
from fastapi import FastAPI, Form, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import edits, media, render
from .cli import new_project as make_project, masthead_rel, sting_rel
from .edits import title_at
from .config import Config
from .probe import is_video, probe
from .project import Overlay, Project, Segment, Voiceover
from .timeutil import parse_time

WEB = Path(__file__).parent / "web"


# --------------------------------------------------------------------------- jobs
class Job:
    def __init__(self, kind: str, project: str):
        self.id = uuid.uuid4().hex[:10]
        self.kind = kind
        self.project = project
        self.status = "running"
        self.progress = 0.0
        self.secs = 0.0
        self.message = ""
        self.error = ""
        self.output = ""
        self.warnings: list[str] = []
        self.added: list[str] = []          # import jobs: project-relative paths brought in
        self.cancel = threading.Event()
        self.started = time.time()

    def to_dict(self):
        return {k: getattr(self, k) for k in ("id", "kind", "project", "status", "progress", "secs", "message",
                                                 "error", "output", "warnings", "added")} | {"elapsed": round(time.time() - self.started, 1)}


JOBS: dict[str, Job] = {}


def _run_job(job: Job, fn):
    def wrap():
        try:
            fn(job)
            job.status = "done"
            job.progress = 1.0
        except Exception as e:  # noqa
            job.status = "cancelled" if "cancelled" in str(e) else "error"
            job.error = str(e)
    threading.Thread(target=wrap, daemon=True).start()
    JOBS[job.id] = job
    return job



class SettingsIn(BaseModel):
    vlogs_dir: str | None = None
    immich_url: str | None = None
    immich_api_key: str | None = None
    default_orientation: str | None = None
    default_title_subtitle: str | None = None
    default_music: str | None = None
    default_transition: str | None = None
    default_title_kicker: str | None = None
    masthead_image: str | None = None
    intro_black_hold: float | None = None
    intro_masthead_seconds: float | None = None
    intro_title_seconds: float | None = None
    intro_sting: str | None = None
    intro_sting_start: float | None = None
    intro_sting_volume: float | None = None
    font: str | None = None
    title_bg: str | None = None
    title_fg: str | None = None
    title_accent: str | None = None


class NewProject(BaseModel):
    name: str | None = None
    title: str | None = None
    opening: bool = True
    trim: bool = False          # leave pulled clips off the timeline (the GUI opens them in the trimmer)
    pull_immich: bool = False


class YamlIn(BaseModel):
    yaml: str


class History:
    """Undo/redo stacks of project.yaml text, persisted per project in cache/history.json."""
    LIMIT = 100

    def __init__(self):
        self.mem: dict[str, dict] = {}

    def _file(self, p: Project) -> Path:
        return p.cache_dir / "history.json"

    def get(self, p: Project) -> dict:
        import json
        h = self.mem.get(p.name)
        if h is None:
            h = {"undo": [], "redo": []}
            f = self._file(p)
            if f.exists():
                try:
                    h = json.loads(f.read_text())
                except Exception:
                    pass
            self.mem[p.name] = h
        return h

    def _persist(self, p: Project) -> None:
        import json
        try:
            p.cache_dir.mkdir(parents=True, exist_ok=True)
            self._file(p).write_text(json.dumps(self.mem[p.name]))
        except OSError:
            pass

    def push(self, p: Project, before: str) -> None:
        h = self.get(p)
        if h["undo"] and h["undo"][-1] == before:
            return
        h["undo"].append(before)
        del h["undo"][:-self.LIMIT]
        h["redo"].clear()
        self._persist(p)

    def undo(self, p: Project) -> bool:
        h = self.get(p)
        if not h["undo"]:
            return False
        h["redo"].append(p.path.read_text())
        p.path.write_text(h["undo"].pop())
        self._persist(p)
        return True

    def redo(self, p: Project) -> bool:
        h = self.get(p)
        if not h["redo"]:
            return False
        h["undo"].append(p.path.read_text())
        p.path.write_text(h["redo"].pop())
        self._persist(p)
        return True


HISTORY = History()


def _cached_lufs(p: Project, rel: str):
    import json
    f = p.cache_dir / (Path(rel).name + ".loud.json")
    if f.exists():
        try:
            return json.loads(f.read_text()).get("lufs")
        except Exception:
            return None
    return None


# --------------------------------------------------------------------------- app
def _asset_dest(p: Project, name: str, size: int | None = None) -> Path:
    """A free path in assets/ for `name` (reusing an existing file only when it is the same size)."""
    d = p.folder / "assets"
    d.mkdir(parents=True, exist_ok=True)
    dst, stem, suf, n = d / name, Path(name).stem, Path(name).suffix, 2
    while dst.exists() and (size is None or dst.stat().st_size != size):
        dst = d / f"{stem}_{n}{suf}"
        n += 1
    return dst


def _browser_image(path: Path) -> Path:
    """HEIC/HEIF (iPhone photos) -> JPEG next to it, so browsers and Pillow can use it."""
    if path.suffix.lower() not in (".heic", ".heif"):
        return path
    jpg = path.with_suffix(".jpg")
    if not jpg.exists():
        r = subprocess.run(["sips", "-s", "format", "jpeg", str(path), "--out", str(jpg)], capture_output=True, text=True)
        if r.returncode != 0 or not jpg.exists():
            raise HTTPException(400, f"could not convert {path.name}: {r.stderr.strip()[:200]}")
    path.unlink(missing_ok=True)
    return jpg


def _import_asset(p: Project, path: str) -> str:
    """An image for a card or for the images track: project-relative paths are kept; absolute paths
    are copied into assets/ (HEIC photos become JPEG)."""
    src = Path(path).expanduser()
    if not src.is_absolute():
        if not p.resolve(path).exists():
            raise HTTPException(400, f"missing {path}")
        return path
    if not src.exists():
        raise HTTPException(400, f"missing {path}")
    dst = _asset_dest(p, src.name, src.stat().st_size)
    if not dst.exists():
        shutil.copy2(src, dst)
    return f"assets/{_browser_image(dst).name}"


_IMG_SIZE: dict[tuple, tuple[int, int]] = {}


def _image_size(path: Path) -> tuple[int, int]:
    key = (str(path), path.stat().st_mtime_ns)
    if key not in _IMG_SIZE:
        from PIL import Image
        try:
            with Image.open(path) as im:
                _IMG_SIZE[key] = im.size
        except Exception:
            _IMG_SIZE[key] = (0, 0)
    return _IMG_SIZE[key]


def _box(v) -> tuple | None:
    """A box from the API: null/"full" = full screen, else {x, y, w} or [x, y, w] fractions of the frame."""
    if v in (None, "", "full"):
        return None
    if isinstance(v, dict):
        v = (v.get("x", 0.5), v.get("y", 0.5), v.get("w", 0.4))
    x, y, w = (float(t) for t in v)
    return (max(-0.5, min(1.5, x)), max(-0.5, min(1.5, y)), max(0.03, min(2.0, w)))


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(title="krisvideos")
    root = cfg.vlogs_path
    root.mkdir(parents=True, exist_ok=True)
    immich_cache: dict[str, tuple[float, list]] = {}

    def project_dir(name: str) -> Path:
        d = (root / name).resolve()
        if not str(d).startswith(str(root.resolve())) or not (d / "project.yaml").exists():
            raise HTTPException(404, f"no project {name}")
        return d

    def load(name: str) -> Project:
        p = Project.load(project_dir(name))
        p.extra["__before"] = p.path.read_text()
        return p

    def commit(p: Project) -> None:
        """Save the project, recording the previous text for undo. Pictures over the video and
        voiceovers follow the frames they were placed over when the clips under them change."""
        before = p.extra.pop("__before", None)
        if before is not None and (p.images or p.voiceovers):
            try:
                edits.follow_content(Project.from_dict(yaml.safe_load(before) or {}, p.folder), p)
            except Exception as e:  # never block an edit on this
                print(f"[follow_content] {e}")
        p.save()
        if before is not None and before != p.path.read_text():
            HISTORY.push(p, before)

    def immich():
        from .immich import Immich
        try:
            return Immich(cfg.immich_url, cfg.immich_api_key)
        except Exception as e:
            raise HTTPException(400, str(e))

    def media_url(p: Project, rel: str) -> str:
        return f"/media/{p.name}/{rel}"

    def project_json(p: Project) -> dict:
        p.extra.pop("__before", None)
        h = HISTORY.get(p)
        infos = {}
        for s in p.timeline:
            if s.kind == "clip" and s.src not in infos:
                path = p.resolve(s.src)
                infos[s.src] = probe(path, p.cache_dir) if path.exists() else None
        usable = {k: v for k, v in infos.items() if v}
        try:
            layout = render.compute_layout(p, usable) if all(infos.values()) else None
        except Exception:
            layout = None
        placed = {pl.seg.id: pl for pl in layout.placed} if layout else {}
        segs = []
        for s in p.timeline:
            d = s.to_dict()
            d["kind"] = s.kind
            d["in"] = s.in_
            d["out"] = s.out
            d["title"] = s.text if s.kind == "title" else None
            if s.kind == "title":
                d["kicker"] = s.kicker
                d["image"] = s.image
                img = p.resolve(s.image) if s.image else None
                d["image_url"] = media_url(p, s.image) + f"?v={int(img.stat().st_mtime)}" if img and img.exists() and not Path(s.image).is_absolute() else None
                d["image_missing"] = bool(s.image) and not (img and img.exists())
            d["overlays"] = [o.to_dict() for o in s.overlays]
            d["fit"] = s.fit
            pl = placed.get(s.id)
            if pl:
                d["placed"] = pl.to_dict()
            if s.kind == "clip":
                info = infos.get(s.src)
                d["media"] = info.to_dict() if info else None
                d["missing"] = info is None
                st = media.media_status(p, s.src)
                # until the 540p proxy exists, a browser-playable source (e.g. a fresh recording) stands in for it
                d["proxy_url"] = media_url(p, f"cache/{Path(s.src).name}.proxy.mp4") if st["proxy"] else (media_url(p, s.src) if media.browser_playable(info) else None)
                d["thumb_url"] = media_url(p, f"cache/{Path(s.src).name}.thumb.jpg") if st["thumb"] else None
                d["src_url"] = media_url(p, s.src)
                d["lufs"] = _cached_lufs(p, s.src)
            segs.append(d)
        vos = []
        for v in p.voiceovers:
            f = p.resolve(v.file)
            vd = v.to_dict() | {"id": v.id, "at": v.at, "volume": v.volume, "duck_clips": v.duck_clips,
                                "missing": not f.exists(), "url": media_url(p, v.file) if f.exists() else None}
            try:
                vd["duration"] = probe(f, p.cache_dir).duration if f.exists() else 0
            except Exception:
                vd["duration"] = 0
            vd["lufs"] = _cached_lufs(p, v.file)
            vos.append(vd)
        stings = []
        for m in p.stings:
            f = p.resolve(m.file)
            span = render.sting_span(layout, m) if layout else None
            md = m.to_dict() | {"id": m.id, "from": m.from_id, "to": m.to_id, "start": m.start, "volume": m.volume,
                                "fade_in": m.fade_in, "fade_out": m.fade_out, "duck": m.duck, "missing": not f.exists(),
                                "url": media_url(p, m.file) if f.exists() and not Path(m.file).is_absolute() else None,
                                "at": span[0] if span else None, "end": span[1] if span else None}
            try:
                md["file_duration"] = probe(f, p.cache_dir).duration if f.exists() else 0
            except Exception:
                md["file_duration"] = 0
            stings.append(md)
        images = []
        for m in p.images:
            f = p.resolve(m.file)
            iw, ih = _image_size(f) if f.exists() else (0, 0)
            images.append(m.to_dict() | {"id": m.id, "file": m.file, "at": m.at, "duration": m.duration, "box": list(m.box) if m.box else None,
                                         "fit": m.fit, "fade": m.fade, "missing": not f.exists(), "iw": iw, "ih": ih,
                                         "url": media_url(p, m.file) + f"?v={int(f.stat().st_mtime)}" if f.exists() and not Path(m.file).is_absolute() else None})
        clips = []
        for f in sorted(p.clips_dir.glob("*")) if p.clips_dir.exists() else []:
            if not is_video(f):
                continue
            rel = f"clips/{f.name}"
            try:
                info = probe(f, p.cache_dir).to_dict()
            except Exception:
                info = None
            st = media.media_status(p, rel)
            clips.append({
                "src": rel, "name": f.name, "media": info,
                "in_timeline": any(s.src == rel for s in p.timeline),
                "thumb_url": media_url(p, f"cache/{f.name}.thumb.jpg") if st["thumb"] else None,
                "proxy_url": media_url(p, f"cache/{f.name}.proxy.mp4") if st["proxy"] else (media_url(p, rel) if info and media.browser_playable(probe(f, p.cache_dir)) else None),
            })
        preview = p.out_dir / "preview.mp4"
        final = p.out_dir / p.output_filename()
        ymtime = p.path.stat().st_mtime
        return {
            "name": p.name, "title": p.title, "date": p.date, "folder": str(p.folder),
            "output": p.output.__dict__, "style": p.style.__dict__, "music": p.music.__dict__, "audio": p.audio.__dict__,
            "timeline": segs, "clips": clips, "voiceovers": vos, "stings": stings, "images": images,
            "layout": {"width": layout.width, "height": layout.height, "total": layout.total, "fps": layout.fps,
                       "orientation": layout.orientation} if layout else None,
            "preview": {"url": media_url(p, "out/preview.mp4") + f"?v={int(preview.stat().st_mtime)}",
                        "stale": preview.stat().st_mtime < ymtime} if preview.exists() else None,
            "final": {"url": media_url(p, f"out/{final.name}") + f"?v={int(final.stat().st_mtime)}", "path": str(final),
                      "stale": final.stat().st_mtime < ymtime, "size": final.stat().st_size} if final.exists() else None,
            "yaml": p.path.read_text(),
            "can_undo": bool(h["undo"]), "can_redo": bool(h["redo"]),
            "target_lufs": p.audio.target_lufs, "match_levels": p.audio.match_levels,
        }

    # ------------------------------------------------------------------ static
    @app.get("/")
    def index():
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=WEB), name="static")

    @app.middleware("http")
    async def no_stale_static(request: Request, call_next):
        resp = await call_next(request)
        if request.url.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/media/{name}/{path:path}")
    def media_file(name: str, path: str, request: Request):
        d = project_dir(name)
        f = (d / path).resolve()
        if not str(f).startswith(str(d)) or not f.exists():
            raise HTTPException(404)
        return FileResponse(f, headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"})

    @app.get("/api/projects/{name}/strip")
    def filmstrip(name: str, src: str, n: int = 8, start: float = 0.0, end: float | None = None, h: int = 72):
        """A horizontal strip of n frames from src between start and end (source seconds)."""
        p = load(name)
        f = media.filmstrip(p, src, n=max(1, min(n, 60)), start=start, end=end, height=h)
        return FileResponse(f, headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/projects/{name}/music")
    def music_file(name: str):
        p = load(name)
        f = p.resolve(p.music.file) if p.music.file else None
        if not f or not f.exists():
            raise HTTPException(404, "no music")
        return FileResponse(f, headers={"Accept-Ranges": "bytes"})

    @app.get("/api/projects/{name}/wave")
    def wave(name: str, src: str, start: float = 0.0, end: float | None = None, w: int = 800, h: int = 40, color: str = "ffffff"):
        p = load(name)
        if src == "music":
            if not p.music.file:
                raise HTTPException(404, "no music")
            src = str(p.resolve(p.music.file))
        f = media.waveform(p, src, start=start, end=end, width=max(8, min(w, 4000)), height=max(4, min(h, 200)), color=color)
        return FileResponse(f, headers={"Cache-Control": "max-age=3600"})

    @app.post("/api/projects/{name}/undo")
    def undo(name: str):
        p = load(name)
        if not HISTORY.undo(p):
            raise HTTPException(400, "nothing to undo")
        return project_json(Project.load(p.folder))

    @app.post("/api/projects/{name}/redo")
    def redo(name: str):
        p = load(name)
        if not HISTORY.redo(p):
            raise HTTPException(400, "nothing to redo")
        return project_json(Project.load(p.folder))

    # ------------------------------------------------------------------ settings
    @app.get("/api/settings")
    def get_settings():
        return cfg.public()

    @app.put("/api/settings")
    def put_settings(s: SettingsIn):
        for k, v in s.model_dump().items():
            if v is None:
                continue
            if k == "immich_api_key" and v.startswith("••••"):
                continue
            setattr(cfg, k, v)
        cfg.save()
        nonlocal root
        root = cfg.vlogs_path
        root.mkdir(parents=True, exist_ok=True)
        return cfg.public()

    @app.get("/api/immich/status")
    def immich_status():
        if not (cfg.immich_url and cfg.immich_api_key):
            return {"configured": False, "ok": False, "error": "not configured"}
        try:
            im = immich()
            me = im.me()
            return {"configured": True, "ok": True, "user": me.get("name") or me.get("email")}
        except Exception as e:
            return {"configured": True, "ok": False, "error": str(e)[:300]}

    # ------------------------------------------------------------------ projects
    @app.get("/api/projects")
    def list_projects():
        out = []
        for d in sorted(root.iterdir(), reverse=True) if root.exists() else []:
            if (d / "project.yaml").exists():
                try:
                    p = Project.load(d)
                    out.append({"name": d.name, "title": p.title, "date": p.date, "segments": len(p.timeline),
                                "rendered": (p.out_dir / p.output_filename()).exists()})
                except Exception as e:
                    out.append({"name": d.name, "title": d.name, "date": "", "segments": 0, "error": str(e)})
        return out

    @app.post("/api/projects")
    def new_project(body: NewProject):
        name = (body.name or dt.date.today().isoformat()).strip()
        folder = root / name
        if (folder / "project.yaml").exists():
            raise HTTPException(409, f"project {name} already exists")
        p = make_project(cfg, folder, body.title, body.opening)
        p.save()
        out = {"project": project_json(p), "job": None}
        if body.pull_immich and cfg.immich_url and cfg.immich_api_key:
            try:
                day = dt.date.fromisoformat(name)
            except ValueError:
                day = dt.date.today()
            vids = immich().videos_on(day)
            if vids:
                out["job"] = import_immich(name, {"assets": [{"id": v["id"], "filename": v["filename"]} for v in vids],
                                                  "add": not body.trim})
        return out

    @app.get("/api/projects/{name}")
    def get_project(name: str):
        return project_json(load(name))

    @app.delete("/api/projects/{name}")
    def delete_project(name: str):
        d = project_dir(name)
        trash = Path.home() / ".Trash" / f"{name}-{int(time.time())}"
        shutil.move(str(d), str(trash))
        return {"ok": True, "moved_to": str(trash)}

    @app.put("/api/projects/{name}/yaml")
    def put_yaml(name: str, body: YamlIn):
        d = project_dir(name)
        try:
            data = yaml.safe_load(body.yaml) or {}
            p = Project.from_dict(data, d)
            render.compute_layout(p)  # validates clips exist
        except Exception as e:
            raise HTTPException(400, f"invalid project: {e}")
        commit(p)
        return project_json(p)

    @app.patch("/api/projects/{name}")
    def patch_project(name: str, body: dict):
        p = load(name)
        if "title" in body:
            p.title = str(body["title"])
        for section in ("output", "style", "music", "audio"):
            for k, v in (body.get(section) or {}).items():
                obj = getattr(p, section)
                if hasattr(obj, k):
                    cur = getattr(obj, k)
                    if isinstance(cur, bool):
                        v = bool(v)
                    elif isinstance(cur, float):
                        v = float(v)
                    elif isinstance(cur, int):
                        v = int(v) if v not in (None, "") else None
                    setattr(obj, k, v)
        commit(p)
        return project_json(p)

    # ------------------------------------------------------------------ segments
    @app.post("/api/projects/{name}/segments")
    def add_segment(name: str, body: dict):
        p = load(name)
        at = body.get("at")
        if body.get("kind") == "masthead":
            rel = masthead_rel(p, cfg)
            if not rel:
                raise HTTPException(400, "no masthead image configured (Settings → App)")
            p.add_title("", "", float(body.get("duration") or 3), at=at, image=rel)
        elif body.get("kind") == "title":
            image = body.get("image") or None
            if image:
                image = _import_asset(p, image)
            p.add_title(body.get("text") or ("" if image else "Title"), body.get("subtitle") or "",
                        float(body.get("duration") or 3), at=at, kicker=body.get("kicker") or "", image=image,
                        bg=body.get("bg") or None, fg=body.get("fg") or None)
        else:
            src = body["src"]
            if not p.resolve(src).exists():
                raise HTTPException(400, f"missing {src}")
            if body.get("at_time") is not None:          # insert at a timeline time (splits a clip there)
                at = edits.insert_index_at(p, float(body["at_time"]))
            seg = p.add_clip(src, at=at)
            if body.get("in") not in (None, ""):
                seg.in_ = max(0.0, parse_time(body["in"]))
            if body.get("out") not in (None, ""):
                seg.out = parse_time(body["out"])
            commit(p)
            return project_json(p) | {"new_id": seg.id}
        commit(p)
        return project_json(p)

    @app.patch("/api/projects/{name}/segments/{sid}")
    def patch_segment(name: str, sid: str, body: dict):
        p = load(name)
        s = p.timeline[p.index_of(sid)]
        for k, v in body.items():
            if k == "in":
                edits.set_in(s, parse_time(v))
            elif k == "out":
                s.out = None if v in (None, "", "end") else parse_time(v)
            elif k in ("text", "title"):
                s.text = str(v)
            elif k == "overlays":
                s.overlays = [Overlay.from_dict(o) for o in v]
            elif k == "markers":
                s.markers = sorted({round(max(0.0, float(parse_time(x))), 3) for x in (v or [])})
            elif k in ("duration", "transition_duration"):
                setattr(s, k, None if v in (None, "") else float(v))
            elif k in ("speed", "volume"):
                setattr(s, k, float(v))
            elif k == "mute":
                s.mute = bool(v)
            elif k == "fit":
                s.fit = "cover" if v == "cover" else "contain"
            elif k in ("bg", "fg"):
                setattr(s, k, v or None)
            elif k == "kicker":
                s.kicker = str(v or "")
            elif k == "image":
                s.image = _import_asset(p, str(v)) if v else None
            elif k == "layout":
                s.layout = "lower" if v == "lower" else "center"
            elif k in ("caption", "subtitle", "transition", "note"):
                setattr(s, k, v if v != "" else ("" if k in ("subtitle", "note") else None))
        commit(p)
        return project_json(p)

    @app.delete("/api/projects/{name}/segments/{sid}")
    def delete_segment(name: str, sid: str):
        p = load(name)
        p.remove(sid)
        commit(p)
        return project_json(p)

    @app.post("/api/projects/{name}/reorder")
    def reorder(name: str, body: dict):
        p = load(name)
        by_id = {s.id: s for s in p.timeline}
        ids = [i for i in body["ids"] if i in by_id]
        p.timeline = [by_id[i] for i in ids] + [s for s in p.timeline if s.id not in ids]
        commit(p)
        return project_json(p)

    @app.post("/api/projects/{name}/title-at")
    def title_at_api(name: str, body: dict):
        p = load(name)
        title_at(p, float(body["time"]), body.get("text") or "Title", body.get("subtitle") or "",
                 float(body.get("duration") or 3))
        commit(p)
        return project_json(p)

    @app.post("/api/projects/{name}/split")
    def split_api(name: str, body: dict):
        p = load(name)
        layout = render.compute_layout(p)
        pl, off = render.locate(layout, float(body["time"]))
        if pl is None or pl.seg.kind != "clip" or off < 0.25 or pl.duration - off < 0.25:
            raise HTTPException(400, "nothing to split here")
        edits.split_segment(p, pl, off)
        commit(p)
        return project_json(p)

    @app.post("/api/projects/{name}/cut")
    def cut_api(name: str, body: dict):
        """Remove output-timeline [start, end) and close the gap (ripple delete)."""
        p = load(name)
        removed = edits.cut_range(p, float(body["start"]), float(body["end"]))
        if removed <= 0:
            raise HTTPException(400, "nothing to cut there")
        commit(p)
        return project_json(p) | {"removed": removed}

    @app.post("/api/projects/{name}/keep")
    def keep_api(name: str, body: dict):
        """Trim the clip(s) under [start, end) to just that part."""
        p = load(name)
        removed, at = edits.keep_range(p, float(body["start"]), float(body["end"]))
        if removed <= 0:
            raise HTTPException(400, "nothing to trim there (mark a part inside a clip)")
        commit(p)
        return project_json(p) | {"removed": removed, "at": at}

    # ------------------------------------------------------------------ import
    @app.post("/api/projects/{name}/import")
    def import_local(name: str, body: dict):
        p = load(name)
        added = []
        for path in body.get("paths", []):
            src = Path(path).expanduser()
            if src.is_dir():
                files = sorted(f for f in src.iterdir() if is_video(f))
            else:
                files = [src]
            rels = []
            for f in files:
                if not f.exists():
                    raise HTTPException(400, f"not found: {f}")
                rels.append(media.import_file(p, f))
            for rel in media.sort_by_capture_time(p, rels):
                media.prepare_async(p, rel)
                if body.get("add", True) and not any(s.src == rel for s in p.timeline):
                    p.add_clip(rel)
                added.append(rel)
        commit(p)
        return {"added": added, "project": project_json(p)}

    @app.post("/api/projects/{name}/upload")
    async def upload(name: str, files: list[UploadFile] = File(...), add: bool = True):
        p = load(name)
        added = []
        for uf in files:
            fname = Path(uf.filename or "upload.mov").name
            if not is_video(fname):
                continue
            tmp = p.cache_dir / (fname + ".upload")
            p.ensure_dirs()
            with open(tmp, "wb") as out:
                while chunk := await uf.read(1 << 20):
                    out.write(chunk)
            dst = p.clips_dir / fname
            n = 2
            while dst.exists() and dst.stat().st_size != tmp.stat().st_size:
                dst = p.clips_dir / f"{Path(fname).stem}_{n}{Path(fname).suffix}"
                n += 1
            if not dst.exists():
                tmp.rename(dst)
            else:
                tmp.unlink()
            rel = f"clips/{dst.name}"
            media.prepare_async(p, rel)
            if add and not any(s.src == rel for s in p.timeline):
                p.add_clip(rel)
            added.append(rel)
        commit(p)
        return {"added": added, "project": project_json(p)}

    @app.post("/api/projects/{name}/prepare")
    def prepare_all(name: str):
        p = load(name)
        for f in p.clips_dir.glob("*"):
            if is_video(f):
                media.prepare_async(p, f"clips/{f.name}")
        return {"ok": True}

    # ------------------------------------------------------------------ recording / voiceovers
    # Recordings stream in as chunks and are appended to disk immediately, so a crash mid-take
    # loses at most the last chunk. cache/recordings/<id>.json is the manifest, <id>.part the data.
    def rec_dir(p: Project) -> Path:
        d = p.cache_dir / "recordings"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def rec_manifest(p: Project, rid: str) -> dict:
        f = rec_dir(p) / f"{rid}.json"
        if not f.exists():
            raise HTTPException(404, "no such recording session")
        import json
        return json.loads(f.read_text())

    def rec_save_manifest(p: Project, m: dict) -> None:
        import json
        (rec_dir(p) / f"{m['id']}.json").write_text(json.dumps(m))

    def finalize_recording(p: Project, m: dict) -> dict:
        part = rec_dir(p) / f"{m['id']}.part"
        if not part.exists() or part.stat().st_size < 1000:
            raise HTTPException(400, "recording is empty")
        try:
            rel = media.ingest_recording(p, part, m["kind"], m["id"], container=m.get("ext", "webm"))
        except Exception as e:
            raise HTTPException(500, f"could not convert recording: {e}")
        p = load(p.name)
        marks = sorted(max(0.0, float(t)) for t in m.get("markers") or [])
        if m["kind"] == "voiceover":
            at0 = max(0.0, float(m.get("at") or 0))
            new_id = p.add_voiceover(rel, at0).id
            if marks:   # markers dropped while narrating go on the clips that were playing at the time
                try:
                    layout = render.compute_layout(p)
                    for t in marks:
                        pl, off = render.locate(layout, at0 + t)
                        if pl is not None and pl.seg.kind == "clip":
                            pl.seg.markers = sorted(pl.seg.markers + [round(pl.src_in + off * (pl.seg.speed or 1.0), 3)])
                except Exception:
                    pass
        else:
            at = None
            try:   # a take recorded with the playhead at a segment's start goes in front of that segment
                layout = render.compute_layout(p)
                pl, off = render.locate(layout, float(m.get("at") or 0))
                if pl is not None and off < 0.25:
                    at = pl.index
            except Exception:
                at = None
            seg = p.add_clip(rel, at=at) if m.get("add", True) else None
            if seg is not None and m.get("fit") in ("cover", "contain"):
                seg.fit = m["fit"]
            if seg is not None and marks:
                seg.markers = [round(t, 3) for t in marks]
            new_id = seg.id if seg else None
        commit(p)
        part.unlink(missing_ok=True)
        (rec_dir(p) / f"{m['id']}.json").unlink(missing_ok=True)
        return {"added": rel, "id": new_id, "markers": len(marks), "project": project_json(p)}

    @app.post("/api/projects/{name}/record/start")
    def record_start(name: str, body: dict):
        p = load(name)
        rid = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        mime = str(body.get("mime") or "video/webm")
        m = {"id": rid, "kind": body.get("kind", "clip"), "at": float(body.get("at") or 0), "fit": body.get("fit", ""),
             "add": bool(body.get("add", True)), "mime": mime, "ext": "mp4" if "mp4" in mime else "webm",
             "started": dt.datetime.now().isoformat(timespec="seconds"), "bytes": 0, "seq": 0, "markers": []}
        (rec_dir(p) / f"{rid}.part").write_bytes(b"")
        rec_save_manifest(p, m)
        return {"id": rid}

    @app.post("/api/projects/{name}/record/{rid}/chunk")
    async def record_chunk(name: str, rid: str, request: Request, seq: int = 0):
        p = load(name)
        m = rec_manifest(p, rid)
        if seq != m["seq"]:
            if seq < m["seq"]:
                return {"bytes": m["bytes"], "seq": m["seq"], "dup": True}
            raise HTTPException(409, f"expected chunk {m['seq']}, got {seq}")
        data = await request.body()
        with open(rec_dir(p) / f"{rid}.part", "ab") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        m["bytes"] += len(data)
        m["seq"] = seq + 1
        rec_save_manifest(p, m)
        return {"bytes": m["bytes"], "seq": m["seq"]}

    @app.post("/api/projects/{name}/record/{rid}/finish")
    def record_finish(name: str, rid: str):
        p = load(name)
        return finalize_recording(p, rec_manifest(p, rid))

    @app.post("/api/projects/{name}/record/{rid}/marker")
    def record_marker(name: str, rid: str, body: dict):
        """A marker dropped while recording (seconds into the take). Saved right away so a take
        recovered after a crash keeps its markers."""
        p = load(name)
        m = rec_manifest(p, rid)
        m["markers"] = sorted(set((m.get("markers") or []) + [round(max(0.0, float(body["t"])), 3)]))
        rec_save_manifest(p, m)
        return {"n": len(m["markers"])}

    @app.get("/api/projects/{name}/recordings")
    def recordings_pending(name: str):
        """Unfinished recording sessions (e.g. after a crash) that can be recovered."""
        import json
        p = load(name)
        out = []
        for f in sorted(rec_dir(p).glob("*.json")):
            try:
                m = json.loads(f.read_text())
            except Exception:
                continue
            part = rec_dir(p) / f"{m['id']}.part"
            size = part.stat().st_size if part.exists() else 0
            m["bytes"] = size
            m["recoverable"] = size >= 1000
            out.append(m)
        return out

    @app.delete("/api/projects/{name}/recordings/{rid}")
    def recordings_discard(name: str, rid: str):
        p = load(name)
        (rec_dir(p) / f"{rid}.part").unlink(missing_ok=True)
        (rec_dir(p) / f"{rid}.json").unlink(missing_ok=True)
        return {"ok": True}

    @app.post("/api/projects/{name}/record")
    async def record(name: str, file: UploadFile = File(...), kind: str = Form("clip"), at: float = Form(0.0),
                     add: str = Form("true"), fit: str = Form(""), markers: str = Form("[]")):
        """One-shot upload of a whole recording (fallback / CLI use)."""
        p = load(name)
        rid = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        mime = file.content_type or "video/webm"
        m = {"id": rid, "kind": kind, "at": at, "fit": fit, "add": str(add).lower() in ("1", "true", "yes", "on"),
             "mime": mime, "ext": "mp4" if "mp4" in mime else "webm", "started": dt.datetime.now().isoformat(timespec="seconds")}
        try:
            import json
            m["markers"] = [float(t) for t in json.loads(markers or "[]")]
        except Exception:
            m["markers"] = []
        with open(rec_dir(p) / f"{rid}.part", "wb") as out:
            while chunk := await file.read(1 << 20):
                out.write(chunk)
        rec_save_manifest(p, m)
        return finalize_recording(p, m)

    @app.post("/api/projects/{name}/voiceovers")
    def add_voiceover(name: str, body: dict):
        p = load(name)
        src = Path(body["file"]).expanduser()
        if not src.exists():
            raise HTTPException(400, f"not found: {src}")
        p.ensure_dirs()
        dst = p.audio_dir / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
        media.measure_loudness(dst, p.cache_dir)
        p.add_voiceover(f"audio/{dst.name}", float(body.get("at", 0)))
        commit(p)
        return project_json(p)

    @app.patch("/api/projects/{name}/voiceovers/{vid}")
    def patch_voiceover(name: str, vid: str, body: dict):
        p = load(name)
        v = p.voiceover(vid)
        if "at" in body:
            v.at = max(0.0, parse_time(body["at"]))
        if "volume" in body:
            v.volume = float(body["volume"])
        if "duck_clips" in body:
            v.duck_clips = bool(body["duck_clips"])
        if "note" in body:
            v.note = str(body["note"])
        p.voiceovers.sort(key=lambda x: x.at)
        commit(p)
        return project_json(p)

    @app.delete("/api/projects/{name}/voiceovers/{vid}")
    def delete_voiceover(name: str, vid: str, remove_file: bool = False):
        p = load(name)
        v = p.voiceover(vid)
        p.voiceovers = [x for x in p.voiceovers if x.id != vid]
        if remove_file:
            p.resolve(v.file).unlink(missing_ok=True)
        commit(p)
        return project_json(p)

    @app.post("/api/projects/{name}/stings")
    def add_sting(name: str, body: dict):
        p = load(name)
        if body.get("file") == "intro":
            rel = sting_rel(p, cfg)
            if not rel:
                raise HTTPException(400, "no intro sting configured (Settings → App)")
        else:
            src = Path(body["file"]).expanduser()
            if not src.exists():
                raise HTTPException(400, f"not found: {src}")
            p.ensure_dirs()
            dst = p.audio_dir / src.name
            if not dst.exists():
                shutil.copy2(src, dst)
            rel = f"audio/{dst.name}"
        frm = body.get("from") or (p.timeline[0].id if p.timeline else "")
        if not frm:
            raise HTTPException(400, "timeline is empty")
        kw = {}
        for k in ("start", "volume", "fade_in", "fade_out"):
            if body.get(k) is not None:
                kw[k] = parse_time(body[k]) if k == "start" else float(body[k])
        if body.get("duck") is not None:
            kw["duck"] = bool(body["duck"])
        p.add_sting(rel, frm, body.get("to") or frm, **kw)
        commit(p)
        return project_json(p)

    @app.patch("/api/projects/{name}/stings/{mid}")
    def patch_sting(name: str, mid: str, body: dict):
        p = load(name)
        m = p.sting(mid)
        if "from" in body:
            m.from_id = str(body["from"])
        if "to" in body:
            m.to_id = str(body["to"] or m.from_id)
        if "start" in body:
            m.start = max(0.0, parse_time(body["start"]))
        for k in ("volume", "fade_in", "fade_out"):
            if k in body:
                setattr(m, k, max(0.0, float(body[k])))
        if "duck" in body:
            m.duck = bool(body["duck"])
        if "note" in body:
            m.note = str(body["note"])
        commit(p)
        return project_json(p)

    @app.delete("/api/projects/{name}/stings/{mid}")
    def delete_sting(name: str, mid: str):
        p = load(name)
        p.stings = [x for x in p.stings if x.id != mid]
        commit(p)
        return project_json(p)

    # ------------------------------------------------------------------ pictures over the video
    @app.post("/api/projects/{name}/images")
    def add_image(name: str, body: dict):
        """Add pictures (paths) to the images track, one after another from `at`."""
        p = load(name)
        files = body.get("files") or ([body["file"]] if body.get("file") else [])
        if not files:
            raise HTTPException(400, "no image")
        at, dur, ids = float(body.get("at") or 0), float(body.get("for") or 3), []
        for path in files:
            rel = _import_asset(p, path)
            ids.append(p.add_image(rel, at, dur, box=_box(body.get("box")), fit=str(body.get("fit") or "contain")).id)
            at += dur
        commit(p)
        return project_json(p) | {"new_ids": ids}

    @app.post("/api/projects/{name}/images/upload")
    async def upload_images(name: str, files: list[UploadFile] = File(...), at: float = Form(0.0), dur: float = Form(3.0)):
        """Dropped or pasted pictures: saved into assets/ and placed one after another from `at`."""
        p = load(name)
        ids = []
        for uf in files:
            fname = Path(uf.filename or "image.png").name
            suf = Path(fname).suffix.lower()
            if suf not in (".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif"):
                continue
            if Path(fname).stem.lower() in ("image", "blob", "") or fname.lower().startswith("pasted"):
                fname = f"pasted-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}{suf}"
            data = await uf.read()
            dst = _asset_dest(p, fname, len(data))
            if not dst.exists():
                dst.write_bytes(data)
            rel = f"assets/{_browser_image(dst).name}"
            ids.append(p.add_image(rel, at, dur).id)
            at += dur
        if not ids:
            raise HTTPException(400, "no pictures in that drop (JPEG, PNG, HEIC or WebP)")
        commit(p)
        return project_json(p) | {"new_ids": ids}

    @app.patch("/api/projects/{name}/images/{iid}")
    def patch_image(name: str, iid: str, body: dict):
        p = load(name)
        m = p.image(iid)
        if "at" in body:
            m.at = max(0.0, parse_time(body["at"]))
        if "for" in body or "duration" in body:
            m.duration = max(0.2, float(parse_time(body.get("for", body.get("duration")))))
        if "box" in body:
            m.box = _box(body["box"])
        if "fit" in body:
            m.fit = "cover" if body["fit"] == "cover" else "contain"
        if "fade" in body:
            m.fade = max(0.0, min(3.0, float(body["fade"])))
        if body.get("file"):
            m.file = _import_asset(p, str(body["file"]))
        if "note" in body:
            m.note = str(body["note"])
        if body.get("front"):                      # draw it above the others
            p.images = [x for x in p.images if x.id != iid] + [m]
        commit(p)
        return project_json(p)

    @app.delete("/api/projects/{name}/images/{iid}")
    def delete_image(name: str, iid: str):
        p = load(name)
        p.image(iid)
        p.images = [x for x in p.images if x.id != iid]
        commit(p)
        return project_json(p)

    # ------------------------------------------------------------------ immich
    @app.get("/api/immich/videos")
    def immich_videos(date: str | None = None, days: int = 1):
        key = f"{date}:{days}"
        hit = immich_cache.get(key)
        if hit and time.time() - hit[0] < 60:
            return hit[1]
        im = immich()
        try:
            if date:
                vids = im.videos_on(dt.date.fromisoformat(date), days=days)
            else:
                vids = im.recent_videos()
        except Exception as e:
            raise HTTPException(502, f"Immich error: {e}")
        for v in vids:
            v["thumb_url"] = f"/api/immich/thumb/{v['id']}"
        immich_cache[key] = (time.time(), vids)
        return vids

    @app.get("/api/immich/thumb/{asset_id}")
    def immich_thumb(asset_id: str):
        im = immich()
        try:
            data, ctype = im.thumbnail(asset_id)
        except Exception as e:
            raise HTTPException(502, str(e))
        return Response(content=data, media_type=ctype, headers={"Cache-Control": "max-age=86400"})

    @app.post("/api/projects/{name}/import-immich")
    def import_immich(name: str, body: dict):
        p = load(name)
        im = immich()
        assets = body.get("assets", [])   # [{id, filename}]
        add = body.get("add", True)
        job = Job("import", name)

        def work(job: Job):
            for i, a in enumerate(assets):
                if job.cancel.is_set():
                    raise RuntimeError("cancelled")
                job.message = f"downloading {a.get('filename') or a['id']} ({i + 1}/{len(assets)})"
                job.progress = i / max(1, len(assets))
                path = im.download(a["id"], p.clips_dir, a.get("filename"))
                rel = f"clips/{path.name}"
                job.added.append(rel)
                media.prepare(p, rel)
                pp = Project.load(p.folder)   # reload: UI may have changed things meanwhile
                if add and not any(s.src == rel for s in pp.timeline):
                    pp.add_clip(rel)
                    pp.save()  # background import: not an undo step
            job.message = "done"

        return _run_job(job, work).to_dict()

    # ------------------------------------------------------------------ render
    def start_render(name: str, mode: str):
        p = load(name)
        for j in JOBS.values():
            if j.project == name and j.kind in ("preview", "render") and j.status == "running":
                j.cancel.set()
        job = Job("preview" if mode == "preview" else "render", name)

        def work(job: Job):
            def prog(frac, secs):
                job.progress, job.secs = frac, secs
            plan = render.render(p, mode=mode, progress=prog, cancel=job.cancel)
            job.warnings = plan.warnings
            job.output = str(plan.output)

        return _run_job(job, work).to_dict()

    @app.post("/api/projects/{name}/preview")
    def do_preview(name: str):
        return start_render(name, "preview")

    @app.post("/api/projects/{name}/render")
    def do_render(name: str):
        return start_render(name, "final")

    @app.get("/api/projects/{name}/command")
    def show_command(name: str, mode: str = "final"):
        return {"command": render.cmd_string(render.build_plan(load(name), mode=mode))}

    @app.get("/api/jobs")
    def jobs():
        return [j.to_dict() for j in sorted(JOBS.values(), key=lambda j: j.started, reverse=True)[:20]]

    @app.get("/api/jobs/{jid}")
    def job(jid: str):
        if jid not in JOBS:
            raise HTTPException(404)
        return JOBS[jid].to_dict()

    @app.post("/api/jobs/{jid}/cancel")
    def cancel_job(jid: str):
        if jid in JOBS:
            JOBS[jid].cancel.set()
        return {"ok": True}

    # ------------------------------------------------------------------ mac glue
    @app.post("/api/reveal")
    def reveal(body: dict):
        subprocess.Popen(["open", "-R", body["path"]])
        return {"ok": True}

    @app.post("/api/open")
    def open_path(body: dict):
        subprocess.Popen(["open", body["path"]])
        return {"ok": True}

    @app.post("/api/pick")
    def pick_files(body: dict):
        """Native macOS file picker (returns paths)."""
        kind = body.get("kind", "files")
        script = {
            "files": 'set fs to choose file with prompt "Choose video clips" of type {"public.movie"} with multiple selections allowed\n'
                     'set out to ""\nrepeat with f in fs\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out',
            "folder": 'return POSIX path of (choose folder with prompt "Choose a folder of clips")',
            "music": 'return POSIX path of (choose file with prompt "Choose music" of type {"public.audio"})',
            "image": 'return POSIX path of (choose file with prompt "Choose an image" of type {"public.image"})',
            "images": 'set fs to choose file with prompt "Choose pictures to show over the video" of type {"public.image"} with multiple selections allowed\n'
                      'set out to ""\nrepeat with f in fs\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out',
        }[kind]
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            return {"paths": []}
        return {"paths": [l.strip() for l in r.stdout.splitlines() if l.strip()]}

    return app


PID_DIR = Path.home() / "Library" / "Application Support" / "krisvideos"


def serve(cfg: Config, port: int = 8765, open_browser: bool = False):
    import os
    import uvicorn
    app = create_app(cfg)
    try:  # the .app launcher uses this to restart a server running stale code
        PID_DIR.mkdir(parents=True, exist_ok=True)
        (PID_DIR / f"server-{port}.pid").write_text(f"{os.getpid()}\n")
    except OSError:
        pass
    url = f"http://127.0.0.1:{port}"
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print(f"krisvideos GUI at {url}  (vlogs in {cfg.vlogs_path})")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
