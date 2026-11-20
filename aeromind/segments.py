"""Supervised segmentation of two fictional campus object classes from RGB."""

import argparse
import hashlib
import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from .train import save_weights, write_json


from .regions import LABELS, SIZE, has_texture, region_geometry


class CampusNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.near = nn.Sequential(nn.Conv2d(3, 12, 5, 2, 2), nn.ReLU(),
                                  nn.Conv2d(12, 12, 3, padding=1), nn.ReLU())
        self.context = nn.Sequential(nn.Conv2d(12, 18, 3, 2, 1), nn.ReLU(),
                                     nn.Conv2d(18, 18, 3, padding=2, dilation=2), nn.ReLU(),
                                     nn.Conv2d(18, 18, 3, padding=3, dilation=3), nn.ReLU())
        self.decode = nn.Sequential(nn.Conv2d(30, 12, 3, padding=1), nn.ReLU(), nn.Conv2d(12, 3, 1))

    def forward(self, image):
        near = self.near(image)
        wider = F.interpolate(self.context(near), size=near.shape[-2:], mode="bilinear", align_corners=False)
        out = self.decode(torch.cat((near, wider), 1))
        return F.interpolate(out, size=image.shape[-2:], mode="bilinear", align_corners=False)


def normalized(rgb):
    return torch.from_numpy(np.ascontiguousarray(rgb)).permute(0, 3, 1, 2).float() / 255


def load_split(root, manifest, name):
    raw = (root / (name + ".raw")).read_bytes()
    count = sum(g["count"] for g in manifest["groups"] if g["split"] == name)
    values = np.frombuffer(raw, np.uint8).reshape(count, SIZE[1], SIZE[0], 4)
    classes = values[..., 3].copy()
    if set(np.unique(classes).tolist()) != set(range(len(LABELS))):
        raise ValueError(f"Invalid rendered classes in {name}")
    return normalized(values[..., :3]), torch.from_numpy(classes).long(), hashlib.sha256(raw).hexdigest()


@torch.inference_mode()
def evaluate(model, data):
    images, labels, _ = data
    model.eval()
    matrix = torch.zeros((3, 3), dtype=torch.long)
    for x, y in zip(images.split(12), labels.split(12)):
        matrix += torch.bincount((y * 3 + model(x).argmax(1)).flatten(), minlength=9).reshape(3, 3)
    inter = matrix.diag()
    iou = inter / (matrix.sum(0) + matrix.sum(1) - inter).clamp(min=1)
    return {"images": len(images), "confusion_true_by_pred": matrix.tolist(), "iou": iou.tolist(),
            "foreground_miou": float(iou[1:].mean())}


def train(corpus, output, epochs):
    if epochs < 1:
        raise ValueError("epochs must be positive")
    output.mkdir(parents=True, exist_ok=False)
    start = time.perf_counter()
    manifest = json.loads((corpus / "manifest.json").read_text())
    torch.set_num_threads(2)
    torch.manual_seed(2701)
    torch.use_deterministic_algorithms(True)
    data = {s: load_split(corpus, manifest, s) for s in ("train", "val", "test")}
    images, labels, _ = data["train"]
    model = CampusNet()
    weight = torch.tensor([.25, 2.5, 2.5])
    optimizer = torch.optim.AdamW(model.parameters(), lr=.003)
    config = {"model": "campus-segments-v1", "seed": 2701, "classes": LABELS, "cpu_threads": 2,
              "batch": 12, "epochs": epochs, "optimizer": "AdamW", "learning_rate": .003,
              "loss": "weighted cross-entropy + foreground soft Dice", "groups": manifest["groups"],
              "corpus_rgb_mask_sha256": {s: item[2] for s, item in data.items()},
              "parameters": sum(p.numel() for p in model.parameters()), "torch": str(torch.__version__),
              "selection": "highest validation foreground mean IoU, earliest tie"}
    write_json(output / "config.json", config)
    best = -1
    history = []
    for epoch in range(1, epochs + 1):
        model.train()
        loss_sum = 0
        for indices in torch.randperm(len(images)).split(12):
            x, y = images[indices], labels[indices]
            if torch.rand(()) > .5:
                x, y = x.flip((-1,)), y.flip((-1,))
            x = (x * (.84 + .32 * torch.rand(())) + .035 * (torch.rand(()) - .5)).clamp(0, 1)
            logits = model(x)
            pred = logits.softmax(1)[:, 1:]
            truth = F.one_hot(y, 3).permute(0, 3, 1, 2)[:, 1:]
            overlap = (2 * (pred * truth).sum((0, 2, 3)) + 1) / ((pred + truth).sum((0, 2, 3)) + 1)
            loss = F.cross_entropy(logits, y, weight=weight) + 1 - overlap.mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 4)
            optimizer.step()
            loss_sum += float(loss.detach()) * len(indices)
        score = evaluate(model, data["val"])["foreground_miou"]
        history.append({"epoch": epoch, "loss": loss_sum / len(images), "val_foreground_miou": score})
        ckpt = {"epoch": epoch, "labels": LABELS, "model": model.state_dict()}
        if epoch == 1:
            save_weights(output / "first.pt", ckpt)
        if score > best:
            save_weights(output / "best.pt", ckpt)
            best = score
        print(f"epoch {epoch:02}  validation foreground mIoU {score:.3f}", flush=True)
    chosen = torch.load(output / "best.pt", map_location="cpu", weights_only=True)
    model.load_state_dict(chosen["model"])
    result = {**config, "history": history, "best_epoch": chosen["epoch"], "validation": evaluate(model, data["val"]),
              "held_out_test": evaluate(model, data["test"]), "wall_seconds": time.perf_counter() - start,
              "weights_sha256": hashlib.sha256((output / "best.pt").read_bytes()).hexdigest()}
    write_json(output / "result.json", result)


class SemanticReader:
    def __init__(self, weights):
        model = CampusNet()
        checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
        if tuple(checkpoint["labels"]) != LABELS:
            raise ValueError("Incompatible campus segmentation model")
        model.load_state_dict(checkpoint["model"])
        self.model = model.eval()

    @torch.inference_mode()
    def inspect(self, bgr, depth):
        if not has_texture(bgr):
            return []
        small = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), SIZE, interpolation=cv2.INTER_AREA)
        scores = self.model(normalized(small[None])).softmax(1)[0].numpy()
        return region_geometry(scores,depth)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=24)
    args = parser.parse_args()
    train(args.corpus, args.output, args.epochs)
