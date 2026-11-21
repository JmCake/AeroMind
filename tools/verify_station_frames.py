"""Recompute the projected station inputs and scores from a real classroom run."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess

import cv2
import numpy as np

from aeromind.app import ROOT
from aeromind.observations import parse_packet
from aeromind.stations import LABELS, PATCH_SIZE


def rectify(directory, proof):
    rect = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]]) * (PATCH_SIZE - 1)
    tiles = []
    for frame in proof["frames"]:
        meta, image, _, _ = parse_packet((directory / f"station-{frame['id']}.rgbd").read_bytes())
        if (meta["id"] != frame["id"] or meta["station"] != proof["station"]
                or meta["sim_time"] != frame["simulation_seconds"]):
            raise ValueError("Camera packet does not match the classroom order")
        transform = cv2.getPerspectiveTransform(np.float32(frame["polygon_px"]), rect)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        tile = cv2.warpPerspective(gray, transform, (PATCH_SIZE, PATCH_SIZE))
        if hashlib.sha256(tile.tobytes()).hexdigest() != frame["gray_sha256"]:
            raise ValueError(f"F{frame['id']} pixels differ using OpenCV {cv2.__version__}. "
                             "Use --rectifier-python with the OpenCV build that served this flight.")
        tiles.append(base64.b64encode(tile.tobytes()).decode("ascii"))
    return {"opencv": cv2.__version__, "tiles": tiles}


def verify(directory, proof, rectifier_python=None):
    import torch
    from aeromind.vision import Perception, tensors

    if rectifier_python:
        child = subprocess.run([rectifier_python, "-m", "tools.verify_station_frames", str(directory), "--rectify"],
                               cwd=ROOT, capture_output=True, text=True)
        if child.returncode:
            raise RuntimeError(child.stderr.strip())
        capture = json.loads(child.stdout)
    else:
        capture = rectify(directory, proof)
    weights = ROOT / "models/parcel-display-v1.pt"
    model = Perception(weights).model
    results = []
    for frame, pixels in zip(proof["frames"], capture["tiles"], strict=True):
        raw = base64.b64decode(pixels, validate=True)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != frame["gray_sha256"]:
            raise ValueError("Projected and reconstructed network inputs differ")
        tile = np.frombuffer(raw, np.uint8).reshape(PATCH_SIZE, PATCH_SIZE)
        with torch.inference_mode():
            scores = model(tensors([tile])).softmax(1)[0]
        index = int(scores.argmax())
        difference = abs(float(scores[index]) - frame["score"])
        if LABELS[index] != frame["state"] or difference > .0001:
            raise ValueError("The training checkpoint disagrees with the displayed prediction")
        results.append({"frame":frame["id"], "gray_sha256":digest, "state":LABELS[index],
                        "pytorch_score":float(scores[index]), "score_difference":difference})
    if len(results) != 2 or results[0]["frame"] >= results[1]["frame"]:
        raise ValueError("Two distinct ordered confirmation frames are required")
    return {"rectification_opencv": capture["opencv"], "pytorch": str(torch.__version__),
            "pytorch_weights_sha256":hashlib.sha256(weights.read_bytes()).hexdigest(), "frames":results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--rectifier-python", help="Python with the flight's OpenCV build if it differs from the training environment")
    parser.add_argument("--rectify", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    directory = args.directory.resolve()
    run = json.loads((directory / "classroom.json").read_text(encoding="utf-8"))
    proof = run["runs"][0]["station_classification"]
    if args.rectify:
        print(json.dumps(rectify(directory, proof)))
        raise SystemExit(0)
    report = json.dumps(verify(directory, proof, args.rectifier_python), indent=2)
    (directory / "station-recheck.json").write_text(report + "\n", encoding="utf-8")
    print(report)
