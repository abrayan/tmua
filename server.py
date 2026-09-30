#!/usr/bin/env python3
"""Serve a local TMUA library and discover self-contained HTML papers."""

import argparse
import functools
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import tempfile
import threading
from urllib.parse import unquote, urlsplit
import webbrowser


MAX_UPLOAD_BYTES = 15 * 1024 * 1024
PAPER_FORMAT = "tmua-paper-v1"
PAPER_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,79}\Z")


class PaperError(ValueError):
    pass


class MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.in_metadata = False
        self.documents = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("id") == "tmua-paper-meta":
            if attrs.get("type", "").lower() != "application/json":
                raise PaperError("Paper metadata must use type=application/json.")
            self.in_metadata = True
            self.parts = []

    def handle_data(self, data):
        if self.in_metadata:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_metadata:
            self.documents.append("".join(self.parts))
            self.in_metadata = False


def parse_metadata(html):
    parser = MetadataParser()
    parser.feed(html)
    parser.close()
    if parser.in_metadata or len(parser.documents) != 1:
        raise PaperError("Include exactly one complete tmua-paper-meta JSON script.")
    try:
        metadata = json.loads(parser.documents[0])
    except (ValueError, TypeError) as exc:
        raise PaperError("Paper metadata is not valid JSON.") from exc
    if not isinstance(metadata, dict):
        raise PaperError("Paper metadata must be a JSON object.")
    if metadata.get("format") != PAPER_FORMAT:
        raise PaperError("Paper format must be tmua-paper-v1.")
    if type(metadata.get("version")) is not int or metadata["version"] != 1:
        raise PaperError("Paper metadata version must be 1.")
    if not isinstance(metadata.get("id"), str) or not PAPER_ID.fullmatch(metadata["id"]):
        raise PaperError("Paper ID must contain 1–80 lowercase letters, numbers, hyphens or underscores.")
    if type(metadata.get("paper")) is not int or metadata["paper"] not in (1, 2):
        raise PaperError("Paper category must be 1 or 2.")
    if type(metadata.get("questionCount")) is not int or not 1 <= metadata["questionCount"] <= 1000:
        raise PaperError("Question count must be a whole number from 1 to 1000.")
    for key, maximum in (("title", 200), ("source", 300), ("description", 2000)):
        value = metadata.get(key)
        if not isinstance(value, str) or len(value) > maximum or (key != "description" and not value.strip()):
            raise PaperError("Paper %s must be text with at most %s characters." % (key, maximum))
        if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
            raise PaperError("Paper %s contains an unsupported control character." % key)
    return {key: metadata[key] for key in (
        "format", "id", "title", "paper", "source", "description", "questionCount", "version"
    )}


def within(path, directory):
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


class PaperLibrary:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.lock = threading.Lock()
        for category in (1, 2):
            (self.root / "papers" / ("paper-%d" % category)).mkdir(parents=True, exist_ok=True)

    def discover(self):
        papers = []
        errors = []
        known_ids = set()
        for category in (1, 2):
            directory = self.root / "papers" / ("paper-%d" % category)
            for file in sorted(directory.iterdir()):
                if file.suffix.lower() != ".html" or not file.is_file():
                    continue
                relative = file.relative_to(self.root).as_posix()
                try:
                    if not within(file.resolve(), directory.resolve()) or not within(file.resolve(), self.root):
                        raise PaperError("Paper must be stored inside its paper folder.")
                    if file.stat().st_size > MAX_UPLOAD_BYTES:
                        raise PaperError("Paper is larger than 15 MB.")
                    metadata = parse_metadata(file.read_text(encoding="utf-8-sig"))
                    if metadata["paper"] != category:
                        raise PaperError("Paper category does not match its folder.")
                    if metadata["id"] in known_ids:
                        raise PaperError("Another paper already uses this ID.")
                    known_ids.add(metadata["id"])
                    papers.append(dict(metadata, href=relative))
                except (OSError, UnicodeError, PaperError) as exc:
                    errors.append({"file": relative, "message": str(exc)})
        papers.sort(key=lambda paper: (paper["paper"], paper["title"].casefold(), paper["id"]))
        return {"papers": papers, "errors": errors}

    def add(self, payload):
        if not isinstance(payload, dict):
            raise PaperError("Upload must be a JSON object.")
        filename = payload.get("filename")
        if (not isinstance(filename, str) or not filename or len(filename) > 255
                or filename.startswith(".") or any(char in filename for char in "/\\")
                or any(ord(char) < 32 for char in filename) or not filename.lower().endswith(".html")):
            raise PaperError("Choose an HTML file with a plain filename.")
        html = payload.get("html")
        if not isinstance(html, str) or not html.strip():
            raise PaperError("Upload must include the HTML file contents.")
        encoded = html.encode("utf-8")
        if len(encoded) > MAX_UPLOAD_BYTES:
            raise PaperError("Paper is larger than 15 MB.")
        metadata = parse_metadata(html)
        directory = self.root / "papers" / ("paper-%d" % metadata["paper"])
        if not within(directory.resolve(), self.root):
            raise PaperError("Paper folder must be inside the website folder.")
        destination = directory / (metadata["id"] + ".html")
        with self.lock:
            if any(paper["id"] == metadata["id"] for paper in self.discover()["papers"]):
                raise FileExistsError("A paper with this ID is already in the library.")
            if destination.exists() or destination.is_symlink():
                raise FileExistsError("A file with this paper ID already exists.")
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=directory, prefix=".import-", suffix=".tmp", delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                # A hard link publishes the complete file atomically and cannot overwrite an existing file.
                os.link(temporary, destination)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        return dict(metadata, href=destination.relative_to(self.root).as_posix())


class WebsiteHandler(BaseHTTPRequestHandler):
    server_version = "TMUALibrary/1.0"

    def __init__(self, *args, library, **kwargs):
        self.library = library
        super().__init__(*args, **kwargs)

    def send_body(self, status, body, content_type="application/json; charset=utf-8", head=False):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def error(self, status, message):
        self.send_body(status, {"error": message}, head=self.command == "HEAD")

    def local_host(self):
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1:
            self.error(403, "This website accepts local requests only.")
            return False
        host = hosts[0].lower()
        allowed = {"127.0.0.1", "localhost"}
        allowed.update("%s:%s" % (name, self.server.server_port) for name in ("127.0.0.1", "localhost"))
        if host not in allowed:
            self.error(403, "This website accepts local requests only.")
            return False
        return True

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        if not self.local_host():
            return
        path = urlsplit(self.path).path
        if path == "/api/health":
            self.send_body(200, {"ok": True}, head=head)
            return
        if path in ("/api/papers", "/papers/catalog.json"):
            self.send_body(200, self.library.discover(), head=head)
            return
        if path.startswith("/api/"):
            self.error(404, "This page could not be found.")
            return
        try:
            decoded = unquote(path, errors="strict")
            parts = decoded.split("/")
            if "\\" in decoded or "\0" in decoded or any(part in (".", "..") or part.startswith(".") for part in parts if part):
                self.error(403, "This path is not available.")
                return
            requested = (self.library.root / decoded.lstrip("/")).resolve()
            if not within(requested, self.library.root):
                self.error(403, "This path is not available.")
                return
            if requested.is_dir():
                requested = requested / "index.html"
            relative = requested.relative_to(self.library.root)
            if (relative.parts[0] == "tests" or requested.suffix.lower() in (".py", ".pyc", ".command")
                    or not requested.is_file()):
                self.error(404, "This page could not be found.")
                return
            if not within(requested.resolve(), self.library.root):
                self.error(403, "This path is not available.")
                return
            content_type = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
                content_type += "; charset=utf-8"
            self.send_body(200, requested.read_bytes(), content_type, head=head)
        except (OSError, UnicodeError, ValueError):
            self.error(404, "This page could not be found.")

    def do_POST(self):
        if not self.local_host():
            return
        if urlsplit(self.path).path != "/api/papers":
            self.error(404, "This action could not be found.")
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin.lower() != "http://" + self.headers.get("Host", "").lower():
            self.error(403, "Add papers from this website's own page.")
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.error(415, "Paper uploads must use application/json.")
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                raise ValueError
            length = int(lengths[0])
            if length <= 0:
                raise ValueError
        except ValueError:
            self.error(411, "A valid upload size is required.")
            return
        if length > MAX_UPLOAD_BYTES:
            self.error(413, "Paper uploads must be smaller than 15 MB.")
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            paper = self.library.add(payload)
            self.send_body(201, {"paper": paper})
        except FileExistsError as exc:
            self.error(409, str(exc))
        except (PaperError, UnicodeError, ValueError) as exc:
            self.error(400, str(exc) or "This paper could not be read.")
        except OSError:
            self.error(500, "The paper could not be saved. Check that the website folder is writable.")


def make_server(root, port=8765):
    library = PaperLibrary(root)
    handler = functools.partial(WebsiteHandler, library=library)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description="Open your local TMUA practice website.")
    parser.add_argument("--port", type=int, default=8765, help="Local port (default: 8765)")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser automatically")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        server = make_server(Path(__file__).resolve().parent, args.port)
    except OSError as exc:
        parser.exit(1, "Could not start the website: %s\nIf it is already open, visit http://127.0.0.1:%s/\n" % (exc, args.port))
    address = "http://127.0.0.1:%d/" % server.server_port
    print("TMUA practice is ready at %s" % address, flush=True)
    print("Keep this window open while studying. Press Control-C to stop.", flush=True)
    if not args.no_open:
        threading.Timer(0.3, webbrowser.open, args=(address,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nWebsite stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
