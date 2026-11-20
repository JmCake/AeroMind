"""Condense actual desktop exports without screenshots, synthetic metrics or averages of percentiles."""

import argparse
import csv
import hashlib
import json
from pathlib import Path


def essential_unit(unit, version):
    record = {key:value for key,value in unit.items() if key not in ("trajectory","evaluation_samples","visual_loop_closures")}
    if version < 3:
        # v2 sampled the instant the vision response was parsed, before control.
        for quantile in ("p50", "p95"):
            old_key = f"camera_to_decision_{quantile}_ms"
            if old_key in record:
                record[f"camera_to_vision_result_{quantile}_ms"] = record.pop(old_key)
    return record


def summarize(name, file):
    raw=file.read_bytes()
    data=json.loads(raw)
    version=data.get("format",2)
    keys=("format","source","timing_boundary","inference_backend","browser","gpu","viewport","resolution","sensor","physics_hz","sensor_target_hz",
          "mean_fps","frame_time_p95_ms","failed_frame_requests","js_heap_bytes","render_pixel_ratio",
          "model_sha256","segmentation_sha256","policy_sha256","options","orders")
    record={"name":name,"export_sha256":hashlib.sha256(raw).hexdigest(),
            **{k:data[k] for k in keys if k in data},"units":[essential_unit(u,version) for u in data["units"]],
            "events":data["events"],"keyframe_count":len(data["keyframes"])}
    if not data["options"].get("gps",True):
        record["localization_samples"]=[u.get("evaluation_samples",[])[::8] for u in data["units"]]
        record["loop_closures"]=[u.get("visual_loop_closures",[]) for u in data["units"]]
    if data.get("communications"):
        record["communications"]=[{k:v for k,v in m.items() if k!="cells"}|{"voxel_count":len(m.get("cells",[]))}
                                  for m in data["communications"]]
    if data.get("experiment"):
        exp=data["experiment"]
        record["experiment"]={k:v for k,v in exp.items() if k!="branches"}
        record["experiment"]["branches"]=[{k:v for k,v in b.items() if k not in ("events","keyframes","metrics")}
            |{"metrics":essential_unit(b["metrics"],version),"events":b["events"],"keyframes":len(b["keyframes"])}
            for b in exp["branches"]]
    return record


def sampled_memory(file):
    with file.open(encoding="utf-8-sig", newline="") as stream:
        samples = list(csv.DictReader(stream))
    if not samples:
        raise ValueError("The Windows process sampler did not capture any observations")
    fields = ("edge_private_bytes", "inference_private_bytes", "inference_working_set_bytes")
    return {
        "sample_count": len(samples),
        "first_utc": samples[0]["utc"], "last_utc": samples[-1]["utc"],
        "csv_sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
        "ranges": {
            key: [min(int(s[key]) for s in samples), max(int(s[key]) for s in samples)] for key in fields
        },
    }


def lecture_details(file):
    rows = json.loads(file.read_bytes())
    for row in rows:
        raw = (file.parent / f"lecture-{row['run']}.json").read_bytes()
        lecture = json.loads(raw)
        row["export_sha256"] = hashlib.sha256(raw).hexdigest()
        row["stage_results"] = [
            {"title": stage["title"], "sim_time": stage["sim_time"],
             "observed_frames": stage["observed_frames"],
             "outcomes": [u["phase"] for u in stage["results"]],
             "contacts": [u["contacts"] for u in stage["results"]]}
            for stage in lecture["lecture"]["stages"]
        ]
        experiment = lecture.get("experiment")
        if experiment:
            row["comparison"] = {
                "factor": experiment["factor"], "fixed_event": experiment["fixed_event"],
                "branches": [
                    {k: branch[k] for k in ("label", "snapshot_tick", "shared_frame", "initial_position_error_m", "seed_at_fork")}
                    | {k: branch["metrics"][k] for k in ("outcome", "delivered", "length_m", "wait_s", "contacts")}
                    for branch in experiment["branches"]
                ],
            }
    return rows


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output",type=Path)
    parser.add_argument("runs",nargs="+",help="case-name=path-to-export")
    parser.add_argument("--lecture",type=Path)
    parser.add_argument("--memory",type=Path)
    parser.add_argument("--bundle",type=Path)
    parser.add_argument("--controls",type=Path)
    args=parser.parse_args()
    report={"device":"Core Ultra 5 125H / Intel Arc integrated / Windows / 31.6 GiB RAM",
            "runs":[summarize(k,Path(v)) for k,v in (entry.split("=",1) for entry in args.runs)]}
    if args.lecture:
        report["rehearsals"] = lecture_details(args.lecture)
    if args.memory:
        report["windows_process_memory"] = sampled_memory(args.memory)
    if args.bundle:
        report["tested_distribution"] = {
            "file": args.bundle.name, "bytes": args.bundle.stat().st_size,
            "sha256": hashlib.sha256(args.bundle.read_bytes()).hexdigest(),
        }
    if args.controls:
        report["interactive_controls"] = json.loads(args.controls.read_bytes())
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
