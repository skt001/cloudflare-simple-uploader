#!/usr/bin/env python3
"""Command-line client for the uploader v1 API."""

import argparse
import cmd
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from collections import deque
import urllib.error
import urllib.parse
import urllib.request


class APIError(Exception):
    def __init__(self, status, code, message):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base):
        url = urllib.parse.urlsplit(base)
        if (url.scheme != "https" and not (
            url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
        )) or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("URL must use HTTPS (HTTP is allowed only for localhost), without credentials or query")
        self.origin = base.rstrip("/")
        self.base = self.origin + "/api/v1"
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, *, data=None, token=None, headers=None, retry=False):
        headers = {"User-Agent": "uploader-cli/1.0", **(headers or {})}
        if token:
            headers["Authorization"] = "Bearer " + token
        if isinstance(data, dict):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        for attempt in range(3 if retry else 1):
            try:
                with self.opener.open(req, timeout=60) as response:
                    return response.status, response.headers, response.read()
            except urllib.error.HTTPError as exc:
                if retry and 500 <= exc.code <= 599 and attempt < 2:
                    time.sleep(attempt + 1)
                    continue
                raw = exc.read(8192)
                try:
                    body = json.loads(raw)
                    detail = body["error"]
                    code, message = detail["code"], detail["message"]
                except (ValueError, KeyError, TypeError):
                    if exc.code == 403 and raw.strip() == b"error code: 1010":
                        code, message = "CLOUDFLARE_1010", "Cloudflare Browser Integrity Check blocked the request"
                    else:
                        code, message = "HTTP_ERROR", "Server returned an unexpected response"
                raise APIError(exc.code, code, message) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if retry and attempt < 2:
                    time.sleep(attempt + 1)
                    continue
                raise RuntimeError("Connection failed; the operation's outcome may be unknown") from None

    def json(self, method, path, **kwargs):
        _, _, body = self.request(method, path, **kwargs)
        try:
            return json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise RuntimeError("Server returned invalid JSON") from None


def config_paths():
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".config"
    return [base / "uploader" / "config.json", Path.home() / ".uploader"]


def read_config_url(path):
    text = path.read_text(encoding="utf-8").strip()
    try:
        if text.startswith("{"):
            url = json.loads(text).get("url")
        else:
            lines = [line.strip() for line in text.splitlines()]
            lines = [line for line in lines if line and not line.startswith("#")]
            url = lines[0] if lines else None
    except (ValueError, AttributeError):
        raise ValueError(f"Invalid config file: {path}") from None
    if url is not None and not isinstance(url, str):
        raise ValueError(f"Invalid config file: {path}")
    return url or None


def default_url():
    """Return (url, source) from UPLOADER_URL, config.json, then ~/.uploader."""
    env = os.environ.get("UPLOADER_URL")
    if env:
        return env, "UPLOADER_URL"
    for path in config_paths():
        if path.is_file():
            url = read_config_url(path)
            if url:
                return url, str(path)
    return None, None


def save_default_url(url):
    path = config_paths()[0]
    data = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            raise ValueError(f"Invalid config file: {path}") from None
        if not isinstance(data, dict):
            raise ValueError(f"Invalid config file: {path}")
    data["url"] = url
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".config-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, indent=2)
            output.write("\n")
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    except BaseException:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
        raise
    return path


def human(size):
    value = float(size)
    for unit in ("B", "KiB", "MiB"):
        if value < 1024:
            return f"{value:.0f}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.1f}GiB"


class Progress:
    """One-line progress on a terminal; throttled lines otherwise."""

    def __init__(self, label, total_bytes, total_chunks):
        self.label, self.total, self.chunks = label, total_bytes, total_chunks
        self.tty = sys.stdout.isatty()
        self.samples = deque([(time.monotonic(), 0)])
        self.last_draw = 0.0
        self.last_step = -1
        self.open = False

    def update(self, done_chunks, done_bytes):
        now = time.monotonic()
        pct = done_bytes * 100 // self.total
        if not self.tty:
            step = 10 if done_bytes < self.total else 100
            if pct // step > self.last_step // step or done_bytes >= self.total:
                self.last_step = pct
                print(f"{self.label} {pct:>3}%  {done_chunks}/{self.chunks}", flush=True)
            return
        self.samples.append((now, done_bytes))
        while len(self.samples) > 2 and now - self.samples[0][0] > 5:
            self.samples.popleft()
        final = done_bytes >= self.total
        if not final and now - self.last_draw < 0.1:
            return
        self.last_draw = now
        width = max(20, min(shutil.get_terminal_size((80, 24)).columns - 1, 79))
        line = self.render(pct, done_chunks, done_bytes, width)
        print("\r" + line + "\x1b[K", end="\n" if final else "", flush=True)
        self.open = not final

    def render(self, pct, chunks, done, width):
        text = f"{self.label} {pct:>3}%  {chunks}/{self.chunks}"
        (t0, b0), (t1, b1) = self.samples[0], self.samples[-1]
        rate = (b1 - b0) / (t1 - t0) if t1 > t0 else 0
        extras = []
        if rate > 0:
            extras.append(f"{human(rate)}/s")
            seconds = int((self.total - done) / rate)
            extras.append(f"ETA {seconds // 60}:{seconds % 60:02d}")
        extras.append(f"{human(done)}/{human(self.total)}")
        for extra in extras:
            if len(text) + 2 + len(extra) <= width:
                text += "  " + extra
        room = width - len(text) - 3
        if room >= 10:
            room = min(room, 20)
            filled = room * pct // 100
            text = f"{self.label} [{'#' * filled}{'-' * (room - filled)}]" + text[len(self.label):]
        return text

    def close(self):
        if self.open:
            print()
            self.open = False


def resolve(client, number):
    return client.json("GET", f"/files/by-number/{number}")


def list_files(client):
    path = "/files"
    while path:
        page = client.json("GET", path)
        for item in page["files"]:
            lock = " [locked]" if item["hasPassword"] else ""
            print(f'{item["number"]:>6}  {item["size"]:>10}  {item["name"]}{lock}  {item["comment"]}')
        cursor = page["nextCursor"]
        path = f"/files?before={cursor}" if cursor is not None else None


def put_file(client, filename):
    path = Path(filename)
    with path.open("rb") as source:
        size = os.fstat(source.fileno()).st_size
        comment = input("Comment (optional): ")
        password = input("Download password (empty for none): ")
        print("An empty delete key allows anyone to delete this file.")
        delete_key = input("Delete key (empty for none): ")
        upload = client.json("POST", "/uploads", data={
            "name": path.name, "size": size, "comment": comment,
            "password": password, "deleteKey": delete_key,
        })
        upload_id, token = upload["uploadId"], upload["uploadToken"]
        upload_path = f"/uploads/{upload_id}"
        complete_attempted = False
        try:
            chunk_size, chunk_count = upload["chunkSize"], upload["chunkCount"]
            if not isinstance(chunk_size, int) or chunk_size <= 0 or chunk_count != (size + chunk_size - 1) // chunk_size:
                raise RuntimeError("Server returned invalid upload parameters")
            progress = Progress("Uploading", size, chunk_count)
            for index in range(chunk_count):
                chunk = source.read(min(chunk_size, size - index * chunk_size))
                if len(chunk) != min(chunk_size, size - index * chunk_size):
                    raise RuntimeError("File changed during upload")
                client.request("PUT", f"{upload_path}/chunks/{index}", data=chunk, token=token,
                               headers={"Content-Type": "application/octet-stream",
                                        "X-Chunk-SHA256": hashlib.sha256(chunk).hexdigest()}, retry=True)
                progress.update(index + 1, min(size, (index + 1) * chunk_size))
            if source.read(1):
                raise RuntimeError("File changed during upload")
            complete_attempted = True
            result = client.json("POST", f"{upload_path}/complete", token=token, retry=True)
            print(f'Uploaded No.{result["number"]} ({result["id"]})')
        except (Exception, KeyboardInterrupt):
            if "progress" in locals():
                progress.close()
            if not complete_attempted:
                try:
                    client.request("DELETE", upload_path, token=token)
                except (APIError, RuntimeError) as exc:
                    print(f"Could not cancel upload: {exc}; reservation expires automatically", file=sys.stderr)
            else:
                print("Completion outcome may be unknown; check the file list.", file=sys.stderr)
            raise


def get_file(client, number, destination):
    item = resolve(client, number)
    name = item["name"]
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise RuntimeError("Server returned an unsafe file name")
    target = Path(destination) if destination else Path(name)
    status = client.json("GET", "/status")
    block_size = status["maxDownloadRangeBytes"]
    if not isinstance(block_size, int) or block_size < 1:
        raise RuntimeError("Server returned an invalid download limit")
    token = None

    def authorize():
        password = input(f'Download password for No.{number}: ')
        return client.json("POST", f'/files/{item["id"]}/authorize', data={"password": password})["token"]

    if item["hasPassword"]:
        token = authorize()
    fd, temp_name = tempfile.mkstemp(prefix=".uploader-", dir=target.parent)
    progress = Progress("Downloading", item["size"], (item["size"] + block_size - 1) // block_size)
    try:
        with os.fdopen(fd, "wb") as output:
            for start in range(0, item["size"], block_size):
                end = min(start + block_size, item["size"]) - 1
                headers = {"Range": f"bytes={start}-{end}"}
                try:
                    code, response_headers, data = client.request("GET", f'/files/{item["id"]}/content',
                                                                  headers=headers, token=token)
                except APIError as exc:
                    if exc.status != 401 or not item["hasPassword"]:
                        raise
                    token = authorize()
                    code, response_headers, data = client.request("GET", f'/files/{item["id"]}/content',
                                                                  headers=headers, token=token)
                if (code != 206 or response_headers.get("Content-Range") != f'bytes {start}-{end}/{item["size"]}'
                        or response_headers.get("Content-Length") != str(end - start + 1)
                        or len(data) != end - start + 1):
                    raise RuntimeError("Invalid download range or length")
                output.write(data)
                progress.update(start // block_size + 1, end + 1)
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(temp_name, 0o666 & ~umask)
        os.link(temp_name, target)
        print(f"Saved {target}")
    finally:
        progress.close()
        os.unlink(temp_name)


def delete_file(client, number):
    item = resolve(client, number)
    print(f'Delete No.{item["number"]}: {item["name"]} ({item["id"]})')
    if input("Type yes to confirm: ") != "yes":
        print("Cancelled")
        return
    key = input("Delete key: ") if item["hasDeleteKey"] else ""
    client.json("POST", f'/files/{item["id"]}/delete', data={"deleteKey": key})
    print("Deleted")


class Console(cmd.Cmd):
    prompt = "uploader> "

    def __init__(self, client):
        super().__init__()
        self.client = client
        self.intro = f"Uploader console ({client.origin}). Type help for commands."

    def onecmd(self, line):
        try:
            return super().onecmd(line)
        except (APIError, RuntimeError, ValueError, OSError, KeyError, TypeError, EOFError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
        except KeyboardInterrupt:
            print("\nInterrupted", file=sys.stderr)
        return False

    def emptyline(self):
        pass

    def default(self, line):
        print(f"Unknown command: {line.split()[0]}. Type help for commands.")

    @staticmethod
    def arguments(line, minimum, maximum, usage):
        args = shlex.split(line)
        if not minimum <= len(args) <= maximum:
            raise ValueError(f"Usage: {usage}")
        return args

    @staticmethod
    def number(value):
        number = int(value)
        if number < 1:
            raise ValueError("File number must be a positive integer")
        return number

    def do_list(self, line):
        """list: show the remote file list."""
        self.arguments(line, 0, 0, "list")
        list_files(self.client)

    def do_get(self, line):
        """get NUMBER [DESTINATION]: download a remote file."""
        args = self.arguments(line, 1, 2, "get NUMBER [DESTINATION]")
        get_file(self.client, self.number(args[0]), args[1] if len(args) == 2 else None)

    def do_put(self, line):
        """put FILE: upload a local file."""
        args = self.arguments(line, 1, 1, "put FILE")
        put_file(self.client, args[0])

    def do_delete(self, line):
        """delete NUMBER: delete a remote file after confirmation."""
        args = self.arguments(line, 1, 1, "delete NUMBER")
        delete_file(self.client, self.number(args[0]))

    def do_url(self, line):
        """url [URL]: show the server URL, or switch to URL and save it as the default."""
        args = self.arguments(line, 0, 1, "url [URL]")
        if not args:
            print(self.client.origin)
            return
        client = Client(args[0])
        client.json("GET", "/status")
        self.client = client
        print(f"Using {client.origin}; saved to {save_default_url(client.origin)}")

    def do_shell(self, line):
        """!COMMAND: run a local shell command; ! alone opens a local shell."""
        result = subprocess.run(line, shell=True) if line.strip() else subprocess.run(
            [os.environ.get("SHELL") or "/bin/sh"]
        )
        if result.returncode:
            print(f"Local command exited with status {result.returncode}", file=sys.stderr)

    def do_quit(self, line):
        """quit: exit the console."""
        self.arguments(line, 0, 0, "quit")
        return True

    do_exit = do_quit
    do_bye = do_quit

    def do_EOF(self, line):
        print()
        return True


def main():
    parser = argparse.ArgumentParser(description="Cloudflare uploader API client")
    parser.add_argument("--url", help="Uploader origin, e.g. https://example.workers.dev "
                        "(default: $UPLOADER_URL, ~/.config/uploader/config.json, ~/.uploader)")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("list")
    put = commands.add_parser("put")
    put.add_argument("file")
    get = commands.add_parser("get")
    get.add_argument("number", type=int)
    get.add_argument("destination", nargs="?")
    delete = commands.add_parser("delete")
    delete.add_argument("number", type=int)
    args = parser.parse_args()
    try:
        url = args.url
        if not url:
            url, _ = default_url()
        if not url:
            parser.error("no server URL; use --url (then 'url URL' in the console saves it), "
                         "UPLOADER_URL, ~/.config/uploader/config.json or ~/.uploader")
        client = Client(url)
        if args.command is None:
            console = Console(client)
            while True:
                try:
                    console.cmdloop()
                    break
                except KeyboardInterrupt:
                    print("\nInterrupted")
        elif args.command == "list":
            list_files(client)
        elif args.command == "put":
            put_file(client, args.file)
        elif args.command == "get":
            get_file(client, args.number, args.destination)
        else:
            delete_file(client, args.number)
    except (APIError, RuntimeError, ValueError, OSError, KeyError, TypeError, EOFError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
