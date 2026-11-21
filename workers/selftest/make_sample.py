#!/usr/bin/env python3
"""A small made-up scene for the training self-test (holo test-training): no real photos.

Writes <out>/images/*.png and <out>/sparse/0 (COLMAP binary, as pycolmap writes it): a coloured
checkered box on a ground plane, seen by 24 cameras on a ring. Each picture is drawn by projecting
the scene's points with a z-buffer, so the poses and the pictures agree exactly. Takes a few
seconds and needs numpy, pycolmap and Pillow.
"""
import argparse
import os
import sys

import numpy as np
import pycolmap

W, H, F = 320, 240, 280.0


def scene(rng):
    pts, cols = [], []
    # Ground: a 4 x 4 m checkerboard at z = 0.
    g = rng.uniform(-2, 2, size=(60000, 2))
    pts.append(np.c_[g, np.zeros(len(g))])
    chk = ((np.floor(g[:, 0] * 2) + np.floor(g[:, 1] * 2)) % 2)[:, None]
    cols.append(chk * [220, 210, 190] + (1 - chk) * [60, 70, 90])
    # A box, 1 m wide and 0.8 m high, each face its own colour with stripes.
    face_cols = np.array([[200, 60, 50], [60, 160, 70], [50, 90, 200], [210, 180, 40], [150, 60, 170]])
    for f in range(5):
        u = rng.uniform(-0.5, 0.5, size=(15000, 2))
        if f == 4:
            p = np.c_[u, np.full(len(u), 0.8)]
        else:
            ax = f % 2
            sgn = 1 if f < 2 else -1
            p = np.zeros((len(u), 3))
            p[:, ax] = sgn * 0.5
            p[:, 1 - ax] = u[:, 0]
            p[:, 2] = (u[:, 1] + 0.5) * 0.8
        stripe = (np.floor((u[:, 0] + u[:, 1]) * 8) % 2)[:, None]
        pts.append(p)
        cols.append(face_cols[f] * (0.6 + 0.4 * stripe))
    return np.vstack(pts), np.clip(np.vstack(cols), 0, 255).astype(np.uint8)


def look_at(c, target):
    z = target - c
    z /= np.linalg.norm(z)
    x = np.cross(z, [0, 0, 1.0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z])  # camera from world
    return R, -R @ c


def draw(R, t, pts, cols):
    pc = pts @ R.T + t
    ok = pc[:, 2] > 0.1
    pc, c = pc[ok], cols[ok]
    u = (F * pc[:, 0] / pc[:, 2] + W / 2).astype(int)
    v = (F * pc[:, 1] / pc[:, 2] + H / 2).astype(int)
    img = np.full((H, W, 3), [150, 180, 215], np.uint8)  # sky
    zbuf = np.full((H, W), np.inf)
    order = np.argsort(-pc[:, 2])  # far first, near overwrite
    for du in (0, 1):
        for dv in (0, 1):
            uu, vv = u[order] + du, v[order] + dv
            m = (uu >= 0) & (uu < W) & (vv >= 0) & (vv < H)
            img[vv[m], uu[m]] = c[order][m]
            zbuf[vv[m], uu[m]] = np.minimum(zbuf[vv[m], uu[m]], pc[order][m, 2])
    return img


def save(img, path):
    # JPEG, as video frames are: Brush 0.3 cannot read some PNG files ("early eof").
    from PIL import Image

    Image.fromarray(img).save(path, quality=95)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    a = ap.parse_args()
    rng = np.random.default_rng(7)
    pts, cols = scene(rng)
    os.makedirs(os.path.join(a.out, "images"), exist_ok=True)
    rec = pycolmap.Reconstruction()
    cam = pycolmap.Camera.create(1, pycolmap.CameraModelId.PINHOLE, F, W, H)
    rec.add_camera(cam)
    rig = pycolmap.Rig(rig_id=1)
    rig.add_ref_sensor(cam.sensor_id)
    rec.add_rig(rig)
    for i in range(24):
        a_ = 2 * np.pi * i / 24
        c = np.array([3.2 * np.cos(a_), 3.2 * np.sin(a_), 1.4 + 0.3 * np.sin(3 * a_)])
        R, t = look_at(c, np.array([0, 0, 0.35]))
        name = os.path.basename(save(draw(R, t, pts, cols), os.path.join(a.out, "images", f"view_{i:02d}.jpg")))
        frame = pycolmap.Frame()
        frame.frame_id = i + 1
        frame.rig_id = 1
        frame.rig_from_world = pycolmap.Rigid3d(pycolmap.Rotation3d(R), t)
        d = pycolmap.data_t()
        d.sensor_id = cam.sensor_id
        d.id = i + 1
        frame.add_data_id(d)
        rec.add_frame(frame)
        im = pycolmap.Image(name=name, camera_id=1, image_id=i + 1)
        im.frame_id = i + 1
        rec.add_image(im)
        rec.register_frame(i + 1)
    # A sparse start for the trainer: every 40th point.
    for p, c in zip(pts[::40], cols[::40]):
        rec.add_point3D(p, pycolmap.Track(), c)
    sparse = os.path.join(a.out, "sparse", "0")
    os.makedirs(sparse, exist_ok=True)
    rec.write_binary(sparse)
    print(f"sample: 24 views, {len(pts[::40])} start points in {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
