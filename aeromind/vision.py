"""Read station identity and display state using only the camera's BGR image."""

from pathlib import Path

import numpy as np
import torch
from torch import nn

from .panels import PanelReader, Reading
from .stations import LABELS


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
