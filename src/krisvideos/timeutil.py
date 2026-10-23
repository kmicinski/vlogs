"""Parsing and formatting of timecodes used in project files and the CLI."""
from __future__ import annotations

import re


def parse_time(value) -> float:
    """Accept 83, 83.5, "83", "1:23", "1:23.5", "0:01:23", "1m23s"."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return 0.0
    m = re.fullmatch(r"(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?", s)
    if m and (m.group(1) or m.group(2)):
        return int(m.group(1) or 0) * 60 + float(m.group(2) or 0)
    parts = s.split(":")
    try:
        parts_f = [float(p) for p in parts]
    except ValueError as e:
        raise ValueError(f"bad time {value!r}") from e
    total = 0.0
    for p in parts_f:
        total = total * 60 + p
    return total


def fmt_time(seconds: float, decimals: int = 1) -> str:
    seconds = max(0.0, float(seconds))
    m = int(seconds // 60)
    s = seconds - m * 60
    if decimals:
        return f"{m}:{s:0{3+decimals}.{decimals}f}"
    return f"{m}:{int(round(s)):02d}"
