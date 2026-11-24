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


class FakeOrt:
    """Stands in for onnxruntime: which providers it has, and which of them fail to start."""

    class ExecutionMode:
        ORT_SEQUENTIAL = 0

    class SessionOptions:
        intra_op_num_threads = 0

    def __init__(self, have, broken=()):
        self.have, self.broken = list(have), set(broken)
        fake = self

        class Session:
            def __init__(self, model, sess_options=None, providers=()):
                if providers[0] in fake.broken:
                    raise RuntimeError(f"{providers[0]} failed")
                self.providers = list(providers)

            def get_providers(self):
                return self.providers

        self.InferenceSession = Session

    def get_available_providers(self):
        return self.have


class Detector(unittest.TestCase):
    def test_the_card_when_asked_and_onnxruntime_has_a_way_there(self):
        ort = FakeOrt(["DmlExecutionProvider", "CPUExecutionProvider"])
        s = hm.open_detector(ort, "m.onnx", ort.SessionOptions(), True)
        self.assertEqual(s.get_providers()[0], "DmlExecutionProvider")

    def test_the_processor_when_not_asked_when_there_is_no_way_or_when_the_card_fails(self):
        both = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
        self.assertEqual(hm.open_detector(FakeOrt(both), "m", FakeOrt.SessionOptions(), False).get_providers(), ["CPUExecutionProvider"])
        self.assertEqual(hm.open_detector(FakeOrt(["CPUExecutionProvider"]), "m", FakeOrt.SessionOptions(), True).get_providers(), ["CPUExecutionProvider"])
        # CUDA fails, DirectML works: DirectML. Both fail: the processor.
        self.assertEqual(hm.open_detector(FakeOrt(both, ["CUDAExecutionProvider"]), "m", FakeOrt.SessionOptions(), True).get_providers()[0], "DmlExecutionProvider")
        self.assertEqual(hm.open_detector(FakeOrt(both, ["CUDAExecutionProvider", "DmlExecutionProvider"]), "m", FakeOrt.SessionOptions(), True).get_providers(), ["CPUExecutionProvider"])
