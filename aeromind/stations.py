"""Design and photograph the fictional parcel-station signs used in the city."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


STATIONS = {17: "图书馆", 31: "居民服务站", 46: "物流中心"}
LABELS = ("available", "occupied", "unreadable")
MARKER = np.float32([[29, 44], [140, 44], [140, 155], [29, 155]])
TILE = np.float32([[214, 48], [317, 48], [317, 151], [214, 151]])
PATCH_SIZE = 40
DICTIONARY = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_100)


@dataclass(frozen=True)
class Setting:
    name: str
    bgr: tuple[int, int, int]
    wall: tuple[int, int, int]
    bias: float
    haze: float


# A group fixes the facade material, display finish and illumination. A group
# and all views of its wall belong to exactly one split.
SETTINGS = {
    "train": (
        Setting("depot-brick-noon", (38, 48, 52), (63, 88, 115), 1.00, 0.00),
        Setting("campus-enamel-shadow", (56, 43, 30), (108, 115, 106), 0.75, 0.05),
        Setting("tower-slate-sunset", (50, 40, 45), (84, 77, 77), 0.90, 0.09),
        Setting("park-copper-overcast", (35, 48, 62), (71, 90, 95), 1.08, 0.08),
    ),
    "val": (
        Setting("library-concrete-cloud", (48, 51, 55), (135, 142, 150), 0.85, 0.15),
        Setting("station-zinc-evening", (49, 40, 35), (91, 75, 67), 0.68, 0.04),
    ),
    "test": (
        Setting("residence-ceramic-mist", (50, 45, 41), (121, 152, 161), 0.82, 0.22),
        Setting("annex-basalt-night", (40, 52, 46), (57, 62, 61), 0.52, 0.02),
    ),
}


def display_tile(label, rng, setting):
    image = np.full((104, 104, 3), setting.bgr, np.uint8)
    color = tuple(int(v) for v in rng.integers(195, 256, 3))
    center = np.array([52, 52]) + rng.integers(-6, 7, 2)
    x, y = map(int, center)
    width = int(rng.integers(6, 11))
    if label == "available":
        points = np.int32([[x - 27, y], [x - 7, y + 20], [x + 28, y - 22]])
        cv2.polylines(image, [points], False, color, width, cv2.LINE_AA)
    elif label == "occupied":
        cv2.line(image, (x - 23, y - 23), (x + 23, y + 23), color, width, cv2.LINE_AA)
        cv2.line(image, (x + 23, y - 23), (x - 23, y + 23), color, width, cv2.LINE_AA)
    elif label == "unreadable":
        pattern = int(rng.integers(5))
        if pattern == 1:
            cv2.line(image, (x - 25, y), (x + 26, y), color, width)
        elif pattern == 2:
            cv2.circle(image, (x, y), 19, color, width)
        elif pattern == 3:
            for offset in (-16, 0, 16):
                cv2.circle(image, (x + offset, y), 4, color, -1)
        elif pattern == 4:
            noise = rng.integers(0, 60, image.shape, np.uint8)
            image = cv2.add(image, noise)
    else:
        raise ValueError(f"Unknown display label {label}")
    return image


def sign_texture(station, label, rng, setting):
    """BGR texture shared by the UE material and the training renderer."""
    if station not in STATIONS:
        raise ValueError("Unknown station")
    board = np.full((200, 352, 3), setting.bgr, np.uint8)
    cv2.rectangle(board, (3, 3), (348, 196), (143, 162, 155), 2, cv2.LINE_AA)
    cv2.rectangle(board, (17, 32), (152, 167), (248, 248, 248), -1)
    tag = cv2.aruco.generateImageMarker(DICTIONARY, station, 112)
    board[44:156, 29:141] = cv2.cvtColor(tag, cv2.COLOR_GRAY2BGR)
    cv2.line(board, (173, 30), (173, 170), (135, 144, 125), 1)
    cv2.putText(board, f"AM / {station:02d}", (198, 33),
                cv2.FONT_HERSHEY_DUPLEX, 0.55, (226, 237, 232), 1, cv2.LINE_AA)
    cv2.rectangle(board, (208, 42), (323, 157), (151, 167, 153), 2, cv2.LINE_AA)
    board[48:152, 214:318] = display_tile(label, rng, setting)
    cv2.putText(board, "PARCEL EXCHANGE", (191, 182),
                cv2.FONT_HERSHEY_SIMPLEX, 0.48, (210, 219, 209), 1, cv2.LINE_AA)
    return board


def photograph(station, label, setting, seed):
    """Procedural camera fixture used for offline learning, in BGR pixels."""
    rng = np.random.default_rng(seed)
    board = sign_texture(station, label, rng, setting)
    height, width = 270, 480
    wall = np.full((height, width, 3), setting.wall, np.uint8)
    for row in range(18, height, 43):
        cv2.line(wall, (0, row), (width, row), tuple(int(c * .85) for c in setting.wall), 2)
        for col in range((row % 2) * 52, width, 104):
            cv2.line(wall, (col, row), (col, row + 42), setting.bgr, 1)
    scale = rng.uniform(0.62, 0.99)
    center = np.array([width / 2, height / 2]) + rng.uniform((-30, -13), (30, 13))
    src = np.float32([[0, 0], [351, 0], [351, 199], [0, 199]])
    dst = ((src - [175.5, 99.5]) * scale + center + rng.uniform(-11, 11, (4, 2))).astype("float32")
    homography = cv2.getPerspectiveTransform(src, dst)
    cv2.warpPerspective(board, homography, (width, height), dst=wall,
                        borderMode=cv2.BORDER_TRANSPARENT)
    shade = np.linspace(rng.uniform(.78, 1.05), rng.uniform(.82, 1.15), width, dtype="float32")
    pixels = wall.astype("float32") * shade[None, :, None] * setting.bias
    pixels = pixels * (1 - setting.haze) + 170 * setting.haze
    pixels += rng.normal(0, 2.4, wall.shape).astype("float32")
    image = np.clip(pixels, 0, 255).astype("uint8")
    return cv2.GaussianBlur(image, (3, 3), rng.uniform(.35, .85))


def export_textures(folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    for station in STATIONS:
        for label in LABELS:
            texture = sign_texture(station, label, np.random.default_rng(28), SETTINGS["train"][0])
            target = folder / f"station_{station}_{label}.png"
            if not cv2.imwrite(str(target), texture):
                raise OSError(f"Could not export {target}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Export parcel station textures for Unreal.")
    parser.add_argument("folder", type=Path)
    export_textures(parser.parse_args().folder)
