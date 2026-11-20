"""Run the station-reading laboratory or inspect a supplied camera photograph."""

import argparse
import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
import torch

from .handoff import HandoffCheck
from .stations import SETTINGS, STATIONS, photograph
from .vision import Perception


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WEIGHTS = ROOT / "models" / "parcel-display-v1.pt"


def inspect_frame(model, gate, stamp, frame):
    start = perf_counter()
    readings = model.inspect(frame)
    decision = gate.observe(stamp, readings)
    return {
        "sim_time_ns": stamp, "camera": "parcel-reader", "coordinates": "pixel_xy",
        "readings": [asdict(r) for r in readings], "decision": asdict(decision),
        "processing_ms": (perf_counter() - start) * 1e3,
    }


def run(output, weights, station, image_path=None):
    torch.set_num_threads(2)
    model = Perception(weights)
    gate = HandoffCheck(station)
    if image_path:
        frame = cv2.imdecode(np.frombuffer(image_path.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError(f"Unreadable image {image_path}")
        frames = [frame]
        source = "user_image"
    else:
        setting = SETTINGS["val"][0]
        other = next(s for s in STATIONS if s != station)
        frames = [photograph(other, "available", setting, 719),
                  photograph(station, "occupied", setting, 254),
                  photograph(station, "unreadable", setting, 457)]
        # Keep the same sequence even when a previous frame was uncertain.
        frames += [photograph(station, "available", setting, seed)
                   for seed in (634, 809, 810, 811, 812, 813)]
        source = "procedural_camera_fixture"
    output.mkdir(parents=True, exist_ok=False)
    evidence = []
    for index, frame in enumerate(frames):
        row = inspect_frame(model, gate, index * 200_000_000, frame)
        row["frame_id"] = index
        row["file"] = f"rgb-{index:03}.png"
        target = output / row["file"]
        ok, png = cv2.imencode(".png", frame)
        if not ok:
            raise OSError("Failed to encode image")
        target.write_bytes(png.tobytes())
        row["sha256"] = hashlib.sha256(png).hexdigest()
        evidence.append(row)
        print(f"{index:02}  {row['decision']['reason']}")
    record = {"schema": 1, "source": source, "station": station, "frames": evidence,
              "weights_sha256": hashlib.sha256(weights.read_bytes()).hexdigest()}
    (output / "observations.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), "utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--station", type=int, choices=STATIONS, default=17)
    parser.add_argument("--image", type=Path)
    args = parser.parse_args()
    run(args.output, args.weights, args.station, args.image)
