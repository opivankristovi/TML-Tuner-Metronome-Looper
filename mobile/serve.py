#!/usr/bin/env python3
"""Development server for iRig Lab Mobile.

    python3 serve.py            http://localhost:8766 (this computer only)
    python3 serve.py --https    https://<this computer's IP>:8766 for phones on the same Wi-Fi

Phones only allow the microphone on HTTPS pages. --https creates a self-signed certificate
(in .cert/); the phone shows a warning once, which you accept to continue.
COOP/COEP headers are sent so the loop station can use shared memory.
"""
import functools
import http.server
import os
import socket
import ssl
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8766


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json", ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def log_message(self, *args):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def certificate(ip):
    d = os.path.join(ROOT, ".cert")
    cert, key = os.path.join(d, "cert.pem"), os.path.join(d, "key.pem")
    if not os.path.exists(cert):
        os.makedirs(d, exist_ok=True)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
                        "-keyout", key, "-out", cert, "-subj", "/CN=iRig Lab dev",
                        "-addext", f"subjectAltName=IP:{ip},DNS:localhost"], check=True, capture_output=True)
    return cert, key


if __name__ == "__main__":
    https = "--https" in sys.argv
    host = "0.0.0.0" if https else "127.0.0.1"
    server = http.server.ThreadingHTTPServer((host, PORT), functools.partial(Handler, directory=ROOT))
    if https:
        ip = lan_ip()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*certificate(ip))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        print(f"iRig Lab Mobile on https://{ip}:{PORT}/  (open it on your phone, accept the certificate warning)")
    else:
        print(f"iRig Lab Mobile on http://localhost:{PORT}/")
    server.serve_forever()
