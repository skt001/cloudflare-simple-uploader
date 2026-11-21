import { handleV1 } from "./api-v1.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_SECRET_LENGTH = 128;
const PASSWORD_ITERATIONS = 100_000;
const AUTH_WINDOW_MS = 60_000;
const AUTH_ATTEMPT_LIMIT = 10;
const DOWNLOAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_CHUNK_BYTES = 64 * 1024;
const DOWNLOAD_BLOCK_BYTES = 256 * 1024;
const INCOMPLETE_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_PAGE_SIZE = 30;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

function isSameOriginWrite(request) {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}

function cleanFileName(value) {
  return String(value)
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
}

function getFileId(path) {
  const match = path.match(/^\/api\/files\/([0-9a-f-]{36})\/range$/i);
  return match?.[1] ?? null;
}

function getChunkRoute(path) {
  const match = path.match(/^\/api\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/i);
  if (!match) return null;
  return { id: match[1], index: Number(match[2]) };
}

function contentDisposition(fileName) {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 150) || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid password hash");
  return Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
}

async function deriveSecret(secret, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]
  );
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations,
  }, key, 256));
}

async function hashSecret(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveSecret(secret, salt, PASSWORD_ITERATIONS);
  return `${PASSWORD_ITERATIONS}:${bytesToHex(salt)}:${bytesToHex(hash)}`;
}

async function verifySecret(secret, stored) {
  const [iterationsText, saltText, hashText] = stored.split(":");
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100_000 ||
      !saltText || !hashText) {
    throw new Error("Invalid password hash");
  }
  const expected = hexToBytes(hashText);
  const actual = await deriveSecret(secret, hexToBytes(saltText), iterations);
  if (actual.length !== expected.length) throw new Error("Invalid password hash");
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

async function tokenHash(token) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(hash));
}

async function readJson(request) {
  try {
    const body = await readBodyLimited(request, MAX_METADATA_BYTES);
    const value = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: errorResponse("送信データを読み取れません。", 400) };
    }
    return { value };
  } catch (error) {
    if (error instanceof RangeError) {
      return { error: errorResponse(error.message, 413) };
    }
    if (error instanceof SyntaxError) {
      return { error: errorResponse("送信データを読み取れません。", 400) };
    }
    throw error;
  }
}

function validSecret(secret) {
  return typeof secret === "string" && secret.length <= MAX_SECRET_LENGTH;
}

async function reserveAuthAttempt(db, fileId, purpose) {
  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO file_auth_attempts (file_id, purpose, window_start, attempts)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (file_id, purpose) DO UPDATE SET
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END,
       attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END
     WHERE window_start <= ? OR attempts < ?
     RETURNING attempts`
  ).bind(
    fileId, purpose, now, now - AUTH_WINDOW_MS, now,
    now - AUTH_WINDOW_MS, now - AUTH_WINDOW_MS, AUTH_ATTEMPT_LIMIT
  ).first();
  return row !== null;
}

async function clearAuthAttempts(db, fileId, purpose) {
  await db.prepare(
    `DELETE FROM file_auth_attempts WHERE file_id = ? AND purpose = ?`
  ).bind(fileId, purpose).run();
}

async function readBodyLimited(request, limit) {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RangeError("送信データのサイズが上限を超えています。");
    }
    parts.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function removeExpiredUploads(db, now) {
  const expiresBefore = now - INCOMPLETE_TTL_MS;
  await db.batch([
    db.prepare(
      `DELETE FROM file_chunks
       WHERE file_id IN (
         SELECT id FROM files
         WHERE status = 'uploading' AND created_at < ?
       )`
    ).bind(expiresBefore),
    db.prepare(
      `DELETE FROM files
       WHERE status = 'uploading' AND created_at < ?`
    ).bind(expiresBefore),
  ]);
}

async function handleStatus(db) {
  const result = await db.prepare(
    `SELECT
       COALESCE(SUM(size), 0) AS reserved_bytes,
       SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS file_count
     FROM files`
  ).first();

  return jsonResponse({
    reservedBytes: result.reserved_bytes,
    fileCount: result.file_count ?? 0,
    capacityBytes: MAX_TOTAL_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
  });
}

async function handleList(db, url) {
  const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(before) || before < 1) {
    return errorResponse("一覧の指定が正しくありません。", 400);
  }

  const result = await db.prepare(
    `SELECT id, file_no, name, size, comment, created_at, download_count,
            download_password_hash IS NOT NULL AS has_password,
            delete_key_hash IS NOT NULL AS has_delete_key
     FROM files
     WHERE status = 'ready' AND file_no < ?
     ORDER BY file_no DESC
     LIMIT ?`
  ).bind(before, LIST_PAGE_SIZE + 1).all();

  const rows = result.results;
  const hasMore = rows.length > LIST_PAGE_SIZE;
  const files = rows.slice(0, LIST_PAGE_SIZE).map((row) => ({
    id: row.id,
    number: row.file_no,
    name: row.name,
    size: row.size,
    comment: row.comment,
    createdAt: row.created_at,
    downloadCount: row.download_count,
    hasPassword: Boolean(row.has_password),
    hasDeleteKey: Boolean(row.has_delete_key),
  }));

  return jsonResponse({
    files,
    nextCursor: hasMore ? files.at(-1).number : null,
  });
}

async function handleUploadStart(request, env) {
  if (!isSameOriginWrite(request)) {
    return errorResponse("このページからのアップロードのみ受け付けます。", 403);
  }

  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const input = parsed.value;

  const name = cleanFileName(typeof input.name === "string" ? input.name : "");
  const size = Number(input.size);
  const comment = typeof input.comment === "string"
    ? input.comment.trim().slice(0, 1000)
    : "";
  const password = input.password ?? "";
  const deleteKey = input.deleteKey ?? "";
  if (!validSecret(password) || !validSecret(deleteKey)) {
    return errorResponse("パスワードと削除キーは128文字以内で入力してください。", 400);
  }
  if (!name || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    return errorResponse("ファイル名またはファイルサイズが上限を超えています。", 400);
  }

  const now = Date.now();
  await removeExpiredUploads(env.simple_uploader_db, now);

  const passwordHash = password ? await hashSecret(password) : null;
  const deleteKeyHash = deleteKey ? await hashSecret(deleteKey) : null;
  const id = crypto.randomUUID();
  const result = await env.simple_uploader_db.prepare(
    `INSERT INTO files (id, file_no, name, mime_type, size, comment, created_at, status,
                        download_password_hash, delete_key_hash)
     SELECT ?, COALESCE((SELECT MAX(file_no) FROM files), 0) + 1,
            ?, 'application/octet-stream', ?, ?, ?, 'uploading', ?, ?
     WHERE (SELECT COALESCE(SUM(size), 0) FROM files) + ? <= ?`
  ).bind(id, name, size, comment, now, passwordHash, deleteKeyHash, size, MAX_TOTAL_BYTES).run();

  if (result.meta.changes !== 1) {
    return errorResponse("保存容量の上限に達しています。", 507);
  }

  return jsonResponse({
    id,
    chunkSize: UPLOAD_CHUNK_BYTES,
    chunkCount: Math.ceil(size / UPLOAD_CHUNK_BYTES),
  }, 201);
}

async function handleUploadChunk(request, env, route) {
  if (!isSameOriginWrite(request)) {
    return errorResponse("このページからのアップロードのみ受け付けます。", 403);
  }

  if (!Number.isSafeInteger(route.index) || route.index < 0) {
    return errorResponse("チャンク番号が正しくありません。", 400);
  }

  let bytes;
  try {
    bytes = await readBodyLimited(request, UPLOAD_CHUNK_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return errorResponse("チャンクのサイズが上限を超えています。", 413);
    }
    throw error;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_CHUNK_BYTES) {
    return errorResponse("チャンクのサイズが正しくありません。", 400);
  }

  const result = await env.simple_uploader_db.prepare(
    `INSERT OR IGNORE INTO file_chunks (file_id, chunk_index, data)
     SELECT ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM files
       WHERE id = ? AND status = 'uploading' AND api_upload_token_hash IS NULL
         AND ? < ((size + ? - 1) / ?)
         AND ? = MIN(?, size - ? * ?)
     )`
  ).bind(
    route.id,
    route.index,
    bytes,
    route.id,
    route.index,
    UPLOAD_CHUNK_BYTES,
    UPLOAD_CHUNK_BYTES,
    bytes.byteLength,
    UPLOAD_CHUNK_BYTES,
    route.index,
    UPLOAD_CHUNK_BYTES
  ).run();

  if (result.meta.changes === 1) {
    return new Response(null, { status: 204 });
  }

  const existing = await env.simple_uploader_db.prepare(
    `SELECT length(c.data) AS chunk_bytes, f.status, f.api_upload_token_hash
     FROM files AS f
     LEFT JOIN file_chunks AS c
       ON c.file_id = f.id AND c.chunk_index = ?
     WHERE f.id = ?`
  ).bind(route.index, route.id).first();

  if (existing?.status === "uploading" && existing.api_upload_token_hash === null &&
      existing.chunk_bytes === bytes.byteLength) {
    return new Response(null, { status: 204 });
  }
  if (!existing) return errorResponse("アップロードが見つかりません。", 404);
  return errorResponse("チャンクを保存できませんでした。", 409);
}

async function handleUploadComplete(request, env, id) {
  if (!isSameOriginWrite(request)) {
    return errorResponse("このページからのアップロードのみ受け付けます。", 403);
  }

  const file = await env.simple_uploader_db.prepare(
    `SELECT size FROM files WHERE id = ? AND status = 'uploading'
     AND api_upload_token_hash IS NULL`
  ).bind(id).first();
  if (!file) return errorResponse("アップロードが見つかりません。", 404);

  const chunkCount = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);
  const chunks = await env.simple_uploader_db.prepare(
    `SELECT COUNT(*) AS chunk_count, COALESCE(SUM(length(data)), 0) AS total_bytes
     FROM file_chunks WHERE file_id = ?`
  ).bind(id).first();
  if (chunks.chunk_count !== chunkCount || chunks.total_bytes !== file.size) {
    return errorResponse("ファイルの受信が完了していません。再度お試しください。", 409);
  }

  const result = await env.simple_uploader_db.prepare(
    `UPDATE files SET status = 'ready'
     WHERE id = ? AND status = 'uploading' AND api_upload_token_hash IS NULL`
  ).bind(id).run();
  if (result.meta.changes !== 1) {
    return errorResponse("アップロード状態を更新できませんでした。", 409);
  }

  return jsonResponse({ ok: true });
}

async function handleFileAuth(request, env, id, purpose) {
  if (!isSameOriginWrite(request)) {
    return errorResponse("このページからの操作のみ受け付けます。", 403);
  }
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const secret = parsed.value.secret ?? "";
  if (!validSecret(secret)) {
    return errorResponse("パスワードまたは削除キーが正しくありません。", 400);
  }

  const file = await env.simple_uploader_db.prepare(
    `SELECT download_password_hash, delete_key_hash FROM files
     WHERE id = ? AND status = 'ready'`
  ).bind(id).first();
  if (!file) return errorResponse("ファイルが見つかりません。", 404);
  const stored = purpose === "download" ? file.download_password_hash : file.delete_key_hash;
  if (purpose === "delete" && stored === null) {
    const result = await env.simple_uploader_db.prepare(
      `DELETE FROM files WHERE id = ? AND status = 'ready' AND delete_key_hash IS NULL`
    ).bind(id).run();
    if (result.meta.changes < 1) return errorResponse("ファイルが見つかりません。", 404);
    return jsonResponse({ ok: true });
  }
  if (!stored) {
    return errorResponse("このファイルにはパスワードが設定されていません。", 409);
  }
  if (!secret) {
    return errorResponse("パスワードまたは削除キーを入力してください。", 400);
  }

  if (!await reserveAuthAttempt(env.simple_uploader_db, id, purpose)) {
    return errorResponse("認証の試行回数が多すぎます。しばらく待ってからお試しください。", 429);
  }
  if (!await verifySecret(secret, stored)) {
    return errorResponse(
      purpose === "delete" ? "削除キーが違います。" : "パスワードが違います。",
      403
    );
  }
  if (purpose === "delete") {
    const result = await env.simple_uploader_db.prepare(
      `DELETE FROM files WHERE id = ? AND status = 'ready' AND delete_key_hash = ?`
    ).bind(id, stored).run();
    if (result.meta.changes < 1) return errorResponse("ファイルが見つかりません。", 404);
    return jsonResponse({ ok: true });
  }

  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.simple_uploader_db.batch([
    env.simple_uploader_db.prepare(`DELETE FROM file_download_tokens WHERE expires_at <= ?`).bind(now),
    env.simple_uploader_db.prepare(
      `INSERT INTO file_download_tokens (token_hash, file_id, expires_at) VALUES (?, ?, ?)`
    ).bind(await tokenHash(token), id, now + DOWNLOAD_TOKEN_TTL_MS),
  ]);
  await clearAuthAttempts(env.simple_uploader_db, id, purpose);
  return jsonResponse({ token });
}

async function handleDownloadRange(request, env, id, url) {
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end - start + 1 > DOWNLOAD_BLOCK_BYTES) {
    return errorResponse("ダウンロード範囲が正しくありません。", 416);
  }

  const file = await env.simple_uploader_db.prepare(
    `SELECT name, size, download_password_hash IS NOT NULL AS has_password
     FROM files WHERE id = ? AND status = 'ready'`
  ).bind(id).first();
  if (!file) return errorResponse("ファイルが見つかりません。", 404);
  if (end >= file.size) return errorResponse("ダウンロード範囲が正しくありません。", 416);

  if (file.has_password) {
    const match = request.headers.get("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/);
    if (!match) return errorResponse("ダウンロードパスワードの認証が必要です。", 401);
    const session = await env.simple_uploader_db.prepare(
      `SELECT 1 AS valid FROM file_download_tokens
       WHERE token_hash = ? AND file_id = ? AND expires_at > ?`
    ).bind(await tokenHash(match[1]), id, Date.now()).first();
    if (!session) return errorResponse("認証の有効期限が切れました。もう一度認証してください。", 401);
  }

  const firstChunk = Math.floor(start / UPLOAD_CHUNK_BYTES);
  const lastChunk = Math.floor(end / UPLOAD_CHUNK_BYTES);
  const result = await env.simple_uploader_db.prepare(
    `SELECT chunk_index, data FROM file_chunks
     WHERE file_id = ? AND chunk_index BETWEEN ? AND ?
     ORDER BY chunk_index`
  ).bind(id, firstChunk, lastChunk).all();

  const output = new Uint8Array(end - start + 1);
  let copied = 0;
  for (const chunk of result.results) {
    const chunkStart = chunk.chunk_index * UPLOAD_CHUNK_BYTES;
    const bytes = new Uint8Array(chunk.data);
    const copyStart = Math.max(start, chunkStart);
    const copyEnd = Math.min(end + 1, chunkStart + bytes.byteLength);
    if (copyEnd <= copyStart) continue;

    const slice = bytes.subarray(copyStart - chunkStart, copyEnd - chunkStart);
    output.set(slice, copyStart - start);
    copied += slice.byteLength;
  }

  if (copied !== output.byteLength) {
    console.error("Stored file chunks are incomplete:", id);
    return errorResponse("保存データが不完全なため、ダウンロードできません。", 500);
  }

  if (start === 0) {
    await env.simple_uploader_db.prepare(
      `UPDATE files SET download_count = download_count + 1 WHERE id = ?`
    ).bind(id).run();
  }

  return new Response(output, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Disposition": contentDisposition(file.name),
      "Content-Length": String(output.byteLength),
      "Content-Range": `bytes ${start}-${end}/${file.size}`,
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/status" && request.method === "GET") {
    return handleStatus(env.simple_uploader_db);
  }
  if (pathname === "/api/files" && request.method === "GET") {
    return handleList(env.simple_uploader_db, url);
  }
  if (pathname === "/api/uploads" && request.method === "POST") {
    return handleUploadStart(request, env);
  }

  const chunkRoute = getChunkRoute(pathname);
  if (chunkRoute && request.method === "POST") {
    return handleUploadChunk(request, env, chunkRoute);
  }

  const completeMatch = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/complete$/i);
  if (completeMatch && request.method === "POST") {
    return handleUploadComplete(request, env, completeMatch[1]);
  }

  const fileId = getFileId(pathname);
  if (fileId && request.method === "GET") {
    return handleDownloadRange(request, env, fileId, url);
  }

  const authMatch = pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/(authorize|delete)$/i);
  if (authMatch && request.method === "POST") {
    return handleFileAuth(request, env, authMatch[1],
      authMatch[2] === "delete" ? "delete" : "download");
  }

  return errorResponse("指定されたAPIはありません。", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
        return await handleV1(request, env, url, {
          jsonResponse, errorResponse, readJson, readBodyLimited, validSecret,
          hashSecret, tokenHash, bytesToHex, removeExpiredUploads,
          handleStatus, handleList, handleFileAuth, handleDownloadRange,
          MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_METADATA_BYTES, UPLOAD_CHUNK_BYTES,
          DOWNLOAD_BLOCK_BYTES, INCOMPLETE_TTL_MS,
        });
      }
      return await handleApi(request, env, url);
    } catch (error) {
      console.error("Uploader request failed:", error);
      return errorResponse("処理中にエラーが発生しました。時間をおいて再度お試しください。", 500);
    }
  },
};

