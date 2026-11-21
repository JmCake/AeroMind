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
            or meta.get("checkpoint","selected") not in ("selected","early")
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


def track_regions(regions, old, number, stamp):
    remaining = list(old)
    for region in regions:
        u, v = region["center_uv"]
        candidates = [r for r in remaining if r["label"] == region["label"] and 0 < stamp-r["time"] < .7]
        matched = min(candidates, key=lambda r: math.dist(r["center_uv"], (u,v)), default=None)
        if matched and math.dist(matched["center_uv"], (u,v)) < .18:
            remaining.remove(matched)
            dt = stamp - matched["time"]
            velocity = [(p-q)/dt for p,q in zip((u,v), matched["center_uv"])]
            dr = ((region["range_m"]-matched["range_m"])/dt if region["range_m"] is not None
                  and matched["range_m"] is not None else 0)
            region["track"] = matched["track"]
            region["motion_uv_s"] = [round(.4*a+.6*b,4) for a,b in zip(velocity, matched["motion_uv_s"])]
            region["range_rate_m_s"] = round(.4*max(-15,min(15,dr))+.6*matched["range_rate_m_s"],3)
            region["age"] = matched["age"]+1
        else:
            number += 1
            region.update(track=number, motion_uv_s=[0,0], range_rate_m_s=0, age=1)
        region["time"] = stamp
        region["predicted_uv_035s"] = [round(p+.35*q,4) for p,q in zip((u,v),region["motion_uv_s"])]
    return number


class KeyframeMap:
    """Sparse RGB-D visual landmarks expressed in each keyframe's camera origin."""

    def __init__(self):
        self.frames = []
        self.last_probe = -10.

    def update(self, gray, depth, basis, focal, frame, stamp):
        if stamp - self.last_probe < 1.1:
            return None, False
        self.last_probe = stamp
        orb = cv2.ORB_create(nfeatures=210,edgeThreshold=10,fastThreshold=12)
        keys, descriptors = orb.detectAndCompute(gray,None)
        if descriptors is None or len(keys) < 18:
            return None, False
        pixels = np.float32([k.pt for k in keys])
        points = camera_points(pixels,depth,focal)
        keep = (points[:,2] < -.4) & (points[:,2] > -55)
        pixels, descriptors, points = pixels[keep], descriptors[keep], (points[keep] @ basis.T).astype("float32")
        if len(points) < 18:
            return None, False
        direction = basis[:,2].copy()
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        best = None
        for reference in self.frames:
            if stamp-reference["time"] < 7 or reference["direction"] @ direction < .72:
                continue
            pairs = matcher.knnMatch(descriptors,reference["descriptors"],k=2)
            matches = [a for a,b in pairs if a.distance < .72*b.distance and a.distance < 52]
            if len(matches) < 12:
                continue
            # Reciprocal assignment rejects repeated facade panels that all
            # voted for the same descriptor. Check metric consistency as well.
            reverse = matcher.match(reference["descriptors"],descriptors)
            inverse = {m.queryIdx:m.trainIdx for m in reverse}
            matches = [m for m in matches if inverse.get(m.trainIdx) == m.queryIdx]
            if len(matches) < 12:
                continue
            ids = [m.queryIdx for m in matches]
            change = reference["points"][[m.trainIdx for m in matches]] - points[ids]
            median = np.median(change,axis=0)
            residual = np.linalg.norm(change-median,axis=1)
            inliers = residual < .30
            n = int(inliers.sum())
            if n < max(12,.62*len(matches)) or (best and n <= best["inliers"]):
                continue
            span = np.ptp(pixels[ids][inliers],axis=0)
            if span[0]<gray.shape[1]*.18 or span[1]<gray.shape[0]*.12:
                continue
            best = {"frame":reference["id"],"inliers":n,"residual_m":round(float(np.median(residual[inliers])),4),
                    "translation_m":np.median(change[inliers],axis=0).round(4).tolist()}
        add = not self.frames or stamp - self.frames[-1]["time"] >= 2.8
        if add:
            self.frames.append({"id":frame,"time":stamp,"direction":direction,"points":points,"descriptors":descriptors})
            if len(self.frames)>30:
                self.frames.pop(1)
        return best,add


class ImageService:
    def __init__(self, perception, segments=None):
        self.perception = perception
        self.segments = segments or {}
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
        checkpoint = meta.get("checkpoint","selected")
        segments = self.segments.get(checkpoint)
        regions = segments.inspect(bgr,depth) if segments and level >= 2 else []
        with self.lock:
            key = meta["stream"]
            last = self.previous.get(key)
            delta, support, error = None, 0, None
            keymap = last[6] if last else KeyframeMap()
            gate = last[3] if last and last[3].station == meta["station"] else HandoffCheck(meta["station"], max_gap_ns=1_000_000_000)
            if last:
                frame_id, stamp, previous = last[:3]
                if meta["id"] <= frame_id or meta["sim_time"] <= stamp:
                    raise ValueError("Stale frame")
                if level >= 3:
                    delta, support, error = displacement(previous, gray, depth, basis, focal,
                                                         meta["sim_time"] - stamp)
            decision = gate.observe(round(meta["sim_time"] * 1e9), readings)
            number = track_regions(regions,last[4] if last else [],last[5] if last else 0,meta["sim_time"])
            loop,added = keymap.update(gray,depth,basis,focal,meta["id"],meta["sim_time"]) if level>=3 else (None,False)
            self.previous[key] = (meta["id"], meta["sim_time"], (gray, depth, basis, focal), gate, regions, number,keymap)
            self.previous.move_to_end(key)
            if len(self.previous) > 32:
                self.previous.popitem(last=False)
        # Every ray is an actual depth sample. No-hit pixels supply no occupied endpoint.
        yy, xx = np.mgrid[h//8:h: max(1,h//7), w//24:w: max(1,w//15)]
        pixels = np.column_stack([xx.ravel(), yy.ravel()])
        endpoints = camera_points(pixels, depth, focal)
        valid = (endpoints[:,2] < -.2) & (endpoints[:,2] >= -90)
        endpoints = endpoints[valid]
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
                "readings":panels,"regions":regions,"segmentation_checkpoint":checkpoint,"loop_closure":loop,"keyframe_added":added,
                "handoff": asdict(decision), "sector_m":sectors,
                "rays_world_relative_m":(endpoints @ basis.T).round(2).tolist(),
                "ray_pixels_px":pixels[valid].tolist(),
                "translation_m":delta, "tracked_features":support, "flow_residual_m":error,
                "processing_ms":round((perf_counter()-started)*1000, 2)}
