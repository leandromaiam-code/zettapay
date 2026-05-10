from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlsplit


@dataclass
class RecordedRequest:
    method: str
    path: str
    headers: Dict[str, str]
    query: Dict[str, List[str]]
    body: bytes


Handler = Callable[[RecordedRequest], Tuple[int, Optional[Any], Optional[Dict[str, str]]]]


@dataclass
class FakeApiServer:
    handler: Handler
    requests: List[RecordedRequest] = field(default_factory=list)
    server: Any = None
    thread: Any = None
    base_url: str = ""

    def start(self) -> "FakeApiServer":
        outer = self

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, *args, **kwargs):  # silence stderr noise
                pass

            def _read_body(self) -> bytes:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    return b""
                return self.rfile.read(length)

            def _serve(self) -> None:
                parsed = urlsplit(self.path)
                req = RecordedRequest(
                    method=self.command,
                    path=parsed.path,
                    headers={k: v for k, v in self.headers.items()},
                    query=parse_qs(parsed.query),
                    body=self._read_body(),
                )
                outer.requests.append(req)
                status, body, extra_headers = outer.handler(req)
                self.send_response(status)
                if body is None:
                    self.send_header("Content-Length", "0")
                    if extra_headers:
                        for k, v in extra_headers.items():
                            self.send_header(k, v)
                    self.end_headers()
                    return
                payload = json.dumps(body).encode("utf-8")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                if extra_headers:
                    for k, v in extra_headers.items():
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self): self._serve()
            def do_POST(self): self._serve()
            def do_PATCH(self): self._serve()
            def do_DELETE(self): self._serve()
            def do_PUT(self): self._serve()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        host, port = self.server.server_address
        self.base_url = f"http://{host}:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=2)
