import base64
import hashlib
import json
import struct
import unittest

import cv2
import numpy as np

from aeromind.app import ROOT
from aeromind.observations import ImageService
from aeromind.portable import PortablePanels, PortableSegments
from aeromind.stations import SETTINGS, photograph
from aeromind.vision import Perception


class PortableTests(unittest.TestCase):
    def test_exported_networks_match_the_recorded_weights(self):
        report=json.loads((ROOT/"evidence/portable-models.json").read_text())
        for name,record in report.items():
            for ext,field in (("pt","torch_sha256"),("onnx","onnx_sha256")):
                file=ROOT/"models"/(name+"."+ext)
                self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(),record[field])
            self.assertEqual(record["argmax_agree"],record["argmax_total"])

    def test_docked_display_uses_the_same_states_and_confidence(self):
        reference=Perception(ROOT/"models/parcel-display-v1.pt")
        portable=PortablePanels(ROOT/"models/parcel-display-v1.onnx")
        for state,seed in (("available",810),("occupied",254),("unreadable",457)):
            frame=photograph(17,state,SETTINGS["test"][0],seed)
            torch_inputs, portable_inputs = {}, {}
            a,b=reference.inspect(frame, model_inputs=torch_inputs),portable.inspect(frame, model_inputs=portable_inputs)
            self.assertEqual(len(a),1)
            self.assertEqual((a[0].station,a[0].state),(b[0].station,b[0].state))
            self.assertAlmostEqual(a[0].confidence,b[0].confidence,places=5)
            np.testing.assert_array_equal(torch_inputs[17], portable_inputs[17])

    def test_only_the_two_gate_frames_supply_classroom_model_inputs(self):
        service = ImageService(PortablePanels(ROOT/"models/parcel-display-v1.onnx"))
        available = photograph(17, "available", SETTINGS["test"][0], 719)
        uncertain = photograph(17, "available", SETTINGS["test"][0], 810)
        occupied = photograph(17, "occupied", SETTINGS["test"][0], 254)

        def send(stream, number, image, include=True):
            h, w = image.shape[:2]
            meta = {"stream":stream, "id":number, "sim_time":number / 10, "station":17, "level":2,
                    "width":w, "height":h, "fov":57, "camera_basis":np.eye(3).ravel().tolist()}
            header = json.dumps(meta).encode()
            packet = (struct.pack("<I", len(header)) + header + cv2.cvtColor(image,cv2.COLOR_BGR2RGBA).tobytes()
                      + np.full((h,w),400,"<u2").tobytes())
            return service.process(packet, panel_evidence=include)

        low_score = send("A", 0, uncertain)
        self.assertEqual(low_score["readings"][0]["state"], "available")
        self.assertLess(low_score["readings"][0]["confidence"], .8)
        self.assertEqual(low_score["handoff"]["state"], "wait")
        self.assertNotIn("panel_proof", low_score)
        self.assertNotIn("panel_proof", send("A", 1, available))
        blocked = send("A", 2, occupied)
        self.assertEqual(blocked["handoff"]["reason"], "站点显示占用")
        self.assertNotIn("panel_proof", blocked)
        self.assertNotIn("panel_proof", send("A", 3, available))
        service.fork("A", "B")
        self.assertNotIn("panel_proof", send("A", 4, occupied))
        confirmed = send("B", 4, available)
        self.assertEqual(confirmed["handoff"]["state"], "ready")
        proof = confirmed["panel_proof"]
        self.assertEqual([s["id"] for s in proof["frames"]], [3, 4])
        self.assertEqual([s["stamp_ns"] for s in proof["frames"]], list(confirmed["handoff"]["evidence_ns"]))
        patch = base64.b64decode(proof["frames"][1]["gray_u8_b64"])
        self.assertEqual(len(patch), proof["patch_size"] ** 2)
        retained = {}
        service.perception.inspect(available, model_inputs=retained)
        self.assertEqual(patch, retained[17].tobytes())
        self.assertNotIn("panel_proof", send("B", 5, available, include=False))
        self.assertNotIn("panel_proof", send("B", 6, available))

    def test_textureless_input_abstains_in_portable_vision(self):
        model=PortableSegments(ROOT/"models/campus-segments-v1.onnx")
        self.assertEqual(model.inspect(np.zeros((90,160,3),np.uint8),np.ones((90,160),np.float32)),[])


if __name__=="__main__":
    unittest.main()
