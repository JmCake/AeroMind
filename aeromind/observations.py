"""Paired, calibrated WebGL image measurements. Camera x right, y up, -z forward."""

import json
import math
import struct
import threading
from copy import deepcopy
from collections import OrderedDict
from dataclasses import asdict
from time import perf_counter

import cv2
import numpy as np

from .handoff import HandoffCheck
from .stations import STATIONS


def parse_packet(packet):
    if len(packet) < 5:
        raise ValueError("Incomplete sensor packet")
    size, = struct.unpack_from("<I", packet)
    if not 1 <= size <= 2048 or size + 4 >= len(packet):
        raise ValueError("Invalid packet header")
    meta = json.loads(packet[4:4 + size])
    w, h = meta["width"], meta["height"]
    if (type(w) is not int or type(h) is not int or not (64 <= w <= 640 and 36 <= h <= 360)
            or len(packet) != 4 + size + w*h*6):
        raise ValueError("Invalid frame dimensions")
    if (type(meta["id"]) is not int or meta["id"] < 0 or not 20 <= meta["fov"] <= 120
            or not math.isfinite(meta["sim_time"]) or meta["sim_time"] < 0
            or meta["station"] not in STATIONS or meta.get("level",4) not in range(1,6)
            or not isinstance(meta["stream"], str) or not 1 <= len(meta["stream"]) <= 80):
        raise ValueError("Invalid sensor metadata")
    rotation = np.asarray(meta["camera_basis"], dtype="float64").reshape(3, 3)
    if (not np.isfinite(rotation).all() or not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-3)
            or not np.isclose(np.linalg.det(rotation), 1, atol=1e-3)):
        raise ValueError("Invalid inertial orientation")
    offset = size + 4
    rgba = np.frombuffer(packet, np.uint8, count=w*h*4, offset=offset).reshape(h,w,4)
    bgr = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
    depth = np.frombuffer(packet, "<u2", offset=offset+w*h*4).reshape(h,w).astype("float32") / 100
    return meta, bgr, depth, rotation


def camera_points(pixels, depth, focal):
    h, w = depth.shape
    xy = np.rint(pixels).astype("int32")
    z = depth[np.clip(xy[:,1], 0, h-1), np.clip(xy[:,0], 0, w-1)]
    return np.column_stack([(pixels[:,0]-(w-1)/2)*z/focal,
                            ((h-1)/2-pixels[:,1])*z/focal, -z])


def displacement(previous, gray, depth, basis, focal, interval):
    old, old_depth, old_basis, old_focal = previous
    if old.shape != gray.shape or not 0 < interval <= 2:
        return None, 0, None
    initial = cv2.goodFeaturesToTrack(old, 140, .012, 5)
    if initial is None or len(initial) < 8:
        return None, 0, None
    current, status, _ = cv2.calcOpticalFlowPyrLK(old, gray, initial, None, winSize=(17,17), maxLevel=3)
    back, rev, _ = cv2.calcOpticalFlowPyrLK(gray, old, current, None, winSize=(17,17), maxLevel=3)
    a, b = initial[:,0], current[:,0]
    h, w = gray.shape
    valid = ((status.ravel() == 1) & (rev.ravel() == 1) & (np.linalg.norm(back[:,0]-a, axis=1) < 1.25)
             & (b[:,0]>=1) & (b[:,1]>=1) & (b[:,0]<w-1) & (b[:,1]<h-1))
    p = camera_points(a[valid], old_depth, old_focal)
    q = camera_points(b[valid], depth, focal)
    hits = (p[:,2]<-.15) & (q[:,2]<-.15) & (p[:,2]>-90) & (q[:,2]>-90)
    change = (p @ old_basis.T - q @ basis.T)[hits]
    if len(change) < 6:
        return None, len(change), None
    median = np.median(change, axis=0)
    residual = np.linalg.norm(change - median, axis=1)
    keep = residual <= max(.12, min(.8, 2.5*float(np.median(residual))))
    if keep.sum() < 6 or np.linalg.norm(median) > 2 + 18*interval:
        return None, int(keep.sum()), None
    return np.median(change[keep], axis=0).round(5).tolist(), int(keep.sum()), float(np.median(residual[keep]))


class ImageService:
    def __init__(self, perception):
        self.perception = perception
        self.previous = OrderedDict()
        self.lock = threading.Lock()

    def fork(self, source, target):
        if (not isinstance(source,str) or not isinstance(target,str)
                or not 1 <= len(target) <= 80 or target == source):
            raise ValueError("Invalid fork handle")
        with self.lock:
            if source not in self.previous or target in self.previous:
                raise ValueError("Missing source or conflicting fork")
            state = self.previous[source]
            self.previous[target] = deepcopy(state)
            if len(self.previous) > 32:
                self.previous.popitem(last=False)
            return {"last_frame":state[0], "sim_time":state[1]}

    def process(self, packet):
        started = perf_counter()
        meta, bgr, depth, basis = parse_packet(packet)
        h, w = depth.shape
        focal = .5*h / math.tan(math.radians(meta["fov"] / 2))
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        level = meta.get("level",4)
        readings = self.perception.inspect(bgr) if level >= 2 else []
        with self.lock:
            key = meta["stream"]
            last = self.previous.get(key)
            delta, support, error = None, 0, None
            gate = last[3] if last and last[3].station == meta["station"] else HandoffCheck(meta["station"], max_gap_ns=1_000_000_000)
            if last:
                frame_id, stamp, previous, _ = last
                if meta["id"] <= frame_id or meta["sim_time"] <= stamp:
                    raise ValueError("Stale frame")
                if level >= 3:
                    delta, support, error = displacement(previous, gray, depth, basis, focal,
                                                         meta["sim_time"] - stamp)
            decision = gate.observe(round(meta["sim_time"] * 1e9), readings)
            self.previous[key] = (meta["id"], meta["sim_time"], (gray, depth, basis, focal), gate)
            self.previous.move_to_end(key)
            if len(self.previous) > 32:
                self.previous.popitem(last=False)
        # Every ray is an actual depth sample. No-hit pixels supply no occupied endpoint.
        yy, xx = np.mgrid[h//8:h: max(1,h//7), w//24:w: max(1,w//15)]
        pixels = np.column_stack([xx.ravel(), yy.ravel()])
        endpoints = camera_points(pixels, depth, focal)
        endpoints = endpoints[(endpoints[:,2] < -.2) & (endpoints[:,2] >= -90)]
        sectors = []
        for band in np.array_split(depth[2*h//5:3*h//5], 5, axis=1):
            hits = band[(band > .2) & (band <= 90)]
            sectors.append(round(float(np.quantile(hits, .12)), 2) if hits.size else None)
        panels = []
        for item in readings:
            center = np.mean(item.polygon_px, axis=0).reshape(1,2)
            point = camera_points(center, depth, focal)[0]
            measured = (point @ basis.T).round(4).tolist() if -.2 > point[2] >= -30 else None
            panels.append({**asdict(item), "panel_relative_m":measured})
        return {"id":meta["id"], "sim_time":meta["sim_time"], "stream":meta["stream"],
                "readings":panels, "handoff": asdict(decision), "sector_m":sectors,
                "rays_world_relative_m":(endpoints @ basis.T).round(2).tolist(),
                "translation_m":delta, "tracked_features":support, "flow_residual_m":error,
                "processing_ms":round((perf_counter()-started)*1000, 2)}
