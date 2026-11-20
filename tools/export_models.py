"""Export exactly the shipped PyTorch checkpoints and verify raw CPU logits."""

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import torch

from aeromind.segments import CampusNet
from aeromind.vision import DisplayNet


def export(output,corpus):
    from aeromind.portable import OpenCVNetwork
    root=Path(__file__).resolve().parents[1]
    images=np.fromfile(corpus/"test.raw",np.uint8).reshape(-1,90,160,4)[...,:3].copy()
    torch.set_num_threads(2)
    cv2.setNumThreads(2)
    result={}
    for name in ("parcel-display-v1","campus-segments-v1","campus-segments-epoch1"):
        path=root/"models"/(name+".pt")
        panel=name.startswith("parcel")
        net=DisplayNet() if panel else CampusNet()
        net.load_state_dict(torch.load(path,map_location="cpu",weights_only=True)["model"]);net.eval()
        sample=torch.zeros((1,1,40,40) if panel else (1,3,90,160))
        target=output/(name+".onnx")
        torch.onnx.export(net,sample,str(target),dynamo=False,opset_version=17,input_names=["image"],output_names=["logits"])
        other=OpenCVNetwork(target)
        peak=0.;agreement=0;count=0
        for rgb in images:
            if panel:
                # Include real display patches as well as contrasting background.
                tile=cv2.resize(cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY),(40,40),interpolation=cv2.INTER_AREA)
                value=tile[None,None].astype(np.float32)/255
            else:
                value=rgb.transpose(2,0,1)[None].astype(np.float32)/255
            with torch.inference_mode():
                expected=net(torch.from_numpy(value)).numpy()
            actual=other.predict(value)
            peak=max(peak,float(np.abs(expected-actual).max()))
            agreement+=int((expected.argmax(1)==actual.argmax(1)).sum());count+=expected.argmax(1).size
        result[name]={"torch_sha256":hashlib.sha256(path.read_bytes()).hexdigest(),
                      "onnx_sha256":hashlib.sha256(target.read_bytes()).hexdigest(),"frames":len(images),
                      "max_abs_logit_error":peak,"argmax_agree":agreement,"argmax_total":count}
        if peak>.002 or agreement/count<.9999:
            raise RuntimeError(f"Portable model verification failed for {name}: {result[name]}")
    (root/"evidence/portable-models.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf8")
    print(json.dumps(result,indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus",type=Path);parser.add_argument("--output",type=Path,default=Path("models"))
    opts=parser.parse_args();export(opts.output,opts.corpus)
