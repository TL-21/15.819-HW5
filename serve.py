"""Start the Uber NYC Ops Center dashboard.
Run:  python serve.py
Then open: http://localhost:8050
"""
import http.server, socketserver, os, webbrowser, threading

PORT = 8050
DIR  = os.path.join(os.path.dirname(__file__), "static")

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass   # silence per-request logs
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

os.chdir(DIR)
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    url = f"http://localhost:{PORT}"
    print(f"  Uber NYC Ops Center  →  {url}")
    print("  Ctrl-C to stop.\n")
    threading.Timer(1, lambda: webbrowser.open(url)).start()
    httpd.serve_forever()
