"""Shared pixel rectification for the classroom's fictional station signs."""

from dataclasses import dataclass

import cv2
import numpy as np

from .stations import DICTIONARY, MARKER, PATCH_SIZE, STATIONS, TILE


class PanelReader:
    def __init__(self):
        parameters = cv2.aruco.DetectorParameters()
        parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        self.detector = cv2.aruco.ArucoDetector(DICTIONARY, parameters)

    def patches(self, image):
        if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("Expected an 8-bit BGR camera frame")
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        corners, ids, _ = self.detector.detectMarkers(gray)
        if ids is None:
            return
        height, width = gray.shape
        rect = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]]) * (PATCH_SIZE - 1)
        for raw, index in zip(corners, ids.flatten()):
            station = int(index)
            if station not in STATIONS:
                continue
            transform = cv2.getPerspectiveTransform(MARKER, raw.reshape(4, 2))
            quad = cv2.perspectiveTransform(TILE[None], transform)[0]
            if (not np.isfinite(quad).all() or not cv2.isContourConvex(quad)
                    or cv2.contourArea(quad) < 180 or np.any(quad < 0)
                    or np.any(quad[:, 0] >= width) or np.any(quad[:, 1] >= height)):
                continue
            rectify = cv2.getPerspectiveTransform(quad, rect)
            tile = cv2.warpPerspective(gray, rectify, (PATCH_SIZE, PATCH_SIZE))
            yield station, tile, quad


@dataclass(frozen=True)
class Reading:
    station: int
    state: str
    confidence: float
    polygon_px: tuple
