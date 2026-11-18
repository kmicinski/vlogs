"""Automatic lens calibration: find the `lenscorrection` k1/k2 that straighten a camera.

Kris prints the checkerboard (`pattern_png`), holds it in front of the webcam and the GUI sends frames
here. Each frame's inner chessboard corners (`find_board`) give rows and columns of points that *should*
be straight lines; `fit` searches the k1/k2 that make them straightest once the frame is undistorted with
ffmpeg's own model ("plumb-line" calibration). The result goes into config `lenses` for that camera label,
so every take from it is straightened in the export and in the live player.

ffmpeg's `lenscorrection` (vf_lenscorrection.c): a destination pixel at offset (dx, dy) from the centre, with
r² = 4 (dx² + dy²) / (w² + h²) (so r = 1 at a frame corner), samples the source at (dx, dy) · (1 + k1 r² + k2 r⁴).
A barrel-distorted take therefore needs k1 < 0. `undistort_points` inverts that mapping for detected points.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BOARD = (9, 6)            # inner corners (10 × 7 squares)
SQUARE_MM = 24.0          # printed square size: the board is 240 × 168 mm, landscape Letter or A4


def _cv2():
    try:
        import cv2  # noqa: WPS433
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("automatic lens calibration needs opencv-python-headless (uv sync)") from e
    return cv2


# ------------------------------------------------------------------ the printable pattern
def pattern_png(dpi: int = 300, paper: str = "letter") -> bytes:
    """A landscape page with the 10 × 7 checkerboard (24 mm squares) and one line of instructions."""
    w_mm, h_mm = (279.4, 215.9) if paper == "letter" else (297.0, 210.0)
    W, H = int(w_mm / 25.4 * dpi), int(h_mm / 25.4 * dpi)
    sq = SQUARE_MM / 25.4 * dpi
    cols, rows = BOARD[0] + 1, BOARD[1] + 1
    bw, bh = cols * sq, rows * sq
    x0, y0 = (W - bw) / 2, (H - bh) / 2 - sq * 0.25
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    for r in range(rows):
        for c in range(cols):
            if (r + c) % 2 == 0:
                d.rectangle([round(x0 + c * sq), round(y0 + r * sq), round(x0 + (c + 1) * sq) - 1, round(y0 + (r + 1) * sq) - 1], fill=0)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", int(dpi * 0.11))
    except Exception:
        font = ImageFont.load_default()
    txt = "KrisVideos lens calibration · keep the page flat (tape it to cardboard) · 24 mm squares"
    d.text((W / 2, y0 + bh + sq * 0.5), txt, fill=90, font=font, anchor="mm")
    buf = io.BytesIO()
    im.save(buf, "PNG", dpi=(dpi, dpi))
    return buf.getvalue()


# ------------------------------------------------------------------ detection
@dataclass
class Board:
    """One detected checkerboard: inner corners as rows × cols × (x, y) in frame pixels."""
    corners: np.ndarray          # (rows, cols, 2)
    width: int
    height: int

    def lines(self) -> list[np.ndarray]:
        """Every row and every column of corners: sets of points that should be collinear."""
        rows, cols = self.corners.shape[:2]
        return [self.corners[r] for r in range(rows)] + [self.corners[:, c] for c in range(cols)]

    def coverage(self, n: int = 3) -> list[bool]:
        """Which cells of an n × n grid over the frame hold corners (row-major, top-left first)."""
        cells = [False] * (n * n)
        for x, y in self.corners.reshape(-1, 2):
            i, j = min(n - 1, int(y / self.height * n)), min(n - 1, int(x / self.width * n))
            cells[i * n + j] = True
        return cells


def find_board(image: bytes | np.ndarray, board: tuple[int, int] = BOARD, max_width: int = 1280) -> Board | None:
    """The checkerboard's inner corners in a JPEG/PNG (bytes) or an array, or None when it is not fully visible.
    Big frames are searched downscaled (the normalized model does not care) and corners are returned in that
    frame's pixels together with its size."""
    cv2 = _cv2()
    if isinstance(image, (bytes, bytearray)):
        arr = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            return None
    else:
        arr = image
    h, w = arr.shape[:2]
    if w > max_width:
        s = max_width / w
        arr = cv2.resize(arr, (max_width, int(round(h * s))), interpolation=cv2.INTER_AREA)
        h, w = arr.shape[:2]
    gray = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY) if arr.ndim == 3 else arr
    found, pts = cv2.findChessboardCornersSB(gray, board, cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY | cv2.CALIB_CB_NORMALIZE_IMAGE)
    if not found or pts is None or len(pts) != board[0] * board[1]:
        found, pts = cv2.findChessboardCorners(gray, board, cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE)
        if not found:
            return None
        pts = cv2.cornerSubPix(gray, pts.astype(np.float32), (7, 7), (-1, -1), (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 1e-3))
    corners = pts.reshape(board[1], board[0], 2).astype(np.float64)
    return Board(corners, w, h)


# ------------------------------------------------------------------ the model
def _norm(w: int, h: int) -> float:
    return 2.0 / math.sqrt(w * w + h * h)      # r = norm · pixel distance from the centre, 1 at a corner


def undistort_points(pts: np.ndarray, w: int, h: int, k1: float, k2: float) -> np.ndarray:
    """Where ffmpeg's `lenscorrection=k1:k2` puts source points (x, y): solve r_d (1 + k1 r_d² + k2 r_d⁴) = r_s
    for the destination radius by Newton's method (the forward map is dst → src)."""
    cx, cy = w / 2.0, h / 2.0
    n = _norm(w, h)
    dx, dy = (pts[..., 0] - cx) * n, (pts[..., 1] - cy) * n
    rs = np.sqrt(dx * dx + dy * dy)
    rd = rs.copy()
    for _ in range(12):
        r2 = rd * rd
        f = rd * (1 + k1 * r2 + k2 * r2 * r2) - rs
        df = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2
        df = np.where(np.abs(df) < 1e-6, 1e-6, df)
        rd = rd - f / df
    scale = np.where(rs > 1e-9, rd / rs, 1.0)
    out = np.empty_like(pts)
    out[..., 0] = cx + dx * scale / n
    out[..., 1] = cy + dy * scale / n
    return out


def straightness(lines: list[np.ndarray]) -> float:
    """RMS distance (pixels) of the points from their best-fit lines: 0 for perfectly straight rows/columns."""
    tot, cnt = 0.0, 0
    for L in lines:
        c = L - L.mean(axis=0)
        # the smallest eigenvalue of the 2×2 scatter matrix is the summed squared perpendicular distance
        cov = c.T @ c
        tr, det = cov[0, 0] + cov[1, 1], cov[0, 0] * cov[1, 1] - cov[0, 1] * cov[1, 0]
        lam = tr / 2 - math.sqrt(max(0.0, tr * tr / 4 - det))
        tot += max(0.0, lam)
        cnt += len(L)
    return math.sqrt(tot / cnt) if cnt else 0.0


@dataclass
class Fit:
    k1: float
    k2: float
    rms_before: float      # px, at the detection size
    rms_after: float
    boards: int
    width: int
    height: int
    coverage: list[bool] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"k1": round(self.k1, 4), "k2": round(self.k2, 4), "rms_before": round(self.rms_before, 3), "rms_after": round(self.rms_after, 3),
                "boards": self.boards, "width": self.width, "height": self.height, "coverage": self.coverage,
                "improvement": round(1 - self.rms_after / self.rms_before, 3) if self.rms_before > 1e-9 else 0.0}


def fit(boards: list[Board], k2_free: bool = True) -> Fit:
    """The k1/k2 that make every board's rows and columns straightest after undistortion. A coarse grid over
    k1 ∈ [-0.6, 0.3] (and k2 ∈ [-0.3, 0.3]) finds the basin, then two finer grids close in (the cost is smooth
    and this stays well under a second for a dozen boards)."""
    if not boards:
        raise ValueError("no boards")
    w, h = boards[0].width, boards[0].height
    for b in boards:
        if (b.width, b.height) != (w, h):
            raise ValueError("all frames must have the same size")
    lines = [L for b in boards for L in b.lines()]
    pts = np.concatenate([L for L in lines])
    idx = np.cumsum([0] + [len(L) for L in lines])

    def cost(k1: float, k2: float) -> float:
        u = undistort_points(pts, w, h, k1, k2)
        return straightness([u[idx[i]:idx[i + 1]] for i in range(len(lines))])

    best = (cost(0.0, 0.0), 0.0, 0.0)
    k1s = np.linspace(-0.6, 0.3, 46)
    k2s = np.linspace(-0.3, 0.3, 13) if k2_free else np.array([0.0])
    for k1 in k1s:
        for k2 in k2s:
            c = cost(k1, k2)
            if c < best[0]:
                best = (c, float(k1), float(k2))
    span1, span2 = 0.04, 0.1
    for _ in range(3):
        _, b1, b2 = best
        for k1 in np.linspace(b1 - span1, b1 + span1, 17):
            for k2 in (np.linspace(b2 - span2, b2 + span2, 11) if k2_free else [0.0]):
                c = cost(k1, k2)
                if c < best[0]:
                    best = (c, float(k1), float(k2))
        span1 /= 6; span2 /= 6
    cov = [any(c) for c in zip(*[b.coverage() for b in boards])]
    return Fit(best[1], best[2], straightness(lines), best[0], len(boards), w, h, cov)


def coverage_hint(cov: list[bool]) -> str:
    """What to do next, from the 3 × 3 coverage so far (the edges and corners matter most for a lens)."""
    names = ["top left", "top", "top right", "left", "centre", "right", "bottom left", "bottom", "bottom right"]
    missing = [names[i] for i, c in enumerate(cov) if not c]
    if not missing:
        return "every part of the frame is covered"
    edges = [m for m in missing if m != "centre"]
    return "move the board to the " + (edges[0] if edges else "centre") + (f" ({len(missing)} areas to go)" if len(missing) > 1 else "")


def decodable(image: bytes) -> bool:
    cv2 = _cv2()
    return cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR) is not None


def corrected_jpeg(image: bytes, k1: float, k2: float, quality: int = 85) -> bytes:
    """The frame remapped exactly like ffmpeg's `lenscorrection=k1:k2` (bilinear), as JPEG: the preview."""
    cv2 = _cv2()
    arr = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise ValueError("not an image")
    h, w = arr.shape[:2]
    cx, cy, n = w / 2.0, h / 2.0, _norm(w, h)
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    dx, dy = (xs - cx) * n, (ys - cy) * n
    r2 = dx * dx + dy * dy
    m = 1 + k1 * r2 + k2 * r2 * r2
    mapx, mapy = (cx + dx * m / n).astype(np.float32), (cy + dy * m / n).astype(np.float32)
    out = cv2.remap(arr, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else b""


def save_lens(cfg, cam: str, k1: float, k2: float) -> dict:
    """Write (k1, k2) for this camera into config `lenses`: the entry its label already falls under is
    updated, else a new one named after the label is added. Returns the entry."""
    from .config import lens_for
    lenses = [dict(x) for x in cfg.lenses]
    hit = lens_for(cam, lenses)
    if hit is not None:
        hit["k1"], hit["k2"] = round(k1, 4), round(k2, 4)
    else:
        hit = {"match": cam, "k1": round(k1, 4), "k2": round(k2, 4)}
        lenses.append(hit)
    cfg.lenses = lenses
    cfg.save()
    return hit
