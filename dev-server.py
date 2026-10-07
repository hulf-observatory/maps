#!/usr/bin/env python3
"""Local dev server for the Spatial Data Repository map viewer (stdlib only).

  python3 dev-server.py                      # viewer on http://127.0.0.1:8124/
  python3 dev-server.py --published PATH     # use another published/ folder
  python3 dev-server.py --fixture            # use the small test fixture in check/fixture

Mirrors production nginx:
  /             -> static viewer files (this folder)
  /layers.json  -> <published>/layers.json
  /*.legend.json and /nav/*.json -> <published>/<same path>  (baked legends, breadcrumb areas)
  /legends/*.webp -> <published>/legends/  (legend pictures cut from the scanned land-use sheets)
  /tiles/*      -> reverse proxy to pmtiles serve on 127.0.0.1:<tiles-port>
pmtiles serve is started as a child process if nothing is listening on that port.
"""
import argparse, atexit, http.client, http.server, os, shutil, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PUBLISHED = os.path.normpath(os.path.join(HERE, "..", "..", "observatory-data", "published"))

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8124)
ap.add_argument("--tiles-port", type=int, default=None)
ap.add_argument("--published", default=os.environ.get("PUBLISHED_DIR", DEFAULT_PUBLISHED))
ap.add_argument("--fixture", action="store_true", help="serve check/fixture instead of published/")
ap.add_argument("--quiet", action="store_true")
args = ap.parse_args()
if args.fixture:
    args.published = os.path.join(HERE, "check", "fixture")
if args.tiles_port is None:
    args.tiles_port = 8082 if args.fixture else 8081  # fixture never collides with the real tile server
PUBLISHED = os.path.abspath(args.published)


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_pmtiles():
    if port_open(args.tiles_port):
        print(f"tiles: using existing server on 127.0.0.1:{args.tiles_port}")
        return
    exe = shutil.which("pmtiles")
    serve_dir = os.path.join(PUBLISHED, "serve")
    if not exe:
        print("tiles: 'pmtiles' not found on PATH; /tiles/ will return 502", file=sys.stderr)
        return
    if not os.path.isdir(serve_dir):
        print(f"tiles: {serve_dir} does not exist yet; /tiles/ will return 502", file=sys.stderr)
        return
    p = subprocess.Popen([exe, "serve", serve_dir, "--interface=127.0.0.1", f"--port={args.tiles_port}", "-q"])
    atexit.register(p.terminate)
    for _ in range(50):
        if port_open(args.tiles_port):
            break
        time.sleep(0.1)
    print(f"tiles: started pmtiles serve {serve_dir} on 127.0.0.1:{args.tiles_port}")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *a):
        if not args.quiet:
            super().log_message(fmt, *a)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        if not self.path.startswith("/tiles/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/layers.json":
            return self.send_layers()
        if path.endswith(".legend.json") or (path.startswith("/nav/") and path.endswith(".json")):
            return self.send_published(path)
        if path.startswith("/legends/") and path.endswith(".webp") and path.count("/") == 2:
            return self.send_published(path, "image/webp")
        if path.startswith("/tiles/"):
            return self.proxy_tiles()
        # never expose dev-only files
        if path.startswith(("/check", "/nginx", "/dev-server", "/.claude", "/screenshots")) or path.endswith(".pmtiles"):
            return self.send_error(404)
        return super().do_GET()

    def send_layers(self):
        f = os.path.join(PUBLISHED, "layers.json")
        if not os.path.isfile(f):
            body = b'{"schema":1,"groups":[],"layers":[],"failed":[]}'
        else:
            with open(f, "rb") as fh:
                body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_published(self, path, ctype="application/json"):
        """Serve a small file that sits beside layers.json in <published> (the JSON legends for
        layers baked by another pipeline, breadcrumb areas, legend pictures). Never serves tiles."""
        rel = os.path.normpath(path.lstrip("/"))
        f = os.path.join(PUBLISHED, rel)
        if os.path.commonpath([os.path.abspath(f), PUBLISHED]) != PUBLISHED or not os.path.isfile(f):
            return self.send_error(404)
        with open(f, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_tiles(self):
        upstream = self.path[len("/tiles"):]
        try:
            c = http.client.HTTPConnection("127.0.0.1", args.tiles_port, timeout=15)
            c.request("GET", upstream)
            r = c.getresponse()
            body = r.read()
        except OSError:
            return self.send_error(502, "tile server unavailable")
        self.send_response(r.status)
        for k in ("Content-Type", "Content-Encoding", "Cache-Control", "ETag"):
            v = r.getheader(k)
            if v:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser cancelled the tile request


if __name__ == "__main__":
    print(f"published: {PUBLISHED}")
    ensure_pmtiles()
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
                super().handle_error(request, client_address)

    srv = Server(("127.0.0.1", args.port), Handler)
    print(f"viewer: http://127.0.0.1:{args.port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
