import hashlib
import json
import unittest

import cv2
import numpy as np
import torch

try:
    from aeromind.camera import decode_pair
except ModuleNotFoundError as err:
    if err.name not in {"commentjson","projectairsim"}:
        raise
    decode_pair = None
from aeromind.handoff import HandoffCheck
from aeromind.lesson import DEFAULT_WEIGHTS, ROOT
from aeromind.stations import SETTINGS, photograph
from aeromind.vision import Perception, Reading


class StationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        cls.model = Perception(DEFAULT_WEIGHTS)

    def test_release_weights_match_measured_run(self):
        result = json.loads((ROOT/"evidence/parcel-display-v1.json").read_text("utf8"))
        self.assertEqual(hashlib.sha256(DEFAULT_WEIGHTS.read_bytes()).hexdigest(),
                         result["best_weights_sha256"])

    def test_fixture_and_training_groups_are_disjoint(self):
        names = [g.name for split in SETTINGS.values() for g in split]
        self.assertEqual(len(names), len(set(names)))

    def test_full_pixels_to_observation_and_order(self):
        setting = SETTINGS["val"][0]
        check = HandoffCheck(17)
        for i, (station, state, seed, expected) in enumerate([
            (31, "available", 719, "wait"), (17, "occupied", 254, "wait"),
            (17, "unreadable", 457, "wait"), (17, "available", 810, "wait"),
            (17, "available", 811, "ready")]):
            readings = self.model.inspect(photograph(station, state, setting, seed))
            decision = check.observe(i * 100_000_000, readings)
            self.assertEqual(decision.state, expected)
        self.assertEqual(decision.evidence_ns, (300_000_000, 400_000_000))

    def test_blank_frames_and_out_of_view_panel_abstain(self):
        self.assertEqual(self.model.inspect(np.zeros((128,128,3), np.uint8)), [])
        from aeromind.stations import sign_texture
        texture = sign_texture(17, "available", np.random.default_rng(4), SETTINGS["train"][0])
        self.assertEqual(self.model.inspect(texture[:, :185].copy()), [])

    def test_duplicate_stale_and_conflicting_observations(self):
        free = Reading(17, "available", .99, ())
        check = HandoffCheck(17, max_gap_ns=300)
        self.assertEqual(check.observe(0,[free]).state, "wait")
        self.assertEqual(check.observe(0,[free]).state, "ignored")
        self.assertEqual(check.observe(400,[free]).state, "wait")
        self.assertEqual(check.observe(450,[free]).state, "ready")
        self.assertFalse(check.at_time(751))
        self.assertEqual(check.observe(752,[free, free]).state, "wait")
        self.assertFalse(check.at_time(752))


@unittest.skipIf(decode_pair is None, "Optional Project AirSim client is not installed")
class CameraTests(unittest.TestCase):
    def test_depth_metres_and_timestamp_contract(self):
        frame = np.full((2,2,3), 42, np.uint8)
        ok, png = cv2.imencode(".png", frame)
        self.assertTrue(ok)
        rgb = {"encoding":"PNG", "height":2, "width":2, "data":png.tobytes(), "time_stamp":50}
        values = np.float16([[2.5, np.inf], [0, np.nan]])
        depth = {**rgb, "encoding":"16FC1", "data":values.tobytes()}
        stamp, decoded, planar = decode_pair({0:rgb, 1:depth})
        self.assertEqual(stamp, 50)
        np.testing.assert_array_equal(decoded, frame)
        self.assertEqual(planar[0,0], 2.5)
        self.assertEqual(np.isnan(planar).sum(), 3)
        with self.assertRaises(ValueError):
            decode_pair({0:rgb, 1:{**depth, "time_stamp":51}})
        with self.assertRaises(ValueError):
            decode_pair({0:rgb, 1:{**depth, "encoding":"16UC1"}})


if __name__ == "__main__":
    unittest.main()
