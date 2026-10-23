"""Render title cards and captions to PNG with Pillow (ffmpeg overlays them)."""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_DIRS = [Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library/Fonts",
             Path("/System/Library/Fonts/Supplemental")]
FALLBACK_FONT = "/System/Library/Fonts/Helvetica.ttc"


def _hex_to_rgba(s: str) -> tuple[int, int, int, int]:
    s = s.strip().lstrip("#")
    if len(s) == 6:
        s += "ff"
    if len(s) == 3:
        s = "".join(c * 2 for c in s) + "ff"
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4, 6))  # type: ignore[return-value]


@lru_cache(maxsize=64)
def _font_file(family: str) -> Path:
    fam = Path(family).expanduser()
    if fam.suffix and fam.exists():
        return fam
    want = family.lower().replace(" ", "")
    for d in FONT_DIRS:
        if not d.exists():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() in (".ttc", ".ttf", ".otf") and f.stem.lower().replace(" ", "") == want:
                return f
    return Path(FALLBACK_FONT)


@lru_cache(maxsize=256)
def _face_index(path: str, preferred: tuple[str, ...]) -> int:
    """Pick the face in a .ttc whose style name best matches `preferred` (ordered)."""
    names: list[tuple[int, str]] = []
    for i in range(0, 40):
        try:
            f = ImageFont.truetype(path, 20, index=i)
            names.append((i, f.getname()[1].lower()))
        except Exception:
            break
    for want in preferred:
        for i, style in names:
            if style == want.lower():
                return i
    for want in preferred:
        for i, style in names:
            if want.lower() in style:
                return i
    return 0


def load_font(family: str, size: int, weight: str = "bold") -> ImageFont.FreeTypeFont:
    path = _font_file(family)
    prefs = {
        "bold": ("demi bold", "demibold", "bold", "semibold", "heavy", "medium", "regular"),
        "medium": ("medium", "regular", "demi bold", "bold"),
        "regular": ("regular", "medium", "book"),
    }[weight]
    idx = _face_index(str(path), prefs) if path.suffix.lower() == ".ttc" else 0
    try:
        return ImageFont.truetype(str(path), size, index=idx)
    except Exception:
        return ImageFont.truetype(FALLBACK_FONT, size)


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        cur = words[0]
        for w in words[1:]:
            trial = cur + " " + w
            if draw.textlength(trial, font=font) <= max_width:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def _fit_font(draw, text, family, weight, max_w, max_h, start_size) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    size = start_size
    while size > 12:
        font = load_font(family, size, weight)
        lines = _wrap(draw, text, font, max_w)
        line_h = int(size * 1.18)
        if len(lines) * line_h <= max_h and all(draw.textlength(l, font=font) <= max_w for l in lines):
            return font, lines
        size = int(size * 0.9)
    font = load_font(family, size, weight)
    return font, _wrap(draw, text, font, max_w)


def _key(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def render_title_card(cache_dir: Path, w: int, h: int, text: str, subtitle: str, *,
                      font: str, bg: str, fg: str, accent: str, date_line: str = "") -> Path:
    """Full-frame opaque title card."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"title_{_key('v2', w, h, text, subtitle, font, bg, fg, accent, date_line)}.png"
    if out.exists():
        return out
    img = Image.new("RGBA", (w, h), _hex_to_rgba(bg))
    draw = ImageDraw.Draw(img)
    short = min(w, h)
    margin = int(short * 0.10)
    max_w = w - 2 * margin
    title_font, title_lines = _fit_font(draw, text, font, "bold", max_w, int(h * 0.5), int(short * 0.11))
    tl_h = int(title_font.size * 1.18)
    sub_font = sub_lines = None
    sl_h = 0
    if subtitle:
        sub_font, sub_lines = _fit_font(draw, subtitle, font, "medium", max_w, int(h * 0.25), int(short * 0.045))
        sl_h = int(sub_font.size * 1.3)
    gap = int(short * 0.03) if subtitle else 0
    block_h = len(title_lines) * tl_h + gap + (len(sub_lines) * sl_h if sub_lines else 0)
    y = (h - block_h) // 2
    # thin accent rule above the title
    rule_w = int(short * 0.08)
    draw.rounded_rectangle([(w - rule_w) // 2, y - int(short * 0.05), (w + rule_w) // 2, y - int(short * 0.05) + max(3, short // 300)],
                           radius=3, fill=_hex_to_rgba(accent))
    for line in title_lines:
        tw = draw.textlength(line, font=title_font)
        draw.text(((w - tw) / 2, y), line, font=title_font, fill=_hex_to_rgba(fg))
        y += tl_h
    y += gap
    if sub_lines:
        for line in sub_lines:
            tw = draw.textlength(line, font=sub_font)
            draw.text(((w - tw) / 2, y), line, font=sub_font, fill=_hex_to_rgba(accent))
            y += sl_h
    if date_line:
        f = load_font(font, int(short * 0.03), "medium")
        tw = draw.textlength(date_line, font=f)
        draw.text(((w - tw) / 2, h - margin - f.size), date_line, font=f, fill=_hex_to_rgba(accent))
    img.save(out)
    return out


def render_caption(cache_dir: Path, w: int, h: int, text: str, *, font: str, bg: str, fg: str,
                   position: str = "bottom", style: str = "caption") -> Path:
    """Transparent full-frame PNG with a caption pill (or big centered text)."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"cap_{_key('v2', w, h, text, font, bg, fg, position, style)}.png"
    if out.exists():
        return out
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    short = min(w, h)
    margin = int(short * 0.07)
    max_w = w - 2 * margin
    if style == "big":
        f, lines = _fit_font(draw, text, font, "bold", max_w, int(h * 0.5), int(short * 0.09))
        lh = int(f.size * 1.15)
        block = len(lines) * lh
        y = {"top": margin + int(h * 0.06), "center": (h - block) // 2}.get(position, h - margin - int(h * 0.08) - block)
        for line in lines:
            tw = draw.textlength(line, font=f)
            x = (w - tw) / 2
            # soft shadow for legibility
            for dx, dy in ((2, 2), (0, 3)):
                draw.text((x + dx, y + dy), line, font=f, fill=(0, 0, 0, 160))
            draw.text((x, y), line, font=f, fill=_hex_to_rgba(fg))
            y += lh
    else:
        f, lines = _fit_font(draw, text, font, "medium", int(max_w * 0.92), int(h * 0.3), int(short * 0.042))
        lh = int(f.size * 1.25)
        pad_x, pad_y = int(f.size * 0.7), int(f.size * 0.45)
        text_w = max(draw.textlength(l, font=f) for l in lines)
        box_w, box_h = int(text_w + 2 * pad_x), len(lines) * lh + 2 * pad_y
        x0 = (w - box_w) // 2
        y0 = {"top": margin + int(h * 0.05), "center": (h - box_h) // 2}.get(position, h - margin - int(h * 0.06) - box_h)
        draw.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=int(box_h * 0.3), fill=_hex_to_rgba(bg))
        y = y0 + pad_y
        for line in lines:
            tw = draw.textlength(line, font=f)
            draw.text(((w - tw) / 2, y), line, font=f, fill=_hex_to_rgba(fg))
            y += lh
    img.save(out)
    return out
