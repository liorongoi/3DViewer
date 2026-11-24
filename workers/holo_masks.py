"""Masks for a capture: people, and vehicles that move, are left out of the build.

    python holo_masks.py --data DATA --model DATA/sparse/0 --detector yolox_s.onnx

DATA is the undistorted capture (DATA/images, DATA/sparse/0). For each picture with a camera pose it
writes DATA/masks/<name>.png: white where the picture is used, black where it is left out. Brush
reads that folder by itself. It prints one JSON line with what it did.

What is left out:
  - people, always: they are almost never still for a whole capture;
  - a vehicle when it moves. The pose step already says which: the features on a parked car were
    seen from several places and became 3D points, while those on a moving car (or one so blurred
    it has few features) did not. A vehicle whose features became points about as often as the
    rest of the picture's is kept.

Detector: YOLOX-S (Apache-2.0, Megvii), COCO classes, run with onnxruntime: on the graphics card
with --gpu when onnxruntime has DirectML or CUDA (onnxruntime-directml, onnxruntime-gpu), else on
the processor.
Nothing in the capture is changed; the masks are written next to it.
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

PERSON = {0}
VEHICLE = {1, 2, 3, 5, 7}  # bicycle, car, motorcycle, bus, truck
SIZE = 640
STRIDES = (8, 16, 32)


def letterbox(img):
    """YOLOX input: the picture scaled to fit 640x640, padded with grey 114, as BGR float CHW."""
    w, h = img.size
    r = min(SIZE / w, SIZE / h)
    small = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.BILINEAR)
    canvas = np.full((SIZE, SIZE, 3), 114, dtype=np.float32)
    a = np.asarray(small, dtype=np.float32)
    canvas[: a.shape[0], : a.shape[1]] = a
    return canvas[:, :, ::-1].transpose(2, 0, 1)[None].copy(), r


def grids():
    g, s = [], []
    for st in STRIDES:
        n = SIZE // st
        yv, xv = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        g.append(np.stack((xv, yv), 2).reshape(-1, 2))
        s.append(np.full((n * n, 1), st))
    return np.concatenate(g).astype(np.float32), np.concatenate(s).astype(np.float32)


GRID, STRIDE = grids()


def nms(boxes, scores, iou=0.45):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        o = inter / (area(boxes[i]) + area(boxes[order[1:]]) - inter + 1e-9)
        order = order[1:][o < iou]
    return keep


def detect(session, img, min_score):
    """Boxes [x1, y1, x2, y2] in picture pixels with their COCO class, for people and vehicles."""
    x, r = letterbox(img)
    out = session.run(None, {session.get_inputs()[0].name: x})[0][0]
    xy = (out[:, :2] + GRID) * STRIDE
    wh = np.exp(np.clip(out[:, 2:4], -10, 10)) * STRIDE
    cls = out[:, 5:].argmax(1)
    score = out[:, 4] * out[np.arange(len(out)), 5 + cls]
    want = (score >= min_score) & np.isin(cls, list(PERSON | VEHICLE))
    if not want.any():
        return []
    xy, wh, cls, score = xy[want], wh[want], cls[want], score[want]
    boxes = np.concatenate([xy - wh / 2, xy + wh / 2], 1) / r
    found = []
    for c in np.unique(cls):
        idx = np.where(cls == c)[0]
        for k in nms(boxes[idx], score[idx]):
            found.append((boxes[idx[k]], int(c)))
    return found


def judge(box, xy, tracked, picture_share, min_points=8):
    """True when a vehicle looks parked: its features became 3D points about as often as the picture's."""
    x1, y1, x2, y2 = box
    inside = (xy[:, 0] >= x1) & (xy[:, 0] <= x2) & (xy[:, 1] >= y1) & (xy[:, 1] <= y2)
    n = int(inside.sum())
    t = int((inside & tracked).sum())
    return t >= min_points and t / max(n, 1) >= 0.5 * picture_share


def open_detector(ort, model, opts, gpu):
    """The detector's session: on the graphics card when asked and onnxruntime has a way there,
    else (or when that fails) on the processor."""
    if gpu:
        have = ort.get_available_providers()
        for provider in ("CUDAExecutionProvider", "DmlExecutionProvider"):
            if provider not in have:
                continue
            o = ort.SessionOptions()
            o.intra_op_num_threads = opts.intra_op_num_threads
            if provider == "DmlExecutionProvider":
                # DirectML needs these two (onnxruntime's DirectML notes).
                o.enable_mem_pattern = False
                o.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            try:
                s = ort.InferenceSession(model, sess_options=o, providers=[provider, "CPUExecutionProvider"])
                if s.get_providers()[0] == provider:
                    return s
            except Exception as e:  # noqa: BLE001 - any failure means: use the processor
                print(f"masks: {provider} could not start ({e}); using the processor", file=sys.stderr)
    return ort.InferenceSession(model, sess_options=opts, providers=["CPUExecutionProvider"])


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--detector", required=True)
    ap.add_argument("--min-score", type=float, default=0.35)
    ap.add_argument("--grow", type=float, default=0.08, help="widen each box by this share on every side")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--gpu", action="store_true", help="run the detector on the graphics card when onnxruntime can")
    a = ap.parse_args(argv)

    import onnxruntime as ort
    import pycolmap

    opts = ort.SessionOptions()
    if a.threads:
        opts.intra_op_num_threads = a.threads
    session = open_detector(ort, a.detector, opts, a.gpu)
    rec = pycolmap.Reconstruction(a.model)
    out_dir = os.path.join(a.data, "masks")
    os.makedirs(out_dir, exist_ok=True)

    stats = {"pictures": 0, "masked": 0, "people": 0, "movingVehicles": 0, "parkedVehicles": 0, "share": 0.0, "device": "cpu"}
    if session.get_providers()[0] != "CPUExecutionProvider":
        stats["device"] = "gpu"
    shares = []
    images = sorted(rec.images.values(), key=lambda im: im.name)
    for i, im in enumerate(images):
        path = os.path.join(a.data, "images", im.name)
        if not os.path.exists(path):
            continue
        img = Image.open(path).convert("RGB")
        w, h = img.size
        pts = im.points2D
        xy = np.array([p.xy for p in pts], dtype=np.float64).reshape(-1, 2)
        tracked = np.array([p.has_point3D() for p in pts], dtype=bool)
        picture_share = tracked.mean() if len(tracked) else 0.0
        mask = np.full((h, w), 255, dtype=np.uint8)
        try:
            found = detect(session, img, a.min_score)
        except Exception as e:  # noqa: BLE001
            if stats["device"] != "gpu":
                raise
            # The card gave up part way: the rest on the processor.
            print(f"masks: the graphics card stopped ({e}); going on with the processor", file=sys.stderr)
            session = ort.InferenceSession(a.detector, sess_options=opts, providers=["CPUExecutionProvider"])
            stats["device"] = "cpu"
            found = detect(session, img, a.min_score)
        for box, c in found:
            if c in VEHICLE:
                if len(xy) and judge(box, xy, tracked, picture_share):
                    stats["parkedVehicles"] += 1
                    continue
                stats["movingVehicles"] += 1
            else:
                stats["people"] += 1
            gx, gy = (box[2] - box[0]) * a.grow, (box[3] - box[1]) * a.grow
            x1, y1 = max(0, int(box[0] - gx)), max(0, int(box[1] - gy))
            x2, y2 = min(w, int(np.ceil(box[2] + gx))), min(h, int(np.ceil(box[3] + gy)))
            if x2 > x1 and y2 > y1:
                mask[y1:y2, x1:x2] = 0
        share = 1 - mask.mean() / 255
        shares.append(share)
        stats["pictures"] += 1
        if share > 0:
            stats["masked"] += 1
        Image.fromarray(mask, "L").save(os.path.join(out_dir, os.path.splitext(im.name)[0] + ".png"))
        print(f"progress {i + 1}/{len(images)}", file=sys.stderr, flush=True)
    stats["share"] = round(float(np.mean(shares)) if shares else 0.0, 4)
    if not stats["masked"]:
        # Nothing to leave out: no masks, so the build is exactly as it would be without this step.
        import shutil

        shutil.rmtree(out_dir, ignore_errors=True)
    print(json.dumps(stats), flush=True)


if __name__ == "__main__":
    main()
