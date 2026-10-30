#!/usr/bin/env python3
"""Local web UI for LFM3-Omni-2B via the llama.cpp server.

Serves a small static frontend and proxies the llama.cpp endpoints the
omni model needs:

  - POST /api/chat   -> llama.cpp POST /v1/chat/completions (SSE streaming)
  - POST /api/tts    -> llama.cpp POST /tts (raw audio)
  - GET  /api/models -> llama.cpp GET /v1/models

Everything runs on localhost; the llama.cpp server is expected at
http://127.0.0.1:9931 (configurable via LFM3_LAMMA_URL).
"""

import base64
import json
import os
import re
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import request as urlrequest

LLAMA_URL = os.environ.get("LFM3_LAMMA_URL", "http://127.0.0.1:9931")
APP_PORT = int(os.environ.get("PORT", "8090"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
OUTPUTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")

TTS_DIR = os.path.join(OUTPUTS_DIR, "tts")
os.makedirs(TTS_DIR, exist_ok=True)

CHATS_DIR = os.path.join(OUTPUTS_DIR, "chats")
os.makedirs(CHATS_DIR, exist_ok=True)


def _llama(method, path, body=None, timeout=300):
    url = LLAMA_URL.rstrip("/") + path
    data = None
    headers = {"Accept": "*/*"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urlrequest.Request(url, data=data, headers=headers, method=method)
    try:
        with urlrequest.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urlerror.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


class Handler(BaseHTTPRequestHandler):
    server_version = "LFM3-Omni-WebUI/1.0"

    # ---------- plumbing ----------

    def log_message(self, fmt, *args):
        print("[webui] " + (fmt % args), flush=True)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _write(self, data):
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, obj, status=200):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self._write(payload)

    def _send_audio(self, wav_bytes, content_type, meta=None):
        fname = f"tts_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.wav"
        with open(os.path.join(TTS_DIR, fname), "wb") as f:
            f.write(wav_bytes)
        obj = {"ok": True, "filename": fname, "content_type": content_type, "data_b64": base64.b64encode(wav_bytes).decode("ascii"), "duration_s": meta.get("duration_s") if meta else None}
        self._send_json(obj)

    # ---------- routes ----------

    def do_GET(self):
        if self.path == "/" or self.path == "":
            self._serve_file("static/index.html", "text/html; charset=utf-8")
        elif self.path.startswith("/static/"):
            rel = self.path[len("/static/"):].split("?")[0]
            ctype = "text/css" if rel.endswith(".css") else "text/javascript"
            if rel.endswith(".js"): ctype = "application/javascript"
            if rel.endswith(".html"): ctype = "text/html; charset=utf-8"
            self._serve_file("static/" + rel, ctype)
        elif self.path == "/api/health":
            self._api_health()
        elif self.path == "/api/models":
            self._proxy("GET", "/v1/models", None)
        elif self.path == "/api/props":
            self._proxy("GET", "/props", None)
        elif self.path == "/api/chats":
            self._api_chats_list()
        elif self.path.startswith("/api/chats/"):
            name = self.path[len("/api/chats/"):].split("?")[0]
            if "/" in name or not name:
                self._send_json({"ok": False, "error": "invalid chat id"}, 400)
                return
            self._api_chats_load(name)
        elif self.path.startswith("/api/tts/"):
            name = self.path[len("/api/tts/"):]
            if "/" in name or not os.path.isfile(os.path.join(TTS_DIR, name)):
                self._send_json({"ok": False, "error": "not found"}, 404)
                return
            with open(os.path.join(TTS_DIR, name), "rb") as f:
                wav = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self._write(wav)
        else:
            self._send_json({"ok": False, "error": "not found", "path": self.path}, 404)

    def do_POST(self):
        if self.path == "/api/chat":
            self._api_chat()
        elif self.path == "/api/tts":
            self._api_tts()
        elif self.path == "/api/chats":
            self._api_chats_save()
        else:
            self._send_json({"ok": False, "error": "not found"}, 404)

    def do_DELETE(self):
        if self.path.startswith("/api/chats/"):
            name = self.path[len("/api/chats/"):].split("?")[0]
            if "/" in name or not name:
                self._send_json({"ok": False, "error": "invalid chat id"}, 400)
                return
            self._api_chats_delete(name)
            return
        self._send_json({"ok": False, "error": "not found"}, 404)

    # ---------- helpers ----------

    def _serve_file(self, rel, ctype):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), rel)
        if not os.path.isfile(path):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self._write(body)

    def _proxy(self, method, path, body, timeout=300):
        status, headers, data = _llama(method, path, body, timeout=timeout)
        ctype = headers.get("Content-Type", "application/json")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if "application/json" in ctype or "text/event-stream" in ctype:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self._write(data)

    def _api_health(self):
        try:
            status, headers, data = _llama("GET", "/v1/models", timeout=20)
            info = json.loads(data.decode("utf-8"))
            models = info.get("data") or [info]
            m = models[0] if isinstance(models, list) else models
            arch = m.get("architecture") or {}
            self._send_json({
                "ok": True,
                "model": m.get("id"),
                "input_modalities": arch.get("input_modalities") or [],
                "output_modalities": arch.get("output_modalities") or [],
                "has_tts": "audio" in (arch.get("output_modalities") or []),
                "server_version": (headers.get("X-llama-server-version") or ""),
            })
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 503)

    def _api_chat(self):
        body = self._read_body()
        stream = bool(body.get("stream", True))
        if not stream:
            status, headers, data = _llama("POST", "/v1/chat/completions", body, timeout=900)
            self.send_response(status)
            self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self._write(data)
            return
        url = LLAMA_URL.rstrip("/") + "/v1/chat/completions"
        req = urlrequest.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
                                 method="POST")
        try:
            r = urlrequest.urlopen(req, timeout=900)
        except urlerror.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self._write(data)
            return
        except Exception as e:
            self._send_json({"error": str(e)}, 502)
            return
        ctype = r.headers.get("Content-Type", "")
        if "text/event-stream" not in ctype:
            data = r.read()
            r.close()
            self.send_response(r.status)
            self.send_header("Content-Type", ctype or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self._write(data)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            while True:
                chunk = r.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                r.close()
            except Exception:
                pass

    def _api_tts(self):
        body = self._read_body()
        status, headers, data = _llama("POST", "/tts", body, timeout=600)
        if status != 200:
            try:
                err = data.decode("utf-8")
            except Exception:
                err = "tts failed"
            self._send_json({"ok": False, "error": err}, status)
            return
        ctype = headers.get("Content-Type", "audio/wav")
        duration_s = None
        m = re.search(r"rate=(\d+)", ctype)
        try:
            rate = int(m.group(1)) if m else 24000
            duration_s = round(len(data) / (2 * rate), 2)
        except Exception:
            duration_s = None
        self._send_audio(data, ctype, {"duration_s": duration_s})

    # ---------- chat persistence ----------

    def _chat_path(self, name):
        safe = "".join(c for c in name if c.isalnum() or c in ("-", "_", "."))
        if not safe or safe in (".", ".."):
            safe = "chat"
        return os.path.join(CHATS_DIR, safe + ".json")

    def _api_chats_list(self):
        try:
            out = []
            for fn in sorted(os.listdir(CHATS_DIR), reverse=True):
                if not fn.endswith(".json"):
                    continue
                p = os.path.join(CHATS_DIR, fn)
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        d = json.load(f)
                except Exception:
                    continue
                msgs = d.get("messages") or []
                out.append({
                    "id": d.get("id") or fn[:-5],
                    "title": d.get("title") or "Chat",
                    "updatedAt": d.get("updatedAt") or d.get("createdAt") or 0,
                    "msgCount": len(msgs),
                })
            out.sort(key=lambda x: x.get("updatedAt") or 0, reverse=True)
            self._send_json({"ok": True, "chats": out})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def _api_chats_save(self):
        body = self._read_body()
        cid = body.get("id") or "chat-" + uuid.uuid4().hex[:8]
        title = body.get("title") or "Chat"
        messages = body.get("messages") or []
        now = int(time.time() * 1000)
        payload = {"id": cid, "title": title, "messages": messages, "createdAt": body.get("createdAt") or now, "updatedAt": now}
        try:
            with open(self._chat_path(cid), "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            self._send_json({"ok": True, "id": cid, "title": title})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def _api_chats_load(self, name):
        try:
            p = self._chat_path(name)
            if not os.path.isfile(p):
                self._send_json({"ok": False, "error": "chat not found"}, 404)
                return
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            self._send_json({"ok": True, "chat": d})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def _api_chats_delete(self, name):
        try:
            p = self._chat_path(name)
            if os.path.isfile(p):
                os.remove(p)
            self._send_json({"ok": True})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", APP_PORT), Handler)
    print(f"[webui] LFM3 Omni web UI listening on http://127.0.0.1:{APP_PORT}", flush=True)
    print(f"[webui] llama.cpp server at {LLAMA_URL}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
