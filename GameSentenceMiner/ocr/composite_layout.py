"""Centralized coordinate mapping for OCR composite images.

When GSM crops a frame down to just the configured OCR rectangles it pastes each
crop onto a transparent canvas. By default each crop keeps its absolute position
(only the bounding-box origin is subtracted), which leaves large transparent gaps
- e.g. a black-hole box at the top of a menu with dialogue at the bottom. Some OCR
engines degrade badly when there is a lot of empty area to run text detection on.

``pack_rectangles`` compresses that empty space while preserving the *relative*
layout of the boxes, and ``CompositeLayout`` records enough information to map any
coordinate detected on the packed composite back to the original capture frame.

The layout is deliberately decoupled from the OCR runtime so other workflows
(overlay, ad-hoc OCR, ...) can reuse the same packing + back-mapping primitives.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

# Default transparent padding (px) kept between packed boxes so engines still see
# clear separation between unrelated text regions.
DEFAULT_PACK_GAP = 12


def _safe_int(value, default=0):
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class LayoutRegion:
    """A single packed crop: where it sits in the composite vs. its source origin."""

    dest_x: int  # top-left of the crop inside the packed composite
    dest_y: int
    width: int
    height: int
    src_x: int  # top-left of the same crop inside the original capture frame
    src_y: int

    @property
    def dx(self) -> int:
        # Add to a composite x to recover the source x.
        return self.src_x - self.dest_x

    @property
    def dy(self) -> int:
        return self.src_y - self.dest_y

    @property
    def area(self) -> int:
        return max(0, self.width) * max(0, self.height)

    def contains(self, x: float, y: float) -> bool:
        return (self.dest_x <= x <= self.dest_x + self.width) and (self.dest_y <= y <= self.dest_y + self.height)

    def to_dict(self) -> dict:
        return {
            "dest": [self.dest_x, self.dest_y, self.width, self.height],
            "src": [self.src_x, self.src_y],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LayoutRegion":
        dest = list(data.get("dest") or [0, 0, 0, 0])
        src = list(data.get("src") or [0, 0])
        dest += [0] * (4 - len(dest))
        src += [0] * (2 - len(src))
        return cls(
            dest_x=_safe_int(dest[0]),
            dest_y=_safe_int(dest[1]),
            width=_safe_int(dest[2]),
            height=_safe_int(dest[3]),
            src_x=_safe_int(src[0]),
            src_y=_safe_int(src[1]),
        )


class CompositeLayout:
    """Maps composite-image coordinates back to the original capture frame.

    Behaves like the legacy ``(offset_x, offset_y)`` tuple for the uniform-crop
    case, so existing ``crop_offset[0]`` / ``offset_x, offset_y = crop_offset``
    call sites keep working unchanged. When the composite was packed, per-region
    offsets are applied via :meth:`map_box` instead of a single global offset.
    """

    __slots__ = ("offset_x", "offset_y", "regions")

    def __init__(
        self,
        offset: Sequence[int] = (0, 0),
        regions: Optional[Sequence[LayoutRegion]] = None,
    ):
        self.offset_x = _safe_int(offset[0]) if offset else 0
        self.offset_y = _safe_int(offset[1]) if offset and len(offset) > 1 else 0
        self.regions: List[LayoutRegion] = list(regions or [])

    # -- tuple compatibility -------------------------------------------------
    def __iter__(self):
        yield self.offset_x
        yield self.offset_y

    def __getitem__(self, index):
        return (self.offset_x, self.offset_y)[index]

    def __len__(self):
        return 2

    def __eq__(self, other):
        if isinstance(other, CompositeLayout):
            return (self.offset_x, self.offset_y, self.regions) == (
                other.offset_x,
                other.offset_y,
                other.regions,
            )
        if isinstance(other, (tuple, list)) and len(other) == 2 and not self.regions:
            return (self.offset_x, self.offset_y) == (_safe_int(other[0]), _safe_int(other[1]))
        return NotImplemented

    def __repr__(self):
        if self.regions:
            return f"CompositeLayout(offset=({self.offset_x}, {self.offset_y}), regions={len(self.regions)})"
        return f"CompositeLayout(offset=({self.offset_x}, {self.offset_y}))"

    @property
    def is_packed(self) -> bool:
        return bool(self.regions)

    # -- mapping -------------------------------------------------------------
    def _region_for_point(self, x: float, y: float) -> Optional[LayoutRegion]:
        # Prefer the smallest containing region so nested crops map correctly.
        best = None
        for region in self.regions:
            if region.contains(x, y) and (best is None or region.area < best.area):
                best = region
        return best

    def map_point(self, x: float, y: float) -> Tuple[float, float]:
        if self.regions:
            region = self._region_for_point(x, y)
            if region is not None:
                return x + region.dx, y + region.dy
        return x + self.offset_x, y + self.offset_y

    def offset_for_point(self, x: float, y: float) -> Tuple[int, int]:
        """Translation (dx, dy) to add to composite coords near (x, y) to reach source space.

        Useful for shifting a whole polygon/quad by one translation (picked from its
        center) so its shape is preserved exactly.
        """
        if self.regions:
            region = self._region_for_point(x, y)
            if region is not None:
                return region.dx, region.dy
        return self.offset_x, self.offset_y

    def map_box(self, box: Sequence[float]) -> Optional[Tuple[float, float, float, float]]:
        if not isinstance(box, (list, tuple)) or len(box) < 4:
            return None
        x1, y1, x2, y2 = box[0], box[1], box[2], box[3]
        if self.regions:
            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            region = self._region_for_point(cx, cy) or self._region_for_point(x1, y1)
            if region is not None:
                return x1 + region.dx, y1 + region.dy, x2 + region.dx, y2 + region.dy
        return x1 + self.offset_x, y1 + self.offset_y, x2 + self.offset_x, y2 + self.offset_y

    def translate_dest(self, dx: int, dy: int) -> "CompositeLayout":
        """Return a copy with all composite/dest coordinates shifted by (dx, dy).

        Used when a later OCR pass runs on a sub-crop of this composite: if that
        crop's origin (in composite space) is (ox, oy), call ``translate_dest(-ox, -oy)``
        to get a layout that maps the sub-crop's coordinates straight back to the
        source frame. Source origins are unchanged, so back-mapping stays correct.
        """
        dx = _safe_int(dx)
        dy = _safe_int(dy)
        if not self.regions and dx == 0 and dy == 0:
            return CompositeLayout((self.offset_x, self.offset_y))
        regions = [
            LayoutRegion(
                dest_x=region.dest_x + dx,
                dest_y=region.dest_y + dy,
                width=region.width,
                height=region.height,
                src_x=region.src_x,
                src_y=region.src_y,
            )
            for region in self.regions
        ]
        return CompositeLayout((self.offset_x - dx, self.offset_y - dy), regions)

    # -- serialization (survives metadata / IPC round-trips) -----------------
    def to_metadata(self) -> dict:
        data = {"x": self.offset_x, "y": self.offset_y}
        if self.regions:
            data["regions"] = [region.to_dict() for region in self.regions]
        return data

    @classmethod
    def from_metadata(cls, data) -> "CompositeLayout":
        if isinstance(data, CompositeLayout):
            return data
        if isinstance(data, (tuple, list)) and len(data) >= 2:
            return cls((data[0], data[1]))
        if not isinstance(data, dict):
            return cls((0, 0))
        regions = [LayoutRegion.from_dict(r) for r in (data.get("regions") or []) if isinstance(r, dict)]
        return cls((data.get("x", 0), data.get("y", 0)), regions)


# Two boxes share a row when their vertical spans overlap by at least this
# fraction of the smaller box height. Keeps natural reading rows together.
ROW_VERTICAL_OVERLAP_RATIO = 0.4


def pack_rectangles(
    boxes: Sequence[Sequence[int]],
    gap: int = DEFAULT_PACK_GAP,
) -> Tuple[List[LayoutRegion], int, int]:
    """Compactly pack crops in 2D while preserving reading order.

    ``boxes`` is a list of ``(left, top, right, bottom)`` in source-frame pixels.

    Boxes are grouped into rows (by vertical overlap, top-to-bottom), each row is
    packed left-to-right with ``gap`` px between boxes, and rows are stacked
    top-to-bottom with ``gap`` px between them. Unlike per-axis gap removal, this
    also reclaims 2D corner dead space - e.g. boxes scattered diagonally collapse
    instead of staying spread across a near-full-frame canvas.

    Returns ``(regions, packed_width, packed_height)`` with box order preserved
    (``regions[i]`` corresponds to ``boxes[i]``).
    """
    if not boxes:
        return [], 0, 0

    gap = max(0, int(gap))
    indexed = [(i, (int(b[0]), int(b[1]), int(b[2]), int(b[3]))) for i, b in enumerate(boxes)]
    # Reading order: top-to-bottom, then left-to-right.
    order = sorted(indexed, key=lambda item: (item[1][1], item[1][0]))

    rows: List[dict] = []
    for item in order:
        _, (_left, top, _right, bottom) = item
        current = rows[-1] if rows else None
        if current is not None:
            overlap = min(bottom, current["bottom"]) - max(top, current["top"])
            min_height = min(bottom - top, current["bottom"] - current["top"])
            joins_row = min_height > 0 and overlap >= min_height * ROW_VERTICAL_OVERLAP_RATIO
        else:
            joins_row = False

        if joins_row:
            current["items"].append(item)
            current["top"] = min(current["top"], top)
            current["bottom"] = max(current["bottom"], bottom)
        else:
            rows.append({"top": top, "bottom": bottom, "items": [item]})

    regions: List[Optional[LayoutRegion]] = [None] * len(boxes)
    y_cursor = 0
    packed_width = 0
    for row in rows:
        row_items = sorted(row["items"], key=lambda item: item[1][0])
        x_cursor = 0
        row_height = 0
        for idx, (left, top, right, bottom) in row_items:
            width = right - left
            height = bottom - top
            regions[idx] = LayoutRegion(
                dest_x=x_cursor,
                dest_y=y_cursor,
                width=width,
                height=height,
                src_x=left,
                src_y=top,
            )
            x_cursor += width + gap
            row_height = max(row_height, height)
        packed_width = max(packed_width, max(0, x_cursor - gap))
        y_cursor += row_height + gap

    packed_height = max(0, y_cursor - gap)
    return [region for region in regions if region is not None], packed_width, packed_height
