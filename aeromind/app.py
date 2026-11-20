"""Offline classroom desktop server. Only the browser shell and its public assets are served."""

import argparse
import errno
import hashlib
import json
import mimetypes
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

import cv2

from .observations import ImageService


ROOT=Path(__file__).resolve().parents[1]
PUBLIC = {"/app/": ROOT/"web", "/assets/": ROOT/"ContentSource",
          "/three/": ROOT/"node_modules/three/build", "/addons/": ROOT/"node_modules/three/examples/jsm"}


class Classroom(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *args):
        if args and len(args) > 1 and str(args[1]).startswith(("4","5")):
            super().log_message(fmt, *args)

    def send_bytes(self, code, mime, value):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(value)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(value)

    def send_json(self, status, data):
        self.send_bytes(status, "application/json; charset=utf-8",
                        json.dumps(data, ensure_ascii=False, allow_nan=False).encode())

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/health":
            return self.send_json(200,self.server.health)
        if path == "/api/learning":
            return self.send_bytes(200,"application/json; charset=utf-8",
                                   (ROOT/"evidence/campus-segments-v1.json").read_bytes())
        if path == "/":
            path = "/app/index.html"
        for prefix, directory in PUBLIC.items():
            if path.startswith(prefix):
                file = (directory/path[len(prefix):]).resolve()
                if file.is_relative_to(directory.resolve()) and file.is_file():
                    mime = {".js":"text/javascript", ".glb":"model/gltf-binary"}.get(file.suffix)
                    return self.send_bytes(200, mime or mimetypes.guess_type(file.name)[0]
                                           or "application/octet-stream", file.read_bytes())
        self.send_json(404, {"error":"Asset not found"})

    def do_POST(self):
        if self.path not in ("/api/frame","/api/fork"):
            return self.send_json(404, {"error":"Unknown endpoint"})
        origin = self.headers.get("Origin")
        if origin and origin not in (self.server.origin, self.server.origin.replace("127.0.0.1","localhost")):
            return self.send_json(403, {"error":"Local classroom origin required"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 4 < length <= 1_390_000:
                raise ValueError("Invalid frame length")
            self.connection.settimeout(6)
            if self.path == "/api/fork":
                if length > 1024:
                    raise ValueError("Invalid fork request")
                body = json.loads(self.rfile.read(length))
                data = self.server.vision.fork(body["source"],body["target"])
            else:
                data = self.server.vision.process(self.rfile.read(length))
        except (KeyError, ValueError, TypeError, TimeoutError, cv2.error) as exc:
            return self.send_json(400, {"error":str(exc)})
        self.send_json(200, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8863)
    parser.add_argument("--open", action="store_true")
    parser.add_argument("--backend",choices=("torch","opencv"),default="opencv" if getattr(sys,"frozen",False) else "torch")
    args = parser.parse_args()
    if not (PUBLIC["/three/"]/"three.module.js").is_file():
        raise SystemExit("Run npm ci in the project directory to install Three.js.")
    cv2.setNumThreads(2)
    class LocalServer(ThreadingHTTPServer):
        request_queue_size = 64
        allow_reuse_address = not hasattr(socket, "SO_EXCLUSIVEADDRUSE")
        def server_bind(self):
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            super().server_bind()
    try:
        desktop = LocalServer(("127.0.0.1", args.port), Classroom)
    except OSError as exc:
        if exc.errno not in (errno.EADDRINUSE, 10048, 10013):
            raise
        address = f"http://127.0.0.1:{args.port}"
        try:
            with urlopen(address+"/api/health",timeout=2) as response:
                own = json.load(response).get("application") == "JmCake/AeroMind/3D"
        except (OSError,ValueError,AttributeError):
            own = False
        if not own:
            raise SystemExit(f"Port {args.port} is in use. Select a different --port.") from exc
        print(f"AeroMind is already running at {address}",flush=True)
        if args.open:
            webbrowser.open(address)
        return
    with desktop as server:
        health={"application":"JmCake/AeroMind/3D","model":"parcel-display-v1","device":"CPU",
                "backend":args.backend,"opencv":cv2.__version__}
        if args.backend=="torch":
            import torch
            from .segments import SemanticReader
            from .vision import Perception
            torch.set_num_threads(2)
            health["torch"]=str(torch.__version__)
            suffix=".pt"
        else:
            from .portable import PortablePanels as Perception, PortableSegments as SemanticReader
            suffix=".onnx"
        checkpoints={key:ROOT/"models"/(name+suffix) for key,name in
                     (("selected","campus-segments-v1"),("early","campus-segments-epoch1"))}
        panels=ROOT/"models"/("parcel-display-v1"+suffix)
        server.vision=ImageService(Perception(panels),{key:SemanticReader(p) for key,p in checkpoints.items()})
        server.health={**health,"weights_sha256":hashlib.sha256(panels.read_bytes()).hexdigest(),
                       "segmentation_sha256":{key:hashlib.sha256(p.read_bytes()).hexdigest() for key,p in checkpoints.items()}}
        server.origin = f"http://127.0.0.1:{server.server_port}"
        print(f"AeroMind  {server.origin}", flush=True)
        if args.open:
            threading.Timer(.3, webbrowser.open, args=(server.origin,)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
