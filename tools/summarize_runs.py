"""Condense actual desktop exports without screenshots, synthetic metrics or averages of percentiles."""

import argparse
import hashlib
import json
from pathlib import Path


def essential_unit(unit):
    return {key:value for key,value in unit.items() if key not in ("trajectory","evaluation_samples","visual_loop_closures")}


def summarize(name, file):
    raw=file.read_bytes()
    data=json.loads(raw)
    keys=("source","inference_backend","browser","gpu","viewport","resolution","sensor","physics_hz","sensor_target_hz",
          "mean_fps","frame_time_p95_ms","failed_frame_requests","js_heap_bytes","render_pixel_ratio",
          "model_sha256","segmentation_sha256","policy_sha256","options","orders")
    record={"name":name,"export_sha256":hashlib.sha256(raw).hexdigest(),
            **{k:data[k] for k in keys if k in data},"units":[essential_unit(u) for u in data["units"]],
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
            |{"metrics":essential_unit(b["metrics"]),"events":b["events"],"keyframes":len(b["keyframes"])}
            for b in exp["branches"]]
    return record


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output",type=Path)
    parser.add_argument("runs",nargs="+",help="case-name=path-to-export")
    parser.add_argument("--lecture",type=Path)
    args=parser.parse_args()
    report={"device":"Core Ultra 5 125H / Intel Arc integrated / Windows / 31.6 GiB RAM",
            "runs":[summarize(k,Path(v)) for k,v in (entry.split("=",1) for entry in args.runs)]}
    if args.lecture:
        report["rehearsals"]=json.loads(args.lecture.read_bytes())
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
