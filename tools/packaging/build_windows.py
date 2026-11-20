"""Build a portable desktop folder and ZIP with a Python that has PyInstaller, cv2 and numpy."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[2]


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python",default=sys.executable,help="Packaging Python interpreter")
    args=parser.parse_args()
    builds=ROOT/".local/portable-build";builds.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(dir=builds))
    subprocess.run([args.python,"-m","PyInstaller","--distpath",str(stage/"dist"),"--workpath",str(stage/"work"),
                    "--log-level","WARN",str(ROOT/"tools/packaging/AeroMind-3D.spec")],cwd=ROOT,check=True)
    build=stage/"dist/AeroMind-3D"
    if not (build/"AeroMind-3D.exe").is_file():
        raise RuntimeError("Missing packaged executable")
    result=ROOT/"dist";result.mkdir(exist_ok=True)
    archive=Path(shutil.make_archive(str(stage/"AeroMind-3D-Windows-x64"),"zip",build.parent,build.name))
    target=result/archive.name
    archive.replace(target)
    print(f"{target}  SHA256 {hashlib.sha256(target.read_bytes()).hexdigest()}",flush=True)
    print(build/"AeroMind-3D.exe",flush=True)
