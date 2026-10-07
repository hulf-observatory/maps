#!/usr/bin/env python3
"""Plain static server for local work on the viewer (stdlib only).

  python3 dev-server.py                 # http://127.0.0.1:8124/
  python3 dev-server.py --port 8130

The viewer reads its data from DATA_BASE (js/config.js), so nothing is proxied or
mapped here: this only serves the files in this folder with no-cache headers.
`python3 -m http.server 8124` does the same job without the headers.
To point the page at other data, open it with ?data=<url or path>, e.g.
  http://127.0.0.1:8124/?data=check/fixture/
"""
import argparse, http.server, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8124)
ap.add_argument("--quiet", action="store_true")
args = ap.parse_args()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                      ".pbf": "application/x-protobuf", ".woff2": "font/woff2", ".webp": "image/webp"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *a):
        if not args.quiet:
            super().log_message(fmt, *a)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            super().handle_error(request, client_address)


if __name__ == "__main__":
    srv = Server(("127.0.0.1", args.port), Handler)
    print(f"viewer: http://127.0.0.1:{args.port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
