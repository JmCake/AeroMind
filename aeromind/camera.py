"""Prepare and record the two aligned sensors in a local Project AirSim UE scene."""

import argparse
import hashlib
import json
import logging
import time
import urllib.request
from importlib.metadata import version
from pathlib import Path

import commentjson
import cv2
import numpy as np
import torch
from projectairsim import Drone, ProjectAirSimClient, World
from projectairsim.utils import load_scene_config_as_dict, unpack_image

from .handoff import HandoffCheck
from .lesson import DEFAULT_WEIGHTS, inspect_frame
from .vision import Perception


UPSTREAM = "09755454b8d82b0231af7e59fd1ab8f980ff32c5"
REFERENCE_URL = (f"https://raw.githubusercontent.com/iamaisim/ProjectAirSim/{UPSTREAM}/"
                 "client/python/example_user_scripts/sim_config/robot_quadrotor_fastphysics.jsonc")
REFERENCE_SHA = "6f8cb70bfb8e64b1ae1d22cbb675000e21df6fffc29431b4ab85d47578ee7faa"
SCENE = "scene_rgbd.json"


def prepare(folder, reference=None):
    if reference:
        raw = reference.read_bytes()
    else:
        with urllib.request.urlopen(REFERENCE_URL, timeout=30) as response:
            raw = response.read()
    if hashlib.sha256(raw).hexdigest() != REFERENCE_SHA:
        raise ValueError("Unexpected upstream robot configuration")
    robot = commentjson.loads(raw.decode())
    camera = {"id": "Front", "type": "camera", "enabled": True, "parent-link": "Frame",
              "capture-interval": 0.1, "origin": {"xyz": "0.24 0 -0.06", "rpy-deg": "0 0 0"},
              "capture-settings": [
                  {"image-type": kind, "width": 480, "height": 270, "fov-degrees": 85,
                   "capture-enabled": True, "streaming-enabled": False, "pixels-as-float": kind == 1,
                   "compress": kind == 0} for kind in (0, 1)
              ]}
    robot["sensors"] = [camera]
    scene = {
        "id": "AeroMindOptics", "scene-type": "UnrealNative",
        "actors": [{"type": "robot", "name": "Post", "robot-config": "camera_robot.json",
                    "origin": {"xyz": "-1 8 -2", "rpy-deg": "0 0 -45"}}],
        "clock": {"type": "steppable", "step-ns": 3000000, "real-time-update-rate": 3000000,
                  "pause-on-start": False},
        "home-geo-point": {"latitude": 0.0, "longitude": 0.0, "altitude": 0.0},
    }
    folder.mkdir(exist_ok=True, parents=True)
    for name, content in [(SCENE, scene), ("camera_robot.json", robot)]:
        (folder / name).write_text(json.dumps(content, indent=2) + "\n", "ascii")
    load_scene_config_as_dict(SCENE, str(folder))


def decode_pair(images):
    color, distance = images[0], images[1]
    stamp = color["time_stamp"]
    if stamp != distance["time_stamp"] or not isinstance(stamp, int) or stamp < 0:
        raise ValueError("Unpaired camera timestamps")
    if color["encoding"] != "PNG" or distance["encoding"] != "16FC1":
        raise ValueError(f"Unexpected RGB-D encodings: {color['encoding']} / {distance['encoding']}")
    bgr, depth = unpack_image(color), unpack_image(distance).astype(np.float32)
    if bgr.shape[:2] != depth.shape or bgr.shape[2:] != (3,):
        raise ValueError("Different image dimensions or invalid color frame")
    depth[(~np.isfinite(depth)) | (depth <= 0)] = np.nan
    return stamp, bgr, depth


def record(folder, output, count, weights):
    if count < 1:
        raise ValueError("Frame count must be positive")
    torch.set_num_threads(2)
    model, gate = Perception(weights), HandoffCheck(17)
    output.mkdir(exist_ok=False, parents=True)
    client = ProjectAirSimClient()
    complete = False
    rows = []
    try:
        client.connect()
        client.socket_services.recv_timeout = 25000
        world = World(client, SCENE, sim_config_path=str(folder), delay_after_load_sec=2)
        robot = Drone(client, world, "Post")
        with (output / "frames.jsonl").open("x", encoding="utf8") as stream:
            for index in range(count):
                start = time.perf_counter()
                stamp, bgr, depth = decode_pair(robot.get_images("Front", [0, 1]))
                if rows and stamp <= rows[-1]["sim_time_ns"]:
                    raise RuntimeError("Camera simulation time did not advance")
                row = inspect_frame(model, gate, stamp, bgr)
                valid = depth[np.isfinite(depth)]
                row.update(frame_id=index, camera="Post/Front", source="ProjectAirSim",
                           rgb_file=f"rgb-{index:03}.png", depth_file=f"planar-{index:03}.npy",
                           shape_hw=list(depth.shape), valid_depth_fraction=valid.size / depth.size,
                           median_planar_m=float(np.median(valid)) if valid.size else None,
                           rgb_spatial_std=float(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).std()),
                           request_to_decision_ms=(time.perf_counter() - start) * 1000)
                if not cv2.imwrite(str(output / row["rgb_file"]), bgr):
                    raise OSError("Could not save frame")
                np.save(output / row["depth_file"], depth, allow_pickle=False)
                rows.append(row)
                stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
                stream.flush()
        if not any(row["rgb_spatial_std"] > 1 and row["valid_depth_fraction"] > .01 for row in rows):
            raise RuntimeError("No textured frame with measurable depth")
        complete = True
    finally:
        if client.state:
            client.disconnect()
        summary = {"scope": "live UE RGB and planar depth capture", "complete": complete,
                   "frame_count": len(rows), "projectairsim_client": version("projectairsim"),
                   "weights_sha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
                   "config_sha256": {p: hashlib.sha256((folder / p).read_bytes()).hexdigest()
                                     for p in (SCENE, "camera_robot.json")}}
        if rows:
            summary["request_to_decision_ms"] = dict(zip(("p50", "p95", "p99"),
                np.percentile([r["request_to_decision_ms"] for r in rows], [50, 95, 99]).tolist()))
        (output / "capture.json").write_text(json.dumps(summary, indent=2), encoding="utf8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("folder", type=Path)
    setup.add_argument("--reference", type=Path, help="Use an offline copy of the pinned robot file")
    capture = commands.add_parser("record")
    capture.add_argument("folder", type=Path)
    capture.add_argument("output", type=Path)
    capture.add_argument("--frames", type=int, default=10)
    capture.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.folder, args.reference)
    else:
        record(args.folder, args.output, args.frames, args.weights)
