"""Checks for holo_masks.py: python -m unittest workers/test_holo_masks.py (numpy and Pillow)."""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import holo_masks as hm  # noqa: E402


class Masks(unittest.TestCase):
    def test_parked_vehicle_is_kept_moving_one_is_not(self):
        rng = np.random.default_rng(1)
        xy = rng.uniform(0, 100, (400, 2))
        tracked = rng.uniform(size=400) < 0.6
        box = (20, 20, 60, 60)
        self.assertTrue(hm.judge(box, xy, tracked, tracked.mean()))
        # The same features, but none of those on the vehicle became 3D points: it moved.
        inside = (xy[:, 0] >= 20) & (xy[:, 0] <= 60) & (xy[:, 1] >= 20) & (xy[:, 1] <= 60)
        self.assertFalse(hm.judge(box, xy, tracked & ~inside, tracked.mean()))
        # Too blurred to have features: left out too.
        self.assertFalse(hm.judge(box, xy[~inside], tracked[~inside], tracked.mean()))

    def test_overlapping_boxes_are_merged(self):
        boxes = np.array([[0, 0, 10, 10], [1, 1, 10, 10], [50, 50, 60, 60]], dtype=float)
        self.assertEqual(sorted(hm.nms(boxes, np.array([0.9, 0.8, 0.7]))), [0, 2])


if __name__ == "__main__":
    unittest.main()
