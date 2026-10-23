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

from . import media, render
from .cli import title_at
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
        self.cancel = threading.Event()
        self.started = time.time()

    def to_dict(self):
        return {k: getattr(self, k) for k in ("id", "kind", "project", "status", "progress", "secs", "message",
                                                 "error", "output", "warnings")} | {"elapsed": round(time.time() - self.started, 1)}


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
    font: str | None = None


class NewProject(BaseModel):
    name: str | None = None
    title: str | None = None
    opening: bool = True


class YamlIn(BaseModel):
    yaml: str


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
        return Project.load(project_dir(name))

    def immich():
        from .immich import Immich
        try:
            return Immich(cfg.immich_url, cfg.immich_api_key)
        except Exception as e:
            raise HTTPException(400, str(e))

    def media_url(p: Project, rel: str) -> str:
        return f"/media/{p.name}/{rel}"

    def project_json(p: Project) -> dict:
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
                d["proxy_url"] = media_url(p, f"cache/{Path(s.src).name}.proxy.mp4") if st["proxy"] else None
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
                "proxy_url": media_url(p, f"cache/{f.name}.proxy.mp4") if st["proxy"] else None,
            })
        preview = p.out_dir / "preview.mp4"
        final = p.out_dir / p.output_filename()
        ymtime = p.path.stat().st_mtime
        return {
            "name": p.name, "title": p.title, "date": p.date, "folder": str(p.folder),
            "output": p.output.__dict__, "style": p.style.__dict__, "music": p.music.__dict__, "audio": p.audio.__dict__,
            "timeline": segs, "clips": clips, "voiceovers": vos,
            "layout": {"width": layout.width, "height": layout.height, "total": layout.total, "fps": layout.fps,
                       "orientation": layout.orientation} if layout else None,
            "preview": {"url": media_url(p, "out/preview.mp4") + f"?v={int(preview.stat().st_mtime)}",
                        "stale": preview.stat().st_mtime < ymtime} if preview.exists() else None,
            "final": {"url": media_url(p, f"out/{final.name}") + f"?v={int(final.stat().st_mtime)}", "path": str(final),
                      "stale": final.stat().st_mtime < ymtime, "size": final.stat().st_size} if final.exists() else None,
            "yaml": p.path.read_text(),
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
        p = Project.new(folder, title=body.title or name)
        p.output.orientation = cfg.default_orientation
        p.style.font = cfg.font
        p.style.transition = cfg.default_transition
        if cfg.default_music:
            p.music.file = cfg.default_music
        if body.opening:
            try:
                pretty = dt.date.fromisoformat(name).strftime("%A, %B %-d")
            except ValueError:
                pretty = p.title
            p.add_title(body.title or pretty, cfg.default_title_subtitle, 3.0)
        p.save()
        return project_json(p)

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
        p.save()
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
        p.save()
        return project_json(p)

    # ------------------------------------------------------------------ segments
    @app.post("/api/projects/{name}/segments")
    def add_segment(name: str, body: dict):
        p = load(name)
        at = body.get("at")
        if body.get("kind") == "title":
            p.add_title(body.get("text") or "Title", body.get("subtitle") or "", float(body.get("duration") or 3), at=at)
        else:
            src = body["src"]
            if not p.resolve(src).exists():
                raise HTTPException(400, f"missing {src}")
            p.add_clip(src, at=at)
        p.save()
        return project_json(p)

    @app.patch("/api/projects/{name}/segments/{sid}")
    def patch_segment(name: str, sid: str, body: dict):
        p = load(name)
        s = p.timeline[p.index_of(sid)]
        for k, v in body.items():
            if k == "in":
                s.in_ = parse_time(v)
            elif k == "out":
                s.out = None if v in (None, "", "end") else parse_time(v)
            elif k in ("text", "title"):
                s.text = str(v)
            elif k == "overlays":
                s.overlays = [Overlay.from_dict(o) for o in v]
            elif k in ("duration", "transition_duration"):
                setattr(s, k, None if v in (None, "") else float(v))
            elif k in ("speed", "volume"):
                setattr(s, k, float(v))
            elif k == "mute":
                s.mute = bool(v)
            elif k == "fit":
                s.fit = "cover" if v == "cover" else "contain"
            elif k in ("caption", "subtitle", "transition", "note"):
                setattr(s, k, v if v != "" else ("" if k in ("subtitle", "note") else None))
        p.save()
        return project_json(p)

    @app.delete("/api/projects/{name}/segments/{sid}")
    def delete_segment(name: str, sid: str):
        p = load(name)
        p.remove(sid)
        p.save()
        return project_json(p)

    @app.post("/api/projects/{name}/reorder")
    def reorder(name: str, body: dict):
        p = load(name)
        by_id = {s.id: s for s in p.timeline}
        ids = [i for i in body["ids"] if i in by_id]
        p.timeline = [by_id[i] for i in ids] + [s for s in p.timeline if s.id not in ids]
        p.save()
        return project_json(p)

    @app.post("/api/projects/{name}/title-at")
    def title_at_api(name: str, body: dict):
        p = load(name)
        title_at(p, float(body["time"]), body.get("text") or "Title", body.get("subtitle") or "",
                 float(body.get("duration") or 3))
        p.save()
        return project_json(p)

    @app.post("/api/projects/{name}/split")
    def split_api(name: str, body: dict):
        p = load(name)
        layout = render.compute_layout(p)
        pl, off = render.locate(layout, float(body["time"]))
        if pl is None or pl.seg.kind != "clip" or off < 0.25 or pl.duration - off < 0.25:
            raise HTTPException(400, "nothing to split here")
        from copy import deepcopy
        seg = pl.seg
        cut = pl.src_in + off * seg.speed
        tail = deepcopy(seg)
        tail.id = p.next_id()
        tail.in_, tail.out, tail.caption, tail.transition = cut, pl.src_out, None, None
        tail.overlays = [Overlay(text=o.text, at=o.at - off, duration=o.duration, position=o.position, style=o.style)
                         for o in seg.overlays if o.at >= off]
        seg.out = cut
        seg.overlays = [o for o in seg.overlays if o.at < off]
        p.timeline.insert(pl.index + 1, tail)
        p.save()
        return project_json(p)

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
            for f in files:
                if not f.exists():
                    raise HTTPException(400, f"not found: {f}")
                rel = media.import_file(p, f)
                media.prepare_async(p, rel)
                if body.get("add", True) and not any(s.src == rel for s in p.timeline):
                    p.add_clip(rel)
                added.append(rel)
        p.save()
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
        p.save()
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
        p = Project.load(p.folder)
        if m["kind"] == "voiceover":
            new_id = p.add_voiceover(rel, max(0.0, float(m.get("at") or 0))).id
        else:
            seg = p.add_clip(rel) if m.get("add", True) else None
            if seg is not None and m.get("fit") in ("cover", "contain"):
                seg.fit = m["fit"]
            new_id = seg.id if seg else None
        p.save()
        part.unlink(missing_ok=True)
        (rec_dir(p) / f"{m['id']}.json").unlink(missing_ok=True)
        return {"added": rel, "id": new_id, "project": project_json(p)}

    @app.post("/api/projects/{name}/record/start")
    def record_start(name: str, body: dict):
        p = load(name)
        rid = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        mime = str(body.get("mime") or "video/webm")
        m = {"id": rid, "kind": body.get("kind", "clip"), "at": float(body.get("at") or 0), "fit": body.get("fit", ""),
             "add": bool(body.get("add", True)), "mime": mime, "ext": "mp4" if "mp4" in mime else "webm",
             "started": dt.datetime.now().isoformat(timespec="seconds"), "bytes": 0, "seq": 0}
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
                     add: str = Form("true"), fit: str = Form("")):
        """One-shot upload of a whole recording (fallback / CLI use)."""
        p = load(name)
        rid = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        mime = file.content_type or "video/webm"
        m = {"id": rid, "kind": kind, "at": at, "fit": fit, "add": str(add).lower() in ("1", "true", "yes", "on"),
             "mime": mime, "ext": "mp4" if "mp4" in mime else "webm", "started": dt.datetime.now().isoformat(timespec="seconds")}
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
        p.save()
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
        p.save()
        return project_json(p)

    @app.delete("/api/projects/{name}/voiceovers/{vid}")
    def delete_voiceover(name: str, vid: str, remove_file: bool = False):
        p = load(name)
        v = p.voiceover(vid)
        p.voiceovers = [x for x in p.voiceovers if x.id != vid]
        if remove_file:
            p.resolve(v.file).unlink(missing_ok=True)
        p.save()
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
                media.prepare(p, rel)
                pp = Project.load(p.folder)   # reload: UI may have changed things meanwhile
                if add and not any(s.src == rel for s in pp.timeline):
                    pp.add_clip(rel)
                    pp.save()
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
