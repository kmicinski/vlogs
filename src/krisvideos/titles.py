"""Render title cards and captions to PNG with Pillow (ffmpeg overlays them)."""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

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


def _fit_title(draw, text, family, max_w, max_h, start_size):
    """Like _fit_font, but a short title (a date, a word or two) shrinks a little rather than wrapping."""
    if text and len(text.split()) <= 4:
        size = start_size
        while size >= int(start_size * 0.62):
            font = load_font(family, size, "bold")
            if draw.textlength(text, font=font) <= max_w:
                return font, [text]
            size = int(size * 0.94)
    return _fit_font(draw, text, family, "bold", max_w, max_h, start_size)


def _key(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def _image_background(w: int, h: int, image: Path, fit: str) -> Image.Image:
    """Full-frame RGBA from a still image. contain = image fitted inside with a blurred, darkened
    copy filling the bars (so a 16:9 masthead still looks intentional on a 9:16 canvas); cover = crop."""
    src = Image.open(image).convert("RGBA")
    iw, ih = src.size
    if fit == "cover":
        r = max(w / iw, h / ih)
        big = src.resize((max(1, round(iw * r)), max(1, round(ih * r))), Image.LANCZOS)
        x, y = (big.width - w) // 2, (big.height - h) // 2
        return big.crop((x, y, x + w, y + h))
    r = min(w / iw, h / ih)
    fw, fh = max(1, round(iw * r)), max(1, round(ih * r))
    out = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    if (fw, fh) != (w, h):
        rb = max(w / iw, h / ih)
        bg = src.resize((max(1, round(iw * rb)), max(1, round(ih * rb))), Image.BILINEAR)
        bx, by = (bg.width - w) // 2, (bg.height - h) // 2
        bg = bg.crop((bx, by, bx + w, by + h)).filter(ImageFilter.GaussianBlur(radius=max(8, min(w, h) // 40)))
        bg = Image.blend(bg, Image.new("RGBA", (w, h), (0, 0, 0, 255)), 0.35)
        out.paste(bg, (0, 0))
    fitted = src.resize((fw, fh), Image.LANCZOS)
    out.paste(fitted, ((w - fw) // 2, (h - fh) // 2))
    return out


def render_title_card(cache_dir: Path, w: int, h: int, text: str, subtitle: str, *,
                      font: str, bg: str, fg: str, accent: str, date_line: str = "", layout: str = "center",
                      kicker: str = "", image: Path | None = None, fit: str = "contain") -> Path:
    """Full-frame opaque title card. layout: center | lower (left-aligned, lower third).
    `image` paints the background from a still (fit: contain | cover); text is optional then."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    img_key = f"{image}:{image.stat().st_mtime_ns}" if image is not None and image.exists() else ""
    out = cache_dir / f"title_{_key('v5', w, h, text, subtitle, font, bg, fg, accent, date_line, layout, kicker, img_key, fit)}.png"
    if out.exists():
        return out
    if layout == "lower" and not image:
        return _render_title_lower(out, w, h, text, subtitle, font=font, bg=bg, fg=fg, accent=accent, kicker=kicker)
    if image is not None and image.exists():
        img = _image_background(w, h, image, fit)
    else:
        img = Image.new("RGBA", (w, h), _hex_to_rgba(bg))
    if not (text or subtitle or kicker):
        img.save(out)
        return out
    draw = ImageDraw.Draw(img)
    short = min(w, h)
    margin = int(short * 0.10)
    max_w = w - 2 * margin
    title_font, title_lines = _fit_title(draw, text, font, max_w, int(h * 0.5), int(short * 0.11)) if text else (None, [])
    tl_h = int(title_font.size * 1.18) if title_font else 0
    sub_font = sub_lines = None
    sl_h = 0
    if subtitle:
        sub_font, sub_lines = _fit_font(draw, subtitle, font, "medium", max_w, int(h * 0.25), int(short * 0.045))
        sl_h = int(sub_font.size * 1.3)
    kick_font = kick_h = None
    if kicker:
        kick_font = load_font(font, int(short * 0.034), "bold")
        kick_h = int(kick_font.size * 1.2)
    gap = int(short * 0.03) if subtitle else 0
    kgap = int(short * 0.06) if kicker else 0
    block_h = (kick_h + kgap if kicker else 0) + len(title_lines) * tl_h + gap + (len(sub_lines) * sl_h if sub_lines else 0)
    y = (h - block_h) // 2
    if image is not None:
        # soft scrim behind the text block so it reads over any picture
        pad = int(short * 0.06)
        scrim = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(scrim).rounded_rectangle([margin - pad, y - pad - int(short * 0.05), w - margin + pad, y + block_h + pad],
                                                radius=int(short * 0.03), fill=_hex_to_rgba(bg)[:3] + (210,))
        img.alpha_composite(scrim)
        draw = ImageDraw.Draw(img)
    rule_y = y - int(short * 0.05)
    if kicker:
        kick_text = kicker.upper()
        # tracked-out small caps: draw letter by letter with extra spacing
        track = int(kick_font.size * 0.22)
        kw = sum(draw.textlength(c, font=kick_font) for c in kick_text) + track * (len(kick_text) - 1)
        x = (w - kw) / 2
        for c in kick_text:
            draw.text((x, y), c, font=kick_font, fill=_hex_to_rgba(accent))
            x += draw.textlength(c, font=kick_font) + track
        y += kick_h + kgap
        rule_y = y - int(short * 0.035)
    # thin accent rule above the title
    rule_w = int(short * 0.08)
    draw.rounded_rectangle([(w - rule_w) // 2, rule_y, (w + rule_w) // 2, rule_y + max(3, short // 300)],
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


def _render_title_lower(out: Path, w: int, h: int, text: str, subtitle: str, *, font, bg, fg, accent, kicker: str = "") -> Path:
    img = Image.new("RGBA", (w, h), _hex_to_rgba(bg))
    draw = ImageDraw.Draw(img)
    short = min(w, h)
    margin = int(short * 0.09)
    max_w = w - 2 * margin
    title_font, title_lines = _fit_font(draw, text, font, "bold", max_w, int(h * 0.4), int(short * 0.10))
    tl_h = int(title_font.size * 1.15)
    sub_font = sub_lines = None
    sl_h = 0
    if subtitle:
        sub_font, sub_lines = _fit_font(draw, subtitle, font, "medium", max_w, int(h * 0.2), int(short * 0.042))
        sl_h = int(sub_font.size * 1.3)
    gap = int(short * 0.02) if subtitle else 0
    block_h = len(title_lines) * tl_h + gap + (len(sub_lines) * sl_h if sub_lines else 0)
    y = h - margin - int(h * 0.06) - block_h
    rule_w = int(short * 0.07)
    draw.rounded_rectangle([margin, y - int(short * 0.04), margin + rule_w, y - int(short * 0.04) + max(3, short // 300)], radius=3, fill=_hex_to_rgba(accent))
    if kicker:
        kf = load_font(font, int(short * 0.03), "bold")
        draw.text((margin, y - int(short * 0.04) - int(kf.size * 1.6)), kicker.upper(), font=kf, fill=_hex_to_rgba(accent))
    for line in title_lines:
        draw.text((margin, y), line, font=title_font, fill=_hex_to_rgba(fg))
        y += tl_h
    y += gap
    if sub_lines:
        for line in sub_lines:
            draw.text((margin, y), line, font=sub_font, fill=_hex_to_rgba(accent))
            y += sl_h
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


def render_layer(cache_dir: Path, w: int, h: int, image: Path, box: tuple | None, fit: str = "contain") -> Path:
    """Full-frame PNG for a picture over the video. Full screen: opaque (whole picture over a blurred
    copy of itself, or cropped to fill). In a box: transparent frame with the picture placed at
    (x, y) centre and w width (fractions of the frame), rounded corners and a soft shadow."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _key("layer1", w, h, image, image.stat().st_mtime_ns, box and tuple(round(v, 4) for v in box), fit)
    out = cache_dir / f"layer_{key}.png"
    if out.exists():
        return out
    if not box:
        _image_background(w, h, image, fit).save(out)
        return out
    x, y, bw = box
    src = Image.open(image).convert("RGBA")
    pw = max(2, round(bw * w))
    ph = max(2, round(pw * src.height / max(1, src.width)))
    pic = src.resize((pw, ph), Image.LANCZOS)
    short = min(w, h)
    radius = max(2, int(short * 0.02))
    mask = Image.new("L", (pw, ph), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, pw - 1, ph - 1], radius=radius, fill=255)
    left, top = round(x * w - pw / 2), round(y * h - ph / 2)
    frame = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    # soft drop shadow so the picture reads as sitting on top of the video
    blur = max(2, int(short * 0.012))
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([left, top + int(short * 0.006), left + pw, top + ph + int(short * 0.006)],
                                             radius=radius, fill=(0, 0, 0, 110))
    frame.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(blur)))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    pic.putalpha(Image.composite(pic.getchannel("A"), Image.new("L", (pw, ph), 0), mask))
    layer.paste(pic, (left, top), pic)
    frame.alpha_composite(layer)
    frame.save(out)
    return out
