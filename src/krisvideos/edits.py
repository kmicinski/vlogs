"""Timeline edits in output-timeline time: what the user sees on the timeline and under the playhead.

Every function mutates the Project in place; callers save (CLI) or commit (server, for undo).
Times are output-timeline seconds unless a name says `src_` (source-clip seconds).
"""
from __future__ import annotations

from copy import deepcopy

from . import render
from .project import Project, Segment

MIN_PIECE = 0.1     # leftovers shorter than this (seconds) are dropped instead of kept as slivers
MIN_TITLE = 0.3     # a title card shortened below this is removed


def _fresh_ids(p: Project) -> None:
    for s in p.timeline:
        if not s.id:
            s.id = p.next_id()


def _overlays_before(seg: Segment, off: float) -> list:
    """Overlays that start before `off` (the part of the clip that is kept up to `off`)."""
    return [o for o in seg.overlays if o.at < off]


def _overlays_after(seg: Segment, off: float) -> list:
    """Copies of the overlays that start at/after `off`, re-based so `off` becomes 0."""
    out = []
    for o in seg.overlays:
        if o.at >= off:
            o2 = deepcopy(o)
            o2.at = round(o.at - off, 3)
            out.append(o2)
    return out


def _drop_head(seg: Segment, off: float) -> None:
    """The first `off` output-seconds of a clip were removed: move its overlays so they stay on
    the same frames (and drop the ones that only covered the removed part)."""
    kept = []
    for o in seg.overlays:
        end = None if o.duration is None else o.at + o.duration
        if end is not None and end <= off + 0.05:
            continue
        o.at = round(max(0.0, o.at - off), 3)
        if end is not None:
            o.duration = round(end - off - o.at, 3)
        kept.append(o)
    seg.overlays = kept


def set_in(seg: Segment, new_in: float) -> None:
    """Move a clip's in point, keeping its text overlays on the same frames."""
    new_in = max(0.0, float(new_in))
    delta = (new_in - seg.in_) / (seg.speed or 1.0)      # output seconds removed (+) or added (-) at the head
    if delta > 1e-6:
        _drop_head(seg, delta)
    elif delta < -1e-6:
        for o in seg.overlays:
            o.at = round(o.at - delta, 3)
    seg.in_ = new_in


def _remap_voiceovers(p: Project, spans: list[tuple[float, float]]) -> None:
    """Keep narration and pictures-over-the-video on their pictures after the (old-timeline,
    non-overlapping) `spans` were removed. One that started inside a removed span lands where the
    span was."""
    for v in [*p.voiceovers, *p.images]:
        shift = 0.0
        for a, b in spans:
            if v.at >= b:
                shift += b - a
            elif v.at > a:
                shift += v.at - a
        v.at = round(max(0.0, v.at - shift), 3)


def follow_content(before: Project, p: Project) -> None:
    """After any edit to the clips (trim, delete, move, split, insert, speed), move the items placed
    in timeline time (pictures over the video, voiceovers) so they stay on the frames they were
    over. Items whose own time the edit changed are left alone."""
    if not (p.images or p.voiceovers) or not before.timeline:
        return
    try:
        old, new = render.compute_layout(before), render.compute_layout(p)
    except Exception:
        return
    if not old.placed:
        return
    old_ids = {pl.seg.id for pl in old.placed}
    new_by_id = {pl.seg.id: pl for pl in new.placed}

    def where(t: float) -> float:
        pl, off = render.locate(old, t)
        if pl is None:
            return t
        npl = new_by_id.get(pl.seg.id)
        if pl.seg.kind == "clip":
            src_t = pl.src_in + off * (pl.seg.speed or 1.0)
            # the same piece of the same clip, or a piece split off it, that still shows src_t
            for q in ([npl] if npl else []) + [q for q in new.placed if q.seg.id not in old_ids]:
                if q.seg.kind == "clip" and q.seg.src == pl.seg.src and q.src_in - 1e-3 <= src_t <= q.src_out + 1e-3:
                    return q.start + (src_t - q.src_in) / (q.seg.speed or 1.0)
            if npl is not None:                  # that moment was trimmed away: nearest edge of what is left
                return npl.start if src_t < npl.src_in else max(npl.start, npl.end - 0.05)
        elif npl is not None:
            return npl.start + min(off, npl.duration)
        for later in old.placed[pl.index + 1:]:  # the segment is gone: where whatever followed it now starts
            q = new_by_id.get(later.seg.id)
            if q is not None:
                return q.start
        return new.total

    before_at = {("i", m.id): m.at for m in before.images} | {("v", v.id): v.at for v in before.voiceovers}
    for kind, items in (("i", p.images), ("v", p.voiceovers)):
        for m in items:
            t0 = before_at.get((kind, m.id))
            if t0 is not None and abs(t0 - m.at) < 1e-6:
                m.at = round(max(0.0, where(m.at)), 3)


def split_segment(p: Project, pl: render.Placed, off: float) -> Segment:
    """Split the clip `pl` at `off` output-seconds into it. The first half keeps the id (and the
    caption); returns the new second half, which follows with a plain cut."""
    seg = pl.seg
    cut = pl.src_in + off * (seg.speed or 1.0)
    tail = deepcopy(seg)
    tail.id = ""
    tail.in_, tail.out = cut, pl.src_out
    tail.caption = None
    tail.transition = tail.transition_duration = None
    tail.overlays = _overlays_after(seg, off)
    seg.out = cut
    seg.overlays = _overlays_before(seg, off)
    p.timeline.insert(pl.index + 1, tail)
    _fresh_ids(p)
    return tail


def insert_index_at(p: Project, t: float) -> int:
    """Timeline index where something inserted at output time `t` goes. If `t` is inside a clip,
    the clip is split there first. Near an edge (or on a title card) it goes before/after."""
    layout = render.compute_layout(p)
    pl, off = render.locate(layout, t)
    if pl is None or t >= layout.total - 1e-6:
        return len(p.timeline)
    if pl.seg.kind == "title":
        return pl.index if off < pl.duration / 2 else pl.index + 1
    if off < 0.25:
        return pl.index
    if pl.duration - off < 0.25:
        return pl.index + 1
    split_segment(p, pl, off)
    return pl.index + 1


def title_at(p: Project, t: float, text: str, subtitle: str = "", duration: float = 3.0) -> Segment:
    """Split the timeline at output time `t` (if that is inside a clip) and insert a title card."""
    return p.add_title(text, subtitle, duration, at=insert_index_at(p, t))


def cut_range(p: Project, a: float, b: float) -> float:
    """Ripple delete: remove output-timeline [a, b) and close the gap. Clips are trimmed (or split
    when the range is inside one), title cards shortened or removed, narration after the cut moves
    up with its pictures. Returns the seconds removed (0 when there was nothing to remove)."""
    a, b = sorted((max(0.0, float(a)), max(0.0, float(b))))
    layout = render.compute_layout(p)
    if b - a < 0.02 or not layout.placed or a >= layout.total:
        return 0.0
    b = min(b, layout.total)
    new: list[Segment] = []
    for pl in layout.placed:
        s = pl.seg
        lo, hi = max(a, pl.start), min(b, pl.end)
        if hi - lo <= 1e-6:                       # not touched
            new.append(s)
            continue
        off_a, off_b = lo - pl.start, hi - pl.start
        head = off_a if off_a >= MIN_PIECE else 0.0                     # kept before the cut
        tail = pl.duration - off_b if pl.duration - off_b >= MIN_PIECE else 0.0   # kept after it
        if s.kind == "title":
            if head + tail >= MIN_TITLE:
                s.duration = round(head + tail, 3)
                new.append(s)
            continue
        spd = s.speed or 1.0
        if head and tail:                         # cut out of the middle: two pieces, jump cut
            second = deepcopy(s)
            second.id = ""
            second.in_, second.out = pl.src_in + off_b * spd, pl.src_out
            second.caption = None
            second.transition = second.transition_duration = None
            second.overlays = _overlays_after(s, off_b)
            s.out = pl.src_in + off_a * spd
            s.overlays = _overlays_before(s, off_a)
            new += [s, second]
        elif head:                                # cut the end off
            s.out = pl.src_in + off_a * spd
            s.overlays = _overlays_before(s, off_a)
            new.append(s)
        elif tail:                                # cut the start off
            s.in_ = pl.src_in + off_b * spd
            _drop_head(s, off_b)
            new.append(s)
        # neither: the whole segment was inside the range
    p.timeline = new
    _fresh_ids(p)
    removed = max(0.0, layout.total - render.compute_layout(p).total)
    _remap_voiceovers(p, [(a, a + removed)] if abs(removed - (b - a)) > 0.01 else [(a, b)])
    return removed


def keep_range(p: Project, a: float, b: float) -> tuple[float, float]:
    """Trim the clip(s) under [a, b) so only that part of them remains: the clip at `a` loses what
    comes before `a`, the clip at `b` loses what comes after `b`. Title cards and segments outside
    the range are left alone. Returns (seconds removed, new timeline time of the kept part's start)."""
    a, b = sorted((max(0.0, float(a)), max(0.0, float(b))))
    layout = render.compute_layout(p)
    if b - a < 0.05 or not layout.placed or a >= layout.total:
        return 0.0, a
    b = min(b, layout.total)
    pa, off_a = render.locate(layout, a)
    pb, _ = render.locate(layout, max(a, b - 1e-3))
    spans: list[tuple[float, float]] = []
    if pb is not None and pb.seg.kind == "clip":            # the end first: it doesn't move the start
        ob = b - pb.start
        if pb.duration - ob >= 0.02:
            pb.seg.out = pb.src_in + ob * (pb.seg.speed or 1.0)
            pb.seg.overlays = _overlays_before(pb.seg, ob)
            spans.append((b, pb.end))
    head = 0.0
    if pa is not None and pa.seg.kind == "clip" and off_a >= 0.02:
        pa.seg.in_ = pa.src_in + off_a * (pa.seg.speed or 1.0)
        _drop_head(pa.seg, off_a)
        spans.insert(0, (pa.start, a))
        head = off_a
    if not spans:
        return 0.0, a
    _remap_voiceovers(p, spans)
    return sum(y - x for x, y in spans), a - head
