function error(code, message, status, headers = {}) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function mapFile(row) {
  return {
    id: row.id,
    number: row.file_no,
    name: row.name,
    size: row.size,
    comment: row.comment,
    createdAt: row.created_at,
    downloadCount: row.download_count,
    hasPassword: Boolean(row.has_password),
    hasDeleteKey: Boolean(row.has_delete_key),
  };
}

async function adapt(response, codes) {
  if (response.ok) return response;
  const body = await response.json();
  return error(codes[response.status] || "INTERNAL_ERROR", body.error, response.status);
}

function syntheticRequest(request, body) {
  return new Request(request.url, {
    method: "POST",
    headers: {
      Origin: new URL(request.url).origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function uploadSession(request, db, id, h) {
  const match = request.headers.get("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/);
  if (!match) return null;
  return db.prepare(
    `SELECT id, file_no, size, status, api_upload_expires_at
     FROM files WHERE id = ? AND api_upload_token_hash = ? AND api_upload_expires_at > ?`
  ).bind(id, await h.tokenHash(match[1]), Date.now()).first();
}

const notFoundUpload = () => error("UPLOAD_NOT_FOUND", "アップロードが見つかりません。", 404);
const finalized = () => error("UPLOAD_FINALIZED", "アップロードは完了済みです。", 409);

async function readJson(request, h) {
  const parsed = await h.readJson(request);
  if (!parsed.error) return parsed;
  return { error: await adapt(parsed.error, { 400: "INVALID_REQUEST", 413: "PAYLOAD_TOO_LARGE" }) };
}

async function startUpload(request, env, h) {
  const parsed = await readJson(request, h);
  if (parsed.error) return parsed.error;
  const { name, size, comment = "", password = "", deleteKey = "" } = parsed.value;
  if (typeof name !== "string" || !name.trim() || name.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(name) ||
      !Number.isSafeInteger(size) || size < 1 ||
      typeof comment !== "string" || comment.length > 1000 ||
      !h.validSecret(password) || !h.validSecret(deleteKey)) {
    return error("INVALID_REQUEST", "ファイル情報が正しくありません。", 400);
  }
  if (size > h.MAX_FILE_BYTES) return error("PAYLOAD_TOO_LARGE", "ファイルサイズが上限を超えています。", 413);

  const now = Date.now();
  await h.removeExpiredUploads(env.simple_uploader_db, now);
  const passwordHash = password ? await h.hashSecret(password) : null;
  const deleteHash = deleteKey ? await h.hashSecret(deleteKey) : null;
  const uploadId = crypto.randomUUID();
  const uploadToken = h.bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + h.INCOMPLETE_TTL_MS;
  const result = await env.simple_uploader_db.prepare(
    `INSERT INTO files (id, file_no, name, mime_type, size, comment, created_at, status,
                        download_password_hash, delete_key_hash, api_upload_token_hash, api_upload_expires_at)
     SELECT ?, COALESCE((SELECT MAX(file_no) FROM files), 0) + 1,
            ?, 'application/octet-stream', ?, ?, ?, 'uploading', ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(size), 0) FROM files) + ? <= ?`
  ).bind(uploadId, name, size, comment, now, passwordHash, deleteHash,
    await h.tokenHash(uploadToken), expiresAt, size, h.MAX_TOTAL_BYTES).run();
  if (result.meta.changes !== 1) return error("CAPACITY_EXCEEDED", "保存容量の上限に達しています。", 507);
  return h.jsonResponse({
    uploadId, uploadToken, chunkSize: h.UPLOAD_CHUNK_BYTES,
    chunkCount: Math.ceil(size / h.UPLOAD_CHUNK_BYTES), expiresAt,
  }, 201);
}

async function uploadChunk(request, env, id, indexText, h) {
  const session = await uploadSession(request, env.simple_uploader_db, id, h);
  if (!session) return notFoundUpload();
  if (session.status !== "uploading") return finalized();
  const index = Number(indexText);
  if (!Number.isSafeInteger(index) || index < 0 ||
      index >= Math.ceil(session.size / h.UPLOAD_CHUNK_BYTES)) {
    return error("INVALID_REQUEST", "チャンク番号が正しくありません。", 400);
  }
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/octet-stream") {
    return error("INVALID_REQUEST", "Content-Typeが正しくありません。", 400);
  }
  const expectedHash = request.headers.get("X-Chunk-SHA256");
  if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return error("INVALID_REQUEST", "チャンクのハッシュが正しくありません。", 400);
  }
  let bytes;
  try {
    bytes = await h.readBodyLimited(request, h.UPLOAD_CHUNK_BYTES);
  } catch (e) {
    if (e instanceof RangeError) return error("PAYLOAD_TOO_LARGE", "チャンクのサイズが上限を超えています。", 413);
    throw e;
  }
  if (bytes.length !== Math.min(h.UPLOAD_CHUNK_BYTES, session.size - index * h.UPLOAD_CHUNK_BYTES) ||
      h.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !== expectedHash) {
    return error("INVALID_REQUEST", "チャンクのサイズまたはハッシュが正しくありません。", 400);
  }
  const token = request.headers.get("Authorization").slice(7);
  const hash = await h.tokenHash(token);
  const result = await env.simple_uploader_db.prepare(
    `INSERT OR IGNORE INTO file_chunks (file_id, chunk_index, data)
     SELECT ?, ?, ? WHERE EXISTS (
       SELECT 1 FROM files WHERE id = ? AND status = 'uploading'
       AND api_upload_token_hash = ? AND api_upload_expires_at > ?
     )`
  ).bind(id, index, bytes, id, hash, Date.now()).run();
  if (result.meta.changes === 1) return new Response(null, { status: 204 });
  const current = await uploadSession(request, env.simple_uploader_db, id, h);
  if (!current) return notFoundUpload();
  if (current.status !== "uploading") return finalized();
  const existing = await env.simple_uploader_db.prepare(
    `SELECT data = ? AS matches FROM file_chunks WHERE file_id = ? AND chunk_index = ?`
  ).bind(bytes, id, index).first();
  if (existing?.matches) return new Response(null, { status: 204 });
  return error("CHUNK_CONFLICT", "保存済みのチャンクと内容が異なります。", 409);
}

async function completeUpload(request, env, id, h) {
  const session = await uploadSession(request, env.simple_uploader_db, id, h);
  if (!session) return notFoundUpload();
  if (session.status === "ready") {
    return h.jsonResponse({ id, number: session.file_no, size: session.size });
  }
  const result = await env.simple_uploader_db.prepare(
    `UPDATE files SET status = 'ready'
     WHERE id = ? AND status = 'uploading' AND api_upload_token_hash = ?
       AND api_upload_expires_at > ?
       AND (SELECT COUNT(*) FROM file_chunks WHERE file_id = ?) = ?
       AND (SELECT COALESCE(SUM(length(data)), 0) FROM file_chunks WHERE file_id = ?) = size`
  ).bind(id, await h.tokenHash(request.headers.get("Authorization").slice(7)), Date.now(),
    id, Math.ceil(session.size / h.UPLOAD_CHUNK_BYTES), id).run();
  if (result.meta.changes !== 1) {
    const current = await uploadSession(request, env.simple_uploader_db, id, h);
    if (!current) return notFoundUpload();
    if (current.status === "ready") return h.jsonResponse({ id, number: current.file_no, size: current.size });
    return error("UPLOAD_INCOMPLETE", "ファイルの受信が完了していません。", 409);
  }
  return h.jsonResponse({ id, number: session.file_no, size: session.size });
}

async function cancelUpload(request, env, id, h) {
  const session = await uploadSession(request, env.simple_uploader_db, id, h);
  if (!session) return notFoundUpload();
  if (session.status === "ready") return finalized();
  const result = await env.simple_uploader_db.prepare(
    `DELETE FROM files WHERE id = ? AND status = 'uploading'
     AND api_upload_token_hash = ? AND api_upload_expires_at > ?`
  ).bind(id, await h.tokenHash(request.headers.get("Authorization").slice(7)), Date.now()).run();
  if (result.meta.changes < 1) {
    const current = await uploadSession(request, env.simple_uploader_db, id, h);
    return current?.status === "ready" ? finalized() : notFoundUpload();
  }
  return new Response(null, { status: 204 });
}

async function fileAction(request, env, id, action, h) {
  const parsed = await readJson(request, h);
  if (parsed.error) return parsed.error;
  const secret = action === "authorize" ? parsed.value.password : (
    parsed.value.deleteKey === undefined ? "" : parsed.value.deleteKey
  );
  if (!h.validSecret(secret)) return error("INVALID_REQUEST", "パスワードまたは削除キーが正しくありません。", 400);
  const response = await h.handleFileAuth(
    syntheticRequest(request, { secret }), env, id, action === "authorize" ? "download" : "delete"
  );
  const mapped = await adapt(response, {
    400: "INVALID_REQUEST", 403: "INVALID_SECRET", 404: "FILE_NOT_FOUND",
    409: "PASSWORD_NOT_SET", 429: "RATE_LIMITED",
  });
  if (!mapped.ok || action === "delete") return mapped;
  const body = await mapped.json();
  const session = await env.simple_uploader_db.prepare(
    `SELECT expires_at FROM file_download_tokens WHERE token_hash = ? AND file_id = ?`
  ).bind(await h.tokenHash(body.token), id).first();
  if (!session) return error("FILE_NOT_FOUND", "ファイルが見つかりません。", 404);
  return h.jsonResponse({ token: body.token, expiresAt: session.expires_at });
}

async function download(request, env, id, h) {
  const file = await env.simple_uploader_db.prepare(
    `SELECT size FROM files WHERE id = ? AND status = 'ready'`
  ).bind(id).first();
  if (!file) return error("FILE_NOT_FOUND", "ファイルが見つかりません。", 404);
  const match = request.headers.get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
  const start = match ? Number(match[1]) : NaN;
  const end = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= file.size ||
      end < start || end - start + 1 > h.DOWNLOAD_BLOCK_BYTES) {
    return error("INVALID_RANGE", "ダウンロード範囲が正しくありません。", 416, {
      "Content-Range": `bytes */${file.size}`,
    });
  }
  const url = new URL(request.url);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(Math.min(end, file.size - 1)));
  return adapt(await h.handleDownloadRange(request, env, id, url), {
    401: "AUTH_REQUIRED", 404: "FILE_NOT_FOUND", 416: "INVALID_RANGE", 500: "INTERNAL_ERROR",
  });
}

export async function handleV1(request, env, url, h) {
  try {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return error("ORIGIN_FORBIDDEN", "別オリジンからのアクセスは許可されていません。", 403);
    }
    if (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      return error("INVALID_REQUEST", "HTTPSを使用してください。", 400);
    }
    const path = url.pathname.slice("/api/v1".length);
    if (request.method === "GET" && path === "/status") {
      const status = await (await h.handleStatus(env.simple_uploader_db)).json();
      return h.jsonResponse({ ...status, uploadChunkBytes: h.UPLOAD_CHUNK_BYTES, maxDownloadRangeBytes: h.DOWNLOAD_BLOCK_BYTES });
    }
    if (request.method === "GET" && path === "/files") {
      return await adapt(await h.handleList(env.simple_uploader_db, url), { 400: "INVALID_REQUEST" });
    }
    const byNumber = path.match(/^\/files\/by-number\/(\d+)$/);
    if (request.method === "GET" && byNumber) {
      const number = Number(byNumber[1]);
      if (!Number.isSafeInteger(number) || number < 1) return error("INVALID_REQUEST", "番号が正しくありません。", 400);
      const file = await env.simple_uploader_db.prepare(
        `SELECT id, file_no, name, size, comment, created_at, download_count,
                download_password_hash IS NOT NULL AS has_password,
                delete_key_hash IS NOT NULL AS has_delete_key
         FROM files WHERE file_no = ? AND status = 'ready'`
      ).bind(number).first();
      return file ? h.jsonResponse(mapFile(file)) : error("FILE_NOT_FOUND", "ファイルが見つかりません。", 404);
    }
    if (request.method === "POST" && path === "/uploads") return await startUpload(request, env, h);
    const upload = path.match(/^\/uploads\/([0-9a-f-]{36})(?:\/(chunks\/(\d+)|complete))?$/i);
    if (upload) {
      if (request.method === "PUT" && upload[3] !== undefined) return await uploadChunk(request, env, upload[1], upload[3], h);
      if (request.method === "POST" && upload[2] === "complete") return await completeUpload(request, env, upload[1], h);
      if (request.method === "DELETE" && !upload[2]) return await cancelUpload(request, env, upload[1], h);
    }
    const file = path.match(/^\/files\/([0-9a-f-]{36})\/(authorize|content|delete)$/i);
    if (file) {
      if (request.method === "GET" && file[2] === "content") return await download(request, env, file[1], h);
      if (request.method === "POST" && file[2] !== "content") return await fileAction(request, env, file[1], file[2], h);
    }
    return error("NOT_FOUND", "指定されたAPIはありません。", 404);
  } catch (e) {
    console.error("API v1 request failed:", e);
    return error("INTERNAL_ERROR", "処理中にエラーが発生しました。", 500);
  }
}
