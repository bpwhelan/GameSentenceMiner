from __future__ import annotations

from types import SimpleNamespace

from PIL import Image

from GameSentenceMiner.ocr.composite_layout import (
    CompositeLayout,
    LayoutRegion,
    pack_rectangles,
)
from GameSentenceMiner.owocr.owocr import ocr_runtime as run_module


def test_pack_rectangles_stacks_separated_boxes_into_rows():
    # Top "black hole" box and a far-away bottom dialogue box, like a menu layout.
    boxes = [(10, 5, 30, 15), (10, 150, 50, 170)]
    regions, width, height = pack_rectangles(boxes, gap=12)

    assert len(regions) == 2
    top, bottom = regions

    # No vertical overlap -> two rows. First box anchored to the origin.
    assert (top.dest_x, top.dest_y) == (0, 0)
    # The 135px vertical dead space is collapsed to the 12px row gap.
    assert bottom.dest_y == top.height + 12
    assert (bottom.dest_x) == 0
    # Boxes keep their source origins for back-mapping.
    assert (top.src_x, top.src_y) == (10, 5)
    assert (bottom.src_x, bottom.src_y) == (10, 150)
    # Composite is just big enough for the packed content.
    assert height == top.height + 12 + bottom.height
    assert width == 40


def test_pack_rectangles_reclaims_2d_corner_dead_space():
    # Diagonally scattered boxes whose x-spans tile the full width and whose
    # y-spans tile the full height: per-axis compression can't help, but shelf
    # packing collapses them. This is the real-world failure case.
    boxes = [
        (0, 0, 400, 100),
        (400, 150, 800, 250),
        (800, 300, 1200, 400),
    ]
    regions, width, height = pack_rectangles(boxes, gap=12)

    # Bounding box is 1200x400; packed width drops to a single column width.
    assert width == 400
    assert height == 100 + 12 + 100 + 12 + 100
    # Each box keeps its source origin and lands in its own row at x=0.
    for region in regions:
        assert region.dest_x == 0
    assert [(r.src_x, r.src_y) for r in regions] == [(0, 0), (400, 150), (800, 300)]


def test_pack_rectangles_packs_same_row_left_to_right():
    # Two vertically-overlapping boxes spread horizontally share one row.
    boxes = [(0, 0, 100, 100), (900, 10, 1000, 90)]
    regions, width, height = pack_rectangles(boxes, gap=12)

    left_box, right_box = regions
    assert left_box.dest_x == 0 and left_box.dest_y == 0
    # Second box packs immediately after the first plus the gap, same row.
    assert right_box.dest_x == 100 + 12
    assert right_box.dest_y == 0
    assert width == 100 + 12 + 100
    assert height == 100


def test_pack_rectangles_round_trips_to_source_space():
    boxes = [(10, 5, 30, 15), (10, 150, 50, 170)]
    regions, _, _ = pack_rectangles(boxes, gap=12)
    layout = CompositeLayout((10, 5), regions)

    # A detection landing in the packed bottom region maps back near the source box.
    bottom = regions[1]
    composite_box = (bottom.dest_x + 2, bottom.dest_y + 2, bottom.dest_x + 18, bottom.dest_y + 12)
    mapped = layout.map_box(composite_box)
    assert mapped == (12, 152, 28, 162)
    # And it falls inside the original bottom rectangle bounds.
    assert 10 <= mapped[0] and mapped[2] <= 50
    assert 150 <= mapped[1] and mapped[3] <= 170


def test_translate_dest_remaps_ocr2_subcrop_back_to_source():
    # Packed first pass: black-hole top region + dialogue bottom region.
    regions = [
        LayoutRegion(dest_x=0, dest_y=0, width=20, height=10, src_x=10, src_y=5),
        LayoutRegion(dest_x=0, dest_y=22, width=40, height=20, src_x=10, src_y=150),
    ]
    first_layout = CompositeLayout((10, 5), regions)

    # OCR2 cropped just the dialogue region out of the packed composite at (0, 22).
    ocr2_layout = first_layout.translate_dest(0, -22)

    # A detection in OCR2-crop space maps straight back into the source dialogue box.
    mapped = ocr2_layout.map_box((2, 2, 18, 12))
    assert mapped == (12, 152, 28, 162)
    assert 10 <= mapped[0] and mapped[2] <= 50
    assert 150 <= mapped[1] and mapped[3] <= 170


def test_translate_dest_matches_uniform_offset_when_unpacked():
    # Without regions, translate_dest reproduces the legacy additive crop offset.
    layout = CompositeLayout((100, 50))
    shifted = layout.translate_dest(-30, -20)
    assert not shifted.is_packed
    assert shifted == (130, 70)


def test_composite_layout_behaves_like_offset_tuple_when_unpacked():
    layout = CompositeLayout((640, 360))
    assert layout == (640, 360)
    assert layout[0] == 640
    assert layout[1] == 360
    ox, oy = layout
    assert (ox, oy) == (640, 360)
    assert not layout.is_packed
    # Uniform mapping just adds the offset.
    assert layout.map_box((1, 2, 3, 4)) == (641, 362, 643, 364)


def test_composite_layout_metadata_round_trip_preserves_regions():
    regions = [LayoutRegion(0, 0, 20, 10, 10, 5), LayoutRegion(0, 22, 40, 20, 10, 150)]
    layout = CompositeLayout((10, 5), regions)

    restored = CompositeLayout.from_metadata(layout.to_metadata())
    assert restored.is_packed
    assert restored.regions == regions
    assert restored.offset_x == 10 and restored.offset_y == 5


def test_from_metadata_accepts_plain_offset_dict_and_tuple():
    assert CompositeLayout.from_metadata({"x": 5, "y": 7}) == (5, 7)
    assert CompositeLayout.from_metadata((5, 7)) == (5, 7)
    assert not CompositeLayout.from_metadata({"x": 5, "y": 7}).is_packed


def _two_box_config():
    return SimpleNamespace(
        rectangles=[
            SimpleNamespace(coordinates=[10, 5, 20, 10], is_excluded=False, is_secondary=False, is_black_hole=False),
            SimpleNamespace(coordinates=[10, 150, 40, 20], is_excluded=False, is_secondary=False, is_black_hole=True),
        ]
    )


def test_apply_ocr_config_compact_shrinks_composite_and_back_maps():
    img = Image.new("L", (100, 200), color=255)

    full, full_offset = run_module.apply_ocr_config_to_image(
        img.copy(), _two_box_config(), return_full_size=False, compact=False
    )
    packed, packed_layout = run_module.apply_ocr_config_to_image(
        img.copy(), _two_box_config(), return_full_size=False, compact=True, pack_gap=12
    )

    # Without packing the composite spans the full bounding box (165px tall).
    assert full.size == (40, 165)
    assert full_offset == (10, 5)
    # Packed composite removes the dead vertical space.
    assert packed.size[1] < full.size[1]
    assert packed_layout.is_packed

    # A box detected inside the packed bottom (black hole) region must map back
    # into the original black-hole rectangle so black-hole filtering still fires.
    bottom = packed_layout.regions[1]
    coord_entry = (bottom.dest_x, bottom.dest_y, bottom.dest_x + bottom.width, bottom.dest_y + bottom.height)
    mapped = run_module._coord_entry_to_original_box(coord_entry, packed_layout, crop_padding=0)
    assert mapped == (10, 150, 50, 170)


def test_apply_ocr_config_default_off_returns_uniform_layout():
    img = Image.new("L", (100, 200), color=255)
    _processed, offset = run_module.apply_ocr_config_to_image(
        img, _two_box_config(), return_full_size=False, compact=False
    )
    assert not offset.is_packed
    assert offset == (10, 5)
