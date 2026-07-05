# Predicted mask -> Stride analyzer JSON (the record_plan_analysis schema).
# The output plugs directly into src/lib/planProcess.js: analysisToScenePlan()
# already handles snapping, room flood-fill, scale fallback via door width,
# and access repair — this only needs to produce decent walls/doors/windows.
import numpy as np


def _components(binary):
    """4-connected components without cv2. Returns (labels, count)."""
    h, w = binary.shape
    labels = np.zeros((h, w), dtype=np.int32)
    nxt = 0
    for sy in range(h):
        row = binary[sy]
        for sx in np.nonzero(row & (labels[sy] == 0))[0]:
            nxt += 1
            stack = [(sy, sx)]
            labels[sy, sx] = nxt
            while stack:
                y, x = stack.pop()
                if y > 0 and binary[y - 1, x] and not labels[y - 1, x]:
                    labels[y - 1, x] = nxt; stack.append((y - 1, x))
                if y < h - 1 and binary[y + 1, x] and not labels[y + 1, x]:
                    labels[y + 1, x] = nxt; stack.append((y + 1, x))
                if x > 0 and binary[y, x - 1] and not labels[y, x - 1]:
                    labels[y, x - 1] = nxt; stack.append((y, x - 1))
                if x < w - 1 and binary[y, x + 1] and not labels[y, x + 1]:
                    labels[y, x + 1] = nxt; stack.append((y, x + 1))
    return labels, nxt


def _open_directional(binary, length, horizontal):
    """Morphological opening with a 1xN (or Nx1) kernel via run-length checks:
    keeps only pixels inside runs >= length along the given direction."""
    arr = binary if horizontal else binary.T
    out = np.zeros_like(arr)
    for y in range(arr.shape[0]):
        row = arr[y]
        # run starts/ends
        diff = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
        starts, ends = np.nonzero(diff == 1)[0], np.nonzero(diff == -1)[0]
        for s, e in zip(starts, ends):
            if e - s >= length:
                out[y, s:e] = 1
    return out if horizontal else out.T


def _wall_segments(wall_mask, min_len_px):
    """Split the wall mask into horizontal and vertical center-line segments."""
    walls = []
    for horizontal in (True, False):
        directional = _open_directional(wall_mask, min_len_px, horizontal)
        labels, count = _components(directional)
        for c in range(1, count + 1):
            ys, xs = np.nonzero(labels == c)
            if len(ys) < min_len_px:
                continue
            if horizontal:
                x0, x1 = xs.min(), xs.max()
                thickness = max(1.0, len(ys) / max(1, x1 - x0 + 1))
                cy = float(ys.mean())
                walls.append({
                    "start": {"x": float(x0), "y": cy},
                    "end": {"x": float(x1), "y": cy},
                    "thickness": float(thickness),
                    "isExterior": False,
                })
            else:
                y0, y1 = ys.min(), ys.max()
                thickness = max(1.0, len(xs) / max(1, y1 - y0 + 1))
                cx = float(xs.mean())
                walls.append({
                    "start": {"x": cx, "y": float(y0)},
                    "end": {"x": cx, "y": float(y1)},
                    "thickness": float(thickness),
                    "isExterior": False,
                })
    return walls


def _openings(class_mask, cls, min_px=4):
    labels, count = _components((class_mask == cls).astype(np.uint8))
    out = []
    for c in range(1, count + 1):
        ys, xs = np.nonzero(labels == c)
        if len(ys) < min_px * min_px:
            continue
        w = xs.max() - xs.min() + 1
        h = ys.max() - ys.min() + 1
        out.append({
            "center": {"x": float(xs.mean()), "y": float(ys.mean())},
            "width": float(max(w, h)),
        })
    return out


def mask_to_analysis(class_mask: np.ndarray) -> dict:
    """class_mask: HxW int array (0 bg, 1 wall, 2 door, 3 window)."""
    h, w = class_mask.shape
    # doors/windows are wall for the purposes of wall-line extraction — a door
    # is a hole in a wall, and including it keeps the wall segment continuous
    solid = (class_mask > 0).astype(np.uint8)
    min_len = max(12, int(min(h, w) * 0.03))
    walls = _wall_segments(solid, min_len)

    # exterior = touches the outer hull: walls whose center line is within 8%
    # of the wall-pixel bounding box border
    ys, xs = np.nonzero(solid)
    if len(ys):
        bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
        mx, my = (bx1 - bx0) * 0.08, (by1 - by0) * 0.08
        for wall in walls:
            sx, sy = wall["start"]["x"], wall["start"]["y"]
            ex, ey = wall["end"]["x"], wall["end"]["y"]
            if (abs(sy - by0) < my and abs(ey - by0) < my) or (abs(sy - by1) < my and abs(ey - by1) < my) \
               or (abs(sx - bx0) < mx and abs(ex - bx0) < mx) or (abs(sx - bx1) < mx and abs(ex - bx1) < mx):
                wall["isExterior"] = True

    # speck filter: real doors are wider than ~1.2 wall thicknesses
    thicknesses = sorted(w["thickness"] for w in walls)
    med_thick = thicknesses[len(thicknesses) // 2] if thicknesses else 8
    min_open = max(16, med_thick * 1.2)

    doors = [{**o, "kind": "hinged"} for o in _openings(class_mask, 2) if o["width"] >= min_open]
    windows = [o for o in _openings(class_mask, 3) if o["width"] >= min_open * 0.6]

    return {
        "planType": "floor_residential",
        "planName": "Model-extracted plan",
        "confidence": 0.9,
        "imageSize": {"width": int(w), "height": int(h)},
        "walls": walls,
        "doors": doors,
        "windows": windows,
        # no rooms: planProcess flood-fill synthesizes them from the walls
        "rooms": [],
        # no printed-label scale from segmentation; planProcess falls back to
        # median door width = 0.9m, which is exactly right here
        "scale": {"pixelsPerMeter": 0, "confidence": 0, "source": "door_width"},
    }
