# SPDX-License-Identifier: GPL-3.0-or-later
# Adapted from bee-san/vita-vn-ocr at 205f47ec4e56ca87c00e7dba0a61c9aaec726707.
# Original files: synth/common.py, synth/textspot{,6}_twin.py, synth/textdet_twin.py.
# Pure Python decode only; the neural network runs in ONNX Runtime.
"""VOCR textspot8 decoding, preserving the upstream integer geometry and ordering."""

from dataclasses import dataclass

import numpy as np

BOX_MAX = 64
PAD_PCT, PAD_MIN, MIN_ACROSS = 18, 2, 4
TCONF_MAX, DIALOGUE = 127, 0
X, Y, W, H, V, CONF, DARK, TAG, TCONF = range(9)


def grey_of(img):
    """uint8 grey of an HxW grey or HxWx3/4 RGB(A) image, as the C side computes it."""
    img = np.asarray(img)
    if img.ndim == 2:
        return img.astype(np.uint8, copy=False)
    return to_gray(img)


def _first_cum(cum, k):
    """Smallest value v with cum[v] >= k (the C loops' percentile rule)."""
    return int(np.argmax(cum >= k))


def line_dark(img, box):
    """1 if the text in box (x, y, w, h) of img is darker than its background (C:
    vocr_line_dark). Background = median of the box's border pixels; text pixels
    deviate from it by more than max(16, a quarter of the box's 2..98% grey range).
    Dark only when bright deviations are nearly absent: outlined light text on a
    light box has a dark outline but a bright fill, and stays light."""
    x, y, w, h = box
    g = grey_of(img)[y : y + h, x : x + w].astype(np.int32)
    border = np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])
    bg = int(np.sort(border)[len(border) // 2])
    cum = np.cumsum(np.bincount(g.ravel(), minlength=256)).astype(np.int64)
    n = w * h
    lo = _first_cum(cum, n * 2 // 100)
    hi = _first_cum(cum, n * 98 // 100)
    d = max(16, (hi - lo) // 4)
    nd = int((g < bg - d).sum())
    nb = int((g > bg + d).sum())
    return 1 if nd > 8 * nb else 0


def to_gray(rgb):
    """Integer luma, identical to the C side: (77 R + 150 G + 29 B) >> 8."""
    r, g, b = (rgb[..., i].astype(np.uint16) for i in range(3))
    return ((77 * r + 150 * g + 29 * b) >> 8).astype(np.uint8)


def halve(grey):
    """The 2x2 mean of the module docstring: ceil(H/2) x ceil(W/2) uint8."""
    g = np.asarray(grey, np.int32)
    if g.shape[0] % 2:
        g = np.vstack([g, g[-1:]])
    if g.shape[1] % 2:
        g = np.hstack([g, g[:, -1:]])
    return ((g[0::2, 0::2] + g[0::2, 1::2] + g[1::2, 0::2] + g[1::2, 1::2] + 2) >> 2).astype(np.uint8)


def _joins_geometry(a, b):
    """a, b: (x, y, w, h, vertical, ...) of one orientation."""
    if a[4] != b[4]:
        return False
    if a[4]:
        ov = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
        gap = max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2])
        sa, sb = a[2], b[2]
    else:
        ov = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
        gap = max(a[1], b[1]) - min(a[1] + a[3], b[1] + b[3])
        sa, sb = a[3], b[3]
    return ov > 0 and gap <= max(sa, sb) and 2 * max(sa, sb) <= 3 * min(sa, sb)


def _rows(items, key_sort, lo, size, key_row):
    """Sort items by key_sort, gather them into runs (an item joins the current run when its [lo, lo + size)
    overlaps the run's first item's by at least half the smaller size), each run sorted by key_row."""
    out, run = [], []
    for it in sorted(items, key=key_sort):
        if run:
            f = run[0]
            ov = min(lo(it) + size(it), lo(f) + size(f)) - max(lo(it), lo(f))
            if 2 * ov >= min(size(it), size(f)):
                run.append(it)
                continue
            out += sorted(run, key=key_row)
        run = [it]
    return out + sorted(run, key=key_row)


def _order_block(members):
    """members: [(x, y, w, h, vertical, ...)] of one block -> reading order."""
    if members[0][4]:
        return _rows(
            members,
            key_sort=lambda b: (-(b[0] + b[2]), b[1], b[0], b[2], b[3]),
            lo=lambda b: b[0],
            size=lambda b: b[2],
            key_row=lambda b: (b[1], -(b[0] + b[2]), b[3], b[2]),
        )
    return _rows(
        members,
        key_sort=lambda b: (b[1], b[0], b[3], b[2]),
        lo=lambda b: b[1],
        size=lambda b: b[3],
        key_row=lambda b: (b[0], b[1], b[3], b[2]),
    )


def components(kmask):
    """4-connected components of a boolean map: list of (rows, cols) index arrays, in no particular order."""
    h, w = kmask.shape
    parent = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    runs_prev, label = [], {}
    runs_all = []
    for i in range(h):
        row = kmask[i]
        runs = []
        j = 0
        while j < w:
            if row[j]:
                j0 = j
                while j < w and row[j]:
                    j += 1
                rid = len(runs_all)
                runs_all.append((i, j0, j))
                parent[rid] = rid
                runs.append(rid)
            else:
                j += 1
        for r in runs:
            _, a0, a1 = runs_all[r]
            for q in runs_prev:
                _, b0, b1 = runs_all[q]
                if a0 < b1 and b0 < a1:
                    ra, rb = find(r), find(q)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
        runs_prev = runs
    for r in range(len(runs_all)):
        label.setdefault(find(r), []).append(runs_all[r])
    return list(label.values())


def _tag_of(sums, n):
    """(tag, tconf) of a component of n cells with tag sums S_0..S_{T-1} (the module docstring)."""
    scores = [0] + [int(v) for v in sums]
    best = 0
    for c in range(1, len(scores)):
        if scores[c] > scores[best]:
            best = c
    if len(scores) == 1:
        return 0, 0
    second = max(scores[c] for c in range(len(scores)) if c != best)
    return best, min(TCONF_MAX, (scores[best] - second) // n)


def candidates(model, maps, f, height, width):
    """Every kept candidate before the cap: [(key, (x, y, w, h, vertical, conf, tag, tconf))]; key = the cap's sort
    key. textspot_twin.candidates' boxes, line for line, with the tag of each component."""
    s = model.stride
    tags = maps.shape[0] - 4
    kmap, omap, a1map, a2map = (maps[c] for c in range(4))
    out = []
    for runs in components(kmap > 0):
        n = sum(b - a for _, a, b in runs)
        if n < model.min_cells:
            continue
        rows = np.concatenate([np.full(b - a, i, np.int64) for i, a, b in runs])
        cols = np.concatenate([np.arange(a, b, dtype=np.int64) for _, a, b in runs])
        conf = int(kmap[rows, cols].sum()) // n
        if conf < model.conf_min:
            continue
        vertical = int(omap[rows, cols].sum()) > 0
        a1, a2 = a1map[rows, cols], a2map[rows, cols]
        across_idx, along_idx = (cols, rows) if vertical else (rows, cols)
        c2 = 2 * s * across_idx + s - 1
        near = (f * int((c2 - a1).sum())) // (2 * n)
        far = -((-(f * int((c2 + a2).sum()))) // (2 * n))
        lo, hi = f * s * int(along_idx.min()), f * s * (int(along_idx.max()) + 1)
        across = far - near
        if across < MIN_ACROSS * f:
            continue
        pad = max(PAD_MIN, (across * PAD_PCT + 50) // 100)
        a0, a1_, b0, b1 = near - pad, far + pad, lo - pad, hi + pad
        if vertical:
            x0, x1, y0, y1 = a0, a1_, b0, b1
        else:
            x0, x1, y0, y1 = b0, b1, a0, a1_
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
        if x1 <= x0 or y1 <= y0:
            continue
        tag, tconf = _tag_of([int(maps[4 + t][rows, cols].sum()) for t in range(tags)], n)
        key = (-conf, -n, int(vertical), y0, x0, y1 - y0, x1 - x0, tag)
        out.append((key, (x0, y0, x1 - x0, y1 - y0, int(vertical), conf, tag, tconf)))
    return out


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int
    vertical: int
    conf: int
    dark: int
    block: int
    tag: int
    tconf: int


@dataclass(frozen=True)
class Block:
    x: int
    y: int
    w: int
    h: int
    vertical: int
    first: int
    count: int
    tag: int


@dataclass(frozen=True)
class Result:
    boxes: tuple
    blocks: tuple
    pick: int
    truncated: int
    presence: int


def _joins(a, b):
    """textspot_twin._joins plus one tag."""
    return a[TAG] == b[TAG] and _joins_geometry(a, b)


def group_and_order(boxes, height):
    """boxes: [(x, y, w, h, vertical, conf, dark, tag, tconf)] -> (ordered boxes [(..., block)], blocks
    [(x, y, w, h, vertical, first, count, tag)], pick). With every tag equal it is textspot_twin.group_and_order's
    result for the same boxes (their first seven fields). Deterministic for any input order of distinct boxes."""
    boxes = sorted(tuple(b) for b in boxes)
    n = len(boxes)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i in range(n):
        for j in range(i + 1, n):
            if _joins(boxes[i], boxes[j]):
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[max(ri, rj)] = min(ri, rj)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(boxes[i])
    blocks = []
    for members in groups.values():
        x0 = min(b[X] for b in members)
        y0 = min(b[Y] for b in members)
        x1 = max(b[X] + b[W] for b in members)
        y1 = max(b[Y] + b[H] for b in members)
        blocks.append(((x0, y0, x1 - x0, y1 - y0, members[0][V], members[0][TAG]), _order_block(members)))
    rows, run = [], []
    for bk in sorted(blocks, key=lambda t: (t[0][1], t[0][0], t[0][3], t[0][2], t[0][5])):
        if run:
            f = run[0][0]
            b = bk[0]
            ov = min(b[1] + b[3], f[1] + f[3]) - max(b[1], f[1])
            if 2 * ov >= min(b[3], f[3]):
                run.append(bk)
                continue
            rows.append(run)
        run = [bk]
    if run:
        rows.append(run)
    ordered = []
    for run in rows:
        if all(t[0][4] for t in run):
            ordered += sorted(run, key=lambda t: (-(t[0][0] + t[0][2]), t[0][1], t[0][3], t[0][2], t[0][5]))
        else:
            ordered += sorted(run, key=lambda t: (t[0][0], t[0][1], t[0][3], t[0][2], t[0][5]))
    out_boxes, out_blocks = [], []
    for k, (bb, members) in enumerate(ordered):
        out_blocks.append((*bb[:5], len(out_boxes), len(members), bb[5]))
        out_boxes += [(*m, k) for m in members]
    pick, best = -1, None
    for k, (bb, members) in enumerate(ordered):
        if bb[5] != DIALOGUE:
            continue
        score = sum(m[W] * m[H] for m in members) * (2 if 2 * bb[1] + bb[3] >= height else 1)
        key = (score, bb[1])
        if best is None or key > best:
            pick, best = k, key
    return out_boxes, out_blocks, pick


def spot_maps(model, maps, f, grey):
    """The decode of the maps (4 + T at model.stride, frame scale f), the cap, the dark flags on the frame's grey,
    blocks, order, pick and presence. A Result."""
    g = np.ascontiguousarray(grey)
    H_, W_ = g.shape
    maps = np.asarray(maps)
    cands = candidates(model, maps, f, H_, W_)
    truncated = int(len(cands) > BOX_MAX)
    kept = [c for _, c in sorted(cands)[:BOX_MAX]]
    boxes6 = [
        (bx, by, bw, bh, v, conf, int(line_dark(g, (bx, by, bw, bh))), tag, tconf)
        for bx, by, bw, bh, v, conf, tag, tconf in kept
    ]
    boxes, blocks, pick = group_and_order(boxes6, H_)
    presence = max([b[CONF] for b in boxes if b[TAG] == DIALOGUE], default=0)
    return Result(
        tuple(Box(x, y, w, h, v, c, d, blk, t, tc) for x, y, w, h, v, c, d, t, tc, blk in boxes),
        tuple(Block(*b) for b in blocks),
        pick,
        truncated,
        presence,
    )


LINES_MAX = 16  # lines returned per region
T_MIN = 40  # lowest contrast threshold
GAP = 10  # on-pixels at most this far apart join into one run
LMIN = 16  # shortest run that counts as text
ROW_DIV = 16  # active rows: kept length >= max(LMIN, peak // ROW_DIV)
MIN_H = 8  # shortest band
MERGE = 2  # inactive rows bridged inside a band
GAPC = 2  # column clusters split at gaps over GAPC * band height
PAD = 3  # crop padding: legacy's 4 px around bright ink, less the 1 px dilation
FURI_PCT = 55  # lines under this % of the median height are dropped


def contrast3(g):
    """max - min of each 3x3 window, edges replicated."""
    p = np.pad(g, 1, mode="edge")
    mx = np.maximum(np.maximum(p[:, :-2], p[:, 1:-1]), p[:, 2:])
    mn = np.minimum(np.minimum(p[:, :-2], p[:, 1:-1]), p[:, 2:])
    mx = np.maximum(np.maximum(mx[:-2], mx[1:-1]), mx[2:])
    mn = np.minimum(np.minimum(mn[:-2], mn[1:-1]), mn[2:])
    return mx - mn


def kept_runs(on):
    """Per row, join on-pixels at most GAP apart into runs; True on runs >= LMIN."""
    H, W = on.shape
    idx = np.arange(W, dtype=np.int32)
    prev = np.maximum.accumulate(np.where(on, idx, -(1 << 20)), axis=1)
    nxt = np.minimum.accumulate(np.where(on, idx, 1 << 20)[:, ::-1], axis=1)[:, ::-1]
    filled = on | (nxt - prev <= GAP)
    z = np.zeros((H, 1), bool)
    st = filled & ~np.concatenate([z, filled[:, :-1]], axis=1)
    en = filled & ~np.concatenate([filled[:, 1:], z], axis=1)
    s_idx = np.maximum.accumulate(np.where(st, idx, -1), axis=1)
    e_idx = np.minimum.accumulate(np.where(en, idx, W)[:, ::-1], axis=1)[:, ::-1]
    return filled & (e_idx - s_idx + 1 >= LMIN)


def _widen(oc, x1, x2, d):
    """Grow [x1, x2) over on-columns at most d apart (C: the widening loops)."""
    w = len(oc)
    r = np.flatnonzero(oc[x2:]) + x2
    chain = np.concatenate([[x2 - 1], r])
    stop = np.flatnonzero(np.diff(chain) > d)
    x2 = int(chain[stop[0] if len(stop) else len(r)]) + 1
    lft = np.flatnonzero(oc[:x1])[::-1]
    chain = np.concatenate([[x1], lft])
    stop = np.flatnonzero(-np.diff(chain) > d)
    x1 = int(chain[stop[0] if len(stop) else len(lft)])
    return max(0, x1), min(w, x2)


def _find_grad(img):
    g = grey_of(img)
    H, W = g.shape
    if not H or not W:
        return [], [], False
    c = contrast3(g)
    cum = np.cumsum(np.bincount(c.ravel(), minlength=256)).astype(np.int64)
    n = H * W
    p99 = _first_cum(cum * 100, n * 99)
    T = max(T_MIN, 2 * p99 // 5)
    on = c >= T
    kept = kept_runs(on)
    prof = kept.sum(axis=1)
    th = max(LMIN, int(prof.max()) // ROW_DIV)
    act = prof >= th
    # bands: gaps of up to MERGE rows bridged, except a gap holding an empty row
    # between runs of >= MIN_H active rows (C: the band loop)
    bands, y = [], 0
    while y < H:
        if not act[y]:
            y += 1
            continue
        s = rs = last = y
        y += 1
        while y < H and (act[y] or y - last <= MERGE):
            if act[y]:
                if y - last > 1:
                    k = y
                    while k < H and act[k]:
                        k += 1
                    if not prof[last + 1 : y].all() and last + 1 - rs >= MIN_H and k - y >= MIN_H:
                        bands.append((s, last + 1))
                        s = y
                    rs = y
                last = y
            y += 1
        if last + 1 - s >= MIN_H:
            bands.append((s, last + 1))
    cands = []
    for i, (a, b) in enumerate(bands):
        bh = b - a
        kc = kept[a:b].sum(axis=0)
        cols = np.flatnonzero(kc)
        if not len(cols):
            continue
        br = np.flatnonzero(np.diff(cols) > GAPC * bh)
        starts = np.concatenate([[0], br + 1])
        ends = np.concatenate([br, [len(cols) - 1]])
        mass = [int(kc[cols[s] : cols[e] + 1].sum()) for s, e in zip(starts, ends)]
        k = int(np.argmax(mass))
        x1, x2 = int(cols[starts[k]]), int(cols[ends[k]]) + 1
        oc = on[a:b].sum(axis=0)
        x1, x2 = _widen(oc, x1, x2, max(4, bh))
        up = min(bh // 2, (a - bands[i - 1][1]) // 2) if i else min(bh // 2, a)
        dn = min(bh // 2, (bands[i + 1][0] - b) // 2) if i + 1 < len(bands) else min(bh // 2, H - b)
        rows_on = on[:, x1:x2].sum(axis=1)
        top, bot = a, b
        while a - top < up and rows_on[top - 1] >= 2:
            top -= 1
        while bot - b < dn and rows_on[bot] >= 2:
            bot += 1
        cands.append((x1, top, x2, bot))
    boxes, dark, truncated = [], [], False
    if cands:
        med = sorted(bot - top for _, top, _, bot in cands)[len(cands) // 2]
        for x1, top, x2, bot in cands:
            if 100 * (bot - top) < FURI_PCT * med:
                continue
            if len(boxes) == LINES_MAX:
                truncated = True
                break
            lx, ly = max(0, x1 - PAD), max(0, top - PAD)
            ex, ey = min(W, x2 + PAD), min(H, bot + PAD)
            boxes.append((lx, ly, ex - lx, ey - ly))
            dark.append(line_dark(g, (lx, ly, ex - lx, ey - ly)))
    return boxes, dark, truncated
