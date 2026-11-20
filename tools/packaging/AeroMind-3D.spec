from importlib.metadata import distribution
from pathlib import Path
import sys

root=Path(SPECPATH).resolve().parents[1]
vendor=root/"node_modules/three"
data=[(str(root/"web"),"web"),(str(root/"ContentSource"),"ContentSource"),
      (str(root/"evidence/campus-segments-v1.json"),"evidence"),(str(vendor/"LICENSE"),"licenses/three")]
for name in ("parcel-display-v1","campus-segments-v1","campus-segments-epoch1"):
    data.append((str(root/"models"/(name+".onnx")),"models"))
for asset in ("build/three.core.js","build/three.module.js","examples/jsm/loaders/GLTFLoader.js",
              "examples/jsm/controls/OrbitControls.js","examples/jsm/utils/SkeletonUtils.js","examples/jsm/utils/BufferGeometryUtils.js"):
    data.append((str(vendor/asset),str(Path("node_modules/three")/Path(asset).parent)))
for dependency in ("numpy","opencv-python","pyinstaller"):
    dist=distribution(dependency)
    for file in dist.files or ():
        if ".dist-info" in str(file) and "license" in file.name.lower():
            data.append((str(dist.locate_file(file)),"licenses/"+dependency))
license=Path(sys.base_prefix)/"LICENSE.txt"
if license.exists():
    data.append((str(license),"licenses/python"))

a=Analysis([str(root/"tools/packaging/desktop.py")],pathex=[str(root)],datas=data,
           excludes=["torch","onnx","aeromind.vision","aeromind.segments","scipy","matplotlib","pandas","tkinter","PySide6","PyQt6"])
pyz=PYZ(a.pure)
exe=EXE(pyz,a.scripts,[],exclude_binaries=True,name="AeroMind-3D",console=True,upx=False)
coll=COLLECT(exe,a.binaries,a.datas,name="AeroMind-3D",upx=False)
