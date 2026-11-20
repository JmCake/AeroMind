"""Offline classroom desktop server. Only the browser shell and its public assets are served."""

import argparse
import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import cv2
import torch

from .lesson import DEFAULT_WEIGHTS, ROOT
from .observations import ImageService
from .vision import Perception


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
            return self.send_json(200, {"model":"parcel-display-v1","device":"CPU",
                                        "torch":str(torch.__version__),"opencv":cv2.__version__})
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
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    if not (PUBLIC["/three/"]/"three.module.js").is_file():
        raise SystemExit("Run npm ci in the project directory to install Three.js.")
    torch.set_num_threads(2)
    cv2.setNumThreads(2)
    class LocalServer(ThreadingHTTPServer):
        request_queue_size = 64
    with LocalServer(("127.0.0.1", args.port), Classroom) as server:
        server.vision = ImageService(Perception(DEFAULT_WEIGHTS))
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
