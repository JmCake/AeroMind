import hashlib
import json
import unittest

import numpy as np

from aeromind.app import ROOT
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
            a,b=reference.inspect(frame),portable.inspect(frame)
            self.assertEqual(len(a),1)
            self.assertEqual((a[0].station,a[0].state),(b[0].station,b[0].state))
            self.assertAlmostEqual(a[0].confidence,b[0].confidence,places=5)

    def test_textureless_input_abstains_in_portable_vision(self):
        model=PortableSegments(ROOT/"models/campus-segments-v1.onnx")
        self.assertEqual(model.inspect(np.zeros((90,160,3),np.uint8),np.ones((90,160),np.float32)),[])


if __name__=="__main__":
    unittest.main()
