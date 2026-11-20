"""Common geometry and confidence extraction for both CPU inference runtimes."""

import cv2
import numpy as np


LABELS = ("background", "station_display", "construction")
SIZE = (160, 90)


def has_texture(bgr):
    return np.ptp(bgr[::4,::4],axis=(0,1)).max() >= 6


def region_geometry(scores,depth):
    h, w = depth.shape
    labels = scores.argmax(0)
    regions = []
    for index in (1, 2):
        mask = ((labels == index) & (scores[index] >= .65)).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for shape in sorted(contours, key=cv2.contourArea, reverse=True)[:4]:
            if cv2.contourArea(shape) < 15:
                continue
            polygon = cv2.approxPolyDP(shape, 1.1, True)[:, 0].astype(float)
            if len(polygon) < 3:
                continue
            selected = np.zeros_like(mask)
            cv2.drawContours(selected, [shape], -1, 1, -1)
            selected &= mask
            valid = cv2.resize(selected, (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
            depths = depth[valid & (depth > .2) & (depth < 90)]
            ys, xs = np.where(selected)
            regions.append({"label": LABELS[index], "confidence": round(float(scores[index][selected > 0].mean()), 3),
                            "polygon_px": (polygon * [w/SIZE[0], h/SIZE[1]]).round().astype(int).tolist(),
                            "center_uv": [round(float(xs.mean() / SIZE[0]), 4), round(float(ys.mean() / SIZE[1]), 4)],
                            "range_m": round(float(np.median(depths)), 3) if depths.size else None})
    return regions
