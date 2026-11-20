"""Train and audit the parcel-display classifier on grouped procedural images."""

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import torch

from . import stations, vision
from .stations import LABELS, SETTINGS, STATIONS, photograph
from .vision import DisplayNet, PanelReader, tensors


def write_json(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", "utf8")
    temp.replace(path)


def save_weights(path, payload):
    temp = path.with_suffix(".tmp")
    torch.save(payload, temp)
    os.replace(temp, path)


def sample_split(split, views, seed):
    reader = PanelReader()
    data, targets, manifest = [], [], []
    misses = [0] * len(LABELS)
    digest = hashlib.sha256()
    split_index = list(SETTINGS).index(split)
    for group, setting in enumerate(SETTINGS[split]):
        for label, name in enumerate(LABELS):
            for view in range(views):
                sub_seed = int(np.random.SeedSequence([seed, split_index, group, label, view])
                               .generate_state(1)[0])
                station = tuple(STATIONS)[view % len(STATIONS)]
                image = photograph(station, name, setting, sub_seed)
                digest.update(image.tobytes())
                patches = list(reader.patches(image))
                found = len(patches) == 1 and patches[0][0] == station
                manifest.append([setting.name, name, station, sub_seed, found])
                if found:
                    data.append(patches[0][1])
                    targets.append(label)
                else:
                    misses[label] += 1
    if len(set(targets)) != len(LABELS):
        raise RuntimeError(f"Insufficient readable samples in {split}")
    return tensors(data), torch.tensor(targets), manifest, digest.hexdigest(), misses


@torch.inference_mode()
def evaluate(model, split):
    data, truth, manifest, _, misses = split
    model.eval()
    predictions = model(data).argmax(1)
    matrix = torch.bincount(truth * len(LABELS) + predictions, minlength=len(LABELS) ** 2)
    matrix = matrix.reshape(len(LABELS), len(LABELS))
    correct = int(matrix.diag().sum())
    return {"images": len(manifest), "rectified": len(truth), "missing_by_class": misses,
            "confusion_true_by_pred": matrix.tolist(), "correct": correct,
            "end_to_end_accuracy": correct / len(manifest)}


def train(output, epochs, views, seed):
    if min(epochs, views) < 1 or seed < 0:
        raise ValueError("epochs and views must be positive and seed nonnegative")
    start = time.perf_counter()
    output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(2)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    per_split = {"train": views, "val": max(4, views // 2), "test": max(4, views // 2)}
    splits = {key: sample_split(key, count, seed) for key, count in per_split.items()}
    model = DisplayNet()
    config = {
        "name": "parcel-display-v1", "started_utc": datetime.now(timezone.utc).isoformat(),
        "data_type": "procedural sign photographs", "seed": seed, "epochs": epochs,
        "python": platform.python_version(), "torch": str(torch.__version__), "opencv": cv2.__version__,
        "numpy": np.__version__, "device": "cpu", "threads": torch.get_num_threads(),
        "labels": list(LABELS), "batch": 32, "optimizer": "AdamW", "lr": .003,
        "weight_decay": .01, "loss": "cross_entropy", "precision": "float32",
        "select": "highest validation end-to-end accuracy; earliest epoch wins ties",
        "evaluation": "argmax; missing panel counts as incorrect for each label",
        "parameters": sum(p.numel() for p in model.parameters()),
        "input": [1, stations.PATCH_SIZE, stations.PATCH_SIZE], "command": sys.argv[1:],
        "source_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in [Path(__file__), Path(stations.__file__), Path(vision.__file__)]},
        "splits": {key: {"groups": [g.name for g in SETTINGS[key]], "images": len(value[2]),
                         "frames_sha256": value[3]} for key, value in splits.items()},
    }
    write_json(output / "config.json", config)
    (output / "run_config.txt").write_text(json.dumps(config, ensure_ascii=False, indent=2), "utf8")
    write_json(output / "samples.json", {k: v[2] for k, v in splits.items()})
    data, labels = splits["train"][:2]
    optimizer = torch.optim.AdamW(model.parameters(), lr=config["lr"], weight_decay=config["weight_decay"])
    best = -1
    history = []
    for epoch in range(1, epochs + 1):
        model.train()
        begin = time.perf_counter()
        total_loss = 0.
        steps = 0
        for indices in torch.randperm(len(data)).split(config["batch"]):
            optimizer.zero_grad(set_to_none=True)
            loss = torch.nn.functional.cross_entropy(model(data[indices]), labels[indices])
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * len(indices)
            steps += 1
        changed = time.perf_counter()
        metrics = evaluate(model, splits["val"])
        assessed = time.perf_counter()
        history.append({"epoch": epoch, "loss": total_loss / len(data), "steps": steps,
                        "train_seconds": changed - begin, "val_seconds": assessed - changed,
                        "samples_per_second": len(data) / (changed - begin), "validation": metrics})
        payload = {"format": 1, "labels": list(LABELS), "epoch": epoch, "model": model.state_dict()}
        if metrics["end_to_end_accuracy"] > best:
            best = metrics["end_to_end_accuracy"]
            save_weights(output / "best.pt", payload)
        save_weights(output / "latest.pt", {**payload, "optimizer": optimizer.state_dict(),
                                            "rng": torch.get_rng_state()})
        write_json(output / "history.json", history)
    chosen = torch.load(output / "best.pt", weights_only=True, map_location="cpu")
    model.load_state_dict(chosen["model"])
    result = {"scope": config["data_type"], "labels": config["labels"], "splits": config["splits"],
              "epochs": epochs, "best_epoch": chosen["epoch"], "seed": seed,
              "best_weights_sha256": hashlib.sha256((output / "best.pt").read_bytes()).hexdigest(),
              "validation": evaluate(model, splits["val"]), "test": evaluate(model, splits["test"]),
              "first_loss": history[0]["loss"], "last_loss": history[-1]["loss"],
              "wall_seconds": time.perf_counter() - start}
    write_json(output / "result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New directory for this run")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--views", type=int, default=28, help="Training views per group and class")
    parser.add_argument("--seed", type=int, default=1407)
    args = parser.parse_args()
    train(args.output, args.epochs, args.views, args.seed)
