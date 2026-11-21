import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");

function runWrangler(args) {
  const result = spawnSync(wrangler, args, { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("Python client identifies itself and reports Cloudflare error 1010", { timeout: 20_000 }, async () => {
  let agent;
  const server = http.createServer((request, response) => {
    agent = request.headers["user-agent"];
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("error code: 1010\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const child = spawn("python3", [path.join(root, "uploader.py"), "--url", `http://127.0.0.1:${port}`, "list"]);
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const [code] = await once(child, "close");
    assert.equal(code, 1);
    assert.equal(agent, "uploader-cli/1.0");
    assert.match(stderr, /CLOUDFLARE_1010/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("isolated D1 migration, password access and deletion", { timeout: 120_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "uploader-test-"));
  const migrationDir = path.join(temp, "migrations");
  const config = path.join(temp, "wrangler.json");
  const persist = path.join(temp, "state");
  let server;
  let output = "";
  try {
    await mkdir(migrationDir);
    await copyFile(path.join(root, "migrations", "0001_init.sql"), path.join(migrationDir, "0001_init.sql"));
    await writeFile(config, JSON.stringify({
      name: "uploader-test",
      main: path.join(root, "src", "index.js"),
      compatibility_date: "2026-11-12",
      assets: { directory: path.join(root, "public"), binding: "ASSETS", run_worker_first: ["/api/*"] },
      d1_databases: [{
        binding: "simple_uploader_db", database_name: "test-db",
        database_id: "00000000-0000-0000-0000-000000000001",
        migrations_dir: migrationDir,
      }],
    }));
    const common = ["--config", config, "--local", "--persist-to", persist];
    runWrangler(["d1", "migrations", "apply", "test-db", ...common]);
    runWrangler([
      "d1", "execute", "test-db", ...common,
      "--command",
      "INSERT INTO files (id, file_no, name, mime_type, size, created_at, status) " +
        "VALUES ('00000000-0000-0000-0000-000000000001', 1, 'legacy', 'application/octet-stream', 1, 1, 'ready')",
    ]);
    await copyFile(path.join(root, "migrations", "0002_file_passwords.sql"), path.join(migrationDir, "0002_file_passwords.sql"));
    runWrangler(["d1", "migrations", "apply", "test-db", ...common]);
    await copyFile(path.join(root, "migrations", "0003_api_uploads.sql"), path.join(migrationDir, "0003_api_uploads.sql"));
    runWrangler(["d1", "migrations", "apply", "test-db", ...common]);

    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(wrangler, ["dev", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (data) => { output += data; });
    server.stderr.on("data", (data) => { output += data; });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw new Error(`Worker exited: ${output}`);
      try {
        const response = await fetch(`${base}/api/status`);
        if (response.ok) break;
      } catch {
        // Wait for the local server to start.
      }
      if (attempt === 119) throw new Error(`Worker did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    async function request(url, options = {}) {
      return fetch(`${base}${url}`, {
        ...options,
        headers: { Origin: base, ...options.headers },
      });
    }
    async function post(url, data) {
      return request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }
    async function expectStatus(response, expected) {
      if (response.status !== expected) {
        assert.fail(`Expected ${expected}, got ${response.status}: ${await response.text()}`);
      }
    }
    async function upload(name, payload, password = "", deleteKey = "") {
      const start = await post("/api/uploads", { name, size: payload.length, password, deleteKey });
      await expectStatus(start, 201);
      const info = await start.json();
      for (let index = 0; index < info.chunkCount; index++) {
        const part = payload.subarray(index * info.chunkSize, (index + 1) * info.chunkSize);
        const response = await request(`/api/uploads/${info.id}/chunks/${index}`, {
          method: "POST", body: part, headers: { "Content-Type": "application/octet-stream" },
        });
        await expectStatus(response, 204);
      }
      const complete = await request(`/api/uploads/${info.id}/complete`, { method: "POST" });
      await expectStatus(complete, 200);
      return info.id;
    }

    let response = await request("/api/files");
    const initialList = await response.json();
    assert.equal(initialList.files[0].name, "legacy");
    assert.equal(initialList.files[0].hasPassword, false);
    assert.equal(initialList.files[0].hasDeleteKey, false);

    const payload = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    const id = await upload("protected.bin", payload, "download-password", "delete-key");
    const plainId = await upload("plain.bin", Uint8Array.of(42));
    response = await request("/api/files");
    const list = (await response.json()).files;
    assert.equal(JSON.stringify(list).includes("download-password"), false);
    assert.equal(JSON.stringify(list).includes("delete-key"), false);
    assert.equal(list.find((file) => file.id === id).hasPassword, true);
    assert.equal(list.find((file) => file.id === id).hasDeleteKey, true);
    assert.equal(list.find((file) => file.id === plainId).hasPassword, false);
    assert.equal(list.find((file) => file.id === plainId).hasDeleteKey, false);

    const range = `/api/files/${id}/range?start=0&end=${payload.length - 1}`;
    assert.equal((await request(range)).status, 401);
    assert.equal((await request(range, { headers: { Authorization: `Bearer ${"0".repeat(64)}` } })).status, 401);
    assert.equal((await post(`/api/files/${id}/authorize`, { secret: "wrong" })).status, 403);
    response = await post(`/api/files/${id}/authorize`, { secret: "download-password" });
    await expectStatus(response, 200);
    const { token } = await response.json();
    response = await request(range, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
    assert.equal((await request(`/api/files/${plainId}/range?start=0&end=0`)).status, 206);
    assert.equal((await request(`/api/files/${plainId}/range?start=0&end=0`, {
      headers: { Authorization: `Bearer ${token}` },
    })).status, 206);
    const lockedId = await upload("locked.bin", Uint8Array.of(99), "real", "key");
    assert.equal((await request(`/api/files/${lockedId}/range?start=0&end=0`, {
      headers: { Authorization: `Bearer ${token}` },
    })).status, 401);

    assert.equal((await post(`/api/files/${id}/delete`, { secret: "" })).status, 400);
    assert.equal((await post(`/api/files/${id}/delete`, { secret: "wrong" })).status, 403);
    assert.equal((await request(range, { headers: { Authorization: `Bearer ${token}` } })).status, 206);
    assert.equal((await post(`/api/files/${id}/delete`, { secret: "delete-key" })).status, 200);
    assert.equal((await request(range, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await post(`/api/files/${id}/authorize`, { secret: "download-password" })).status, 404);
    response = await request("/api/status");
    assert.equal((await response.json()).reservedBytes, 3);

    assert.equal((await post(`/api/files/${plainId}/authorize`, { secret: "wrong" })).status, 409);
    assert.equal((await request(`/api/files/${plainId}/delete`, {
      method: "POST",
      headers: { Origin: "https://other.example", "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "" }),
    })).status, 403);
    assert.equal((await post(`/api/files/${plainId}/delete`, {})).status, 200);
    assert.equal((await request(`/api/files/${plainId}/range?start=0&end=0`)).status, 404);
    assert.equal((await post(`/api/files/00000000-0000-0000-0000-000000000001/delete`, { secret: "" })).status, 200);
    const passwordOnlyId = await upload("password-only.bin", Uint8Array.of(7), "password");
    assert.equal((await post(`/api/files/${passwordOnlyId}/delete`, { secret: "" })).status, 200);
    response = await request("/api/status");
    assert.equal((await response.json()).reservedBytes, 1);
    for (let i = 0; i < 10; i++) {
      assert.equal((await post(`/api/files/${lockedId}/authorize`, { secret: "wrong" })).status, 403);
    }
    assert.equal((await post(`/api/files/${lockedId}/authorize`, { secret: "real" })).status, 429);
    assert.equal((await post(`/api/files/${lockedId}/delete`, { secret: "key" })).status, 200);

    const api = `${base}/api/v1`;
    const apiRequest = (url, options = {}) => fetch(api + url, options);
    const apiPost = (url, data, token) => apiRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data),
    });
    response = await apiRequest("/status");
    const status = await response.json();
    assert.equal(status.uploadChunkBytes, 65536);
    assert.equal(status.maxDownloadRangeBytes, 262144);
    assert.equal((await apiRequest("/files", { headers: { Origin: "https://other.example" } })).status, 403);
    assert.equal((await apiPost("/uploads", { name: "../bad", size: 1 })).status, 400);
    assert.equal((await apiPost("/uploads", { name: "large", size: 100 * 1024 * 1024 + 1 })).status, 413);
    response = await apiPost("/uploads", { name: "v1.bin", size: payload.length, password: "pass", deleteKey: "key" });
    await expectStatus(response, 201);
    const v1 = await response.json();
    const uploadPath = `/uploads/${v1.uploadId}`;
    const tokenHeader = { Authorization: `Bearer ${v1.uploadToken}` };
    const first = payload.subarray(0, v1.chunkSize);
    const sendChunk = (index, data, token = v1.uploadToken) => apiRequest(`${uploadPath}/chunks/${index}`, {
      method: "PUT", body: data, headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream",
        "X-Chunk-SHA256": createHash("sha256").update(data).digest("hex"),
      },
    });
    assert.equal((await sendChunk(0, first, "0".repeat(64))).status, 404);
    assert.equal((await request(`/api/uploads/${v1.uploadId}/chunks/0`, { method: "POST", body: first })).status, 409);
    assert.equal((await request(`/api/uploads/${v1.uploadId}/complete`, { method: "POST" })).status, 404);
    assert.equal((await sendChunk(0, first)).status, 204);
    assert.equal((await sendChunk(0, first)).status, 204);
    const different = Uint8Array.from(first);
    different[0] ^= 1;
    response = await sendChunk(0, different);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "CHUNK_CONFLICT");
    response = await apiPost(`${uploadPath}/complete`, {}, v1.uploadToken);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "UPLOAD_INCOMPLETE");
    assert.equal((await sendChunk(1, payload.subarray(v1.chunkSize))).status, 204);
    response = await apiPost(`${uploadPath}/complete`, {}, v1.uploadToken);
    await expectStatus(response, 200);
    const completed = await response.json();
    assert.deepEqual(await (await apiPost(`${uploadPath}/complete`, {}, v1.uploadToken)).json(), completed);
    assert.equal((await sendChunk(0, first)).status, 409);
    assert.equal((await apiRequest(uploadPath, { method: "DELETE", headers: tokenHeader })).status, 409);
    response = await apiRequest(`/files/by-number/${completed.number}`);
    assert.equal((await response.json()).id, v1.uploadId);
    assert.equal((await apiRequest(`/files/${v1.uploadId}/content`, { headers: { Range: "bytes=0-4" } })).status, 401);
    assert.equal((await apiPost(`/files/${v1.uploadId}/authorize`, { password: null })).status, 400);
    response = await apiRequest(`/files/${v1.uploadId}/content`);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), `bytes */${payload.length}`);
    assert.equal((await apiPost(`/files/${v1.uploadId}/authorize`, { password: "wrong" })).status, 403);
    response = await apiPost(`/files/${v1.uploadId}/authorize`, { password: "pass" });
    const authorization = await response.json();
    assert.ok(authorization.expiresAt > Date.now());
    response = await apiRequest(`/files/${v1.uploadId}/content`, {
      headers: { Range: `bytes=0-${payload.length + 10}`, Authorization: `Bearer ${authorization.token}` },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), `bytes 0-${payload.length - 1}/${payload.length}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
    assert.equal((await apiPost(`/files/${v1.uploadId}/delete`, { deleteKey: "wrong" })).status, 403);
    assert.equal((await apiPost(`/files/${v1.uploadId}/delete`, { deleteKey: null })).status, 400);
    assert.equal((await apiPost(`/files/${v1.uploadId}/delete`, { deleteKey: "key" })).status, 200);
    assert.equal((await apiRequest(`/files/by-number/${completed.number}`)).status, 404);
    response = await apiPost("/uploads", { name: "cancel", size: 1 });
    const pending = await response.json();
    assert.equal((await apiRequest(`/uploads/${pending.uploadId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${pending.uploadToken}` },
    })).status, 204);
    assert.equal((await apiRequest(`/uploads/${pending.uploadId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${pending.uploadToken}` },
    })).status, 404);
    response = await apiPost("/uploads", { name: "expired", size: 1 });
    const expired = await response.json();
    runWrangler([
      "d1", "execute", "test-db", ...common, "--command",
      `UPDATE files SET created_at = 1, api_upload_expires_at = 1 WHERE id = '${expired.uploadId}'`,
    ]);
    assert.equal((await apiRequest(`/uploads/${expired.uploadId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${expired.uploadToken}` },
    })).status, 404);
    const reservations = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      apiPost("/uploads", { name: `reserve-${index}`, size: 100 * 1024 * 1024 })
    ));
    assert.equal(reservations.filter((item) => item.status === 201).length, 4);
    assert.equal(reservations.filter((item) => item.status === 507).length, 2);
    for (const reservation of reservations.filter((item) => item.status === 201)) {
      const upload = await reservation.json();
      assert.equal((await apiRequest(`/uploads/${upload.uploadId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${upload.uploadToken}` },
      })).status, 204);
    }

    const source = path.join(temp, "client-source.bin");
    const target = path.join(temp, "client-output.bin");
    await writeFile(source, payload);
    async function cli(args, input = "") {
      const child = spawn("python3", [path.join(root, "uploader.py"), "--url", base, ...args]);
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.stdin.end(input);
      const [code] = await once(child, "close");
      return { code, stdout, stderr };
    }
    let result = await cli(["put", source], "comment\n\n\n");
    assert.equal(result.code, 0, result.stderr);
    const number = Number(result.stdout.match(/Uploaded No\.(\d+)/)?.[1]);
    const previousId = result.stdout.match(/\(([0-9a-f-]{36})\)/)?.[1];
    assert.ok(number > 0);
    assert.ok(previousId);
    result = await cli(["list"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /client-source\.bin/);
    result = await cli(["get", String(number), target]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(new Uint8Array(await readFile(target)), payload);
    result = await cli(["get", String(number), target]);
    assert.equal(result.code, 1);
    assert.deepEqual(new Uint8Array(await readFile(target)), payload);
    result = await cli(["delete", String(number)], "yes\n");
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await apiRequest(`/files/by-number/${number}`)).status, 404);
    result = await cli(["put", source], "\n\n\n");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(Number(result.stdout.match(/Uploaded No\.(\d+)/)?.[1]), number);
    assert.equal((await apiPost(`/files/${previousId}/delete`, {})).status, 404);
    assert.equal((await apiRequest(`/files/by-number/${number}`)).status, 200);

    const shellTarget = path.join(temp, "shell output.bin");
    result = await cli([], [
      "help", "!printf local-command-ok", "get invalid", "unknown", "list",
      `get ${number} "${shellTarget}"`, `delete ${number}`, "yes", "",
      `put "${source}"`, "console comment", "", "", "list", "quit", "",
    ].join("\n"));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /local-command-ok/);
    assert.match(result.stdout, /Unknown command: unknown/);
    assert.match(result.stderr, /Error:/);
    assert.match(result.stdout, /Deleted/);
    assert.match(result.stdout, /Uploading 100%/);
    assert.match(result.stdout, /Downloading 100%/);
    assert.match(result.stdout, /Uploaded No\./);
    assert.match(result.stdout, /console comment/);
    assert.deepEqual(new Uint8Array(await readFile(shellTarget)), payload);
    assert.equal((await apiRequest(`/files/by-number/${number}`)).status, 200);
    const home = path.join(temp, "home");
    await mkdir(path.join(home, ".config", "uploader"), { recursive: true });
    async function cliHome(args, input = "", env = {}) {
      const child = spawn("python3", [path.join(root, "uploader.py"), ...args], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", UPLOADER_URL: "", ...env },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.stdin.end(input);
      const [code] = await once(child, "close");
      return { code, stdout, stderr };
    }
    result = await cliHome(["list"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no server URL/);
    await writeFile(path.join(home, ".uploader"), `${base}\n`);
    result = await cliHome(["list"]);
    assert.equal(result.code, 0, result.stderr);
    await writeFile(path.join(home, ".config", "uploader", "config.json"), JSON.stringify({ url: "http://127.0.0.1:1" }));
    result = await cliHome(["list"]);
    assert.equal(result.code, 1);
    result = await cliHome(["list"], "", { UPLOADER_URL: base });
    assert.equal(result.code, 0, result.stderr);
    const freshConfig = path.join(temp, "fresh-config");
    result = await cliHome(["--url", base], `url\nurl ${base}\nquit\n`, { XDG_CONFIG_HOME: freshConfig });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /saved to/);
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(path.join(freshConfig, "uploader", "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(freshConfig, "uploader"))).mode & 0o777, 0o700);
    result = await cliHome(["list"], "", { XDG_CONFIG_HOME: freshConfig });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await stat(shellTarget)).mode & 0o777, 0o666 & ~process.umask());
  } finally {
    if (server) {
      server.kill("SIGTERM");
      if (server.exitCode === null) await once(server, "exit");
    }
    await rm(temp, { recursive: true, force: true });
  }
});
