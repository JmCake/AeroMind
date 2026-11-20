"""Read station identity and display state using only the camera's BGR image."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
from torch import nn

from .stations import DICTIONARY, LABELS, MARKER, PATCH_SIZE, STATIONS, TILE


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


class DisplayNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.network = nn.Sequential(
            nn.Conv2d(1, 8, 5, stride=2, padding=2), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(8, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Flatten(), nn.Linear(16 * 5 * 5, 32), nn.ReLU(), nn.Linear(32, len(LABELS)),
        )

    def forward(self, patches):
        return self.network(patches)


def tensors(patches):
    array = np.stack(patches).astype(np.float32) / 255
    return torch.from_numpy(array[:, None, :, :])


@dataclass(frozen=True)
class Reading:
    station: int
    state: str
    confidence: float
    polygon_px: tuple


class Perception:
    def __init__(self, weights: Path):
        payload = torch.load(weights, map_location="cpu", weights_only=True)
        if payload["format"] != 1 or tuple(payload["labels"]) != LABELS:
            raise ValueError("Unsupported parcel display checkpoint")
        self.model = DisplayNet()
        self.model.load_state_dict(payload["model"])
        self.model.eval()
        self.reader = PanelReader()

    @torch.inference_mode()
    def inspect(self, bgr):
        patches = list(self.reader.patches(bgr))
        if not patches:
            return []
        probabilities = self.model(tensors([p[1] for p in patches])).softmax(1)
        result = []
        for (station, _, quad), scores in zip(patches, probabilities):
            confidence, index = scores.max(0)
            result.append(Reading(station, LABELS[index.item()], confidence.item(),
                                  tuple(tuple(map(float, p)) for p in quad)))
        return result
