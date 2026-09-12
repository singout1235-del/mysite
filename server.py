#!/usr/bin/env python3
"""
NIM Studio — local server + NVIDIA API proxy.

Run:      python3 server.py  [port]
Open:     http://localhost:8000  (or http://<your-ip>:8000 on your LAN)

Why?      Browsers sometimes block direct calls from a webpage to
          integrate.api.nvidia.com (CORS). This tiny dependency-free
          server serves the site AND forwards /proxy/* requests to the
          NVIDIA API with streaming support, so everything works.
"""
import os
import sys
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://integrate.api.nvidia.com"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8000"))
HOST = "0.0.0.0"

FORWARD_HEADERS = {"authorization", "content-type", "accept"}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path.startswith("/proxy/"):
            self.proxy()
        elif self.path == "/healthz":
            self._send_bytes(200, b"ok", "text/plain")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/proxy/"):
            self.proxy()
        else:
            self.send_error(405, "Method Not Allowed")

    def do_OPTIONS(self):
        if self.path.startswith("/proxy/"):
            self.send_response(204)
            self._cors()
            self.send_header("Allow", "GET, POST, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_error(405, "Method Not Allowed")

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[nim-studio] %s\n" % (fmt % args))

    # ---------- helpers ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send_bytes(self, status, data, content_type):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def proxy(self):
        target = UPSTREAM + self.path[len("/proxy"):]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target, data=body, method=self.command)
        for key in FORWARD_HEADERS:
            val = self.headers.get(key)
            if val:
                req.add_header(key, val)
        req.add_header("Accept-Encoding", "identity")

        try:
            resp = urllib.request.urlopen(req, timeout=900)
            status, headers, stream = resp.status, resp.headers, resp
        except urllib.error.HTTPError as e:
            status, headers, stream = e.code, e.headers, e
        except Exception as e:
            self._send_bytes(502, ('{"error":{"message":"Proxy error: %s"}}'
                                   % str(e).replace('"', "'")).encode(),
                             "application/json")
            return

        self.send_response(status)
        self._cors()
        ctype = headers.get("Content-Type") or "application/json"
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        # Stream back: no Content-Length (use connection close semantics)
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            while True:
                chunk = stream.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("=" * 56)
    print("  NIM Studio is running")
    print("  Local:   http://localhost:%d" % PORT)
    print("  LAN:     http://<this-device-ip>:%d" % PORT)
    print("  NVIDIA requests are proxied via /proxy/*")
    print("=" * 56)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
