const UPLOAD_CHUNK_BYTES = 64 * 1024;
const DOWNLOAD_BLOCK_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

const form = document.querySelector("#upload-form");
const fileInput = document.querySelector("#file-input");
const commentInput = document.querySelector("#comment-input");
const passwordInput = document.querySelector("#password-input");
const deleteKeyInput = document.querySelector("#delete-key-input");
const uploadButton = document.querySelector("#upload-button");
const cancelButton = document.querySelector("#cancel-button");
const uploadProgress = document.querySelector("#upload-progress");
const uploadStatus = document.querySelector("#upload-status");
const storageUsage = document.querySelector("#storage-usage");
const storageProgress = document.querySelector("#storage-progress");
const fileList = document.querySelector("#file-list");
const listStatus = document.querySelector("#list-status");
const moreButton = document.querySelector("#more-button");
const secretDialog = document.querySelector("#secret-dialog");
const secretForm = document.querySelector("#secret-form");
const secretInput = document.querySelector("#secret-input");

let uploadController = null;
let listCursor = null;
let loadingMore = false;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.error) message = body.error;
    } catch {
      // Use the HTTP status when the server does not return JSON.
    }
    throw new Error(message);
  }
  return response;
}

async function refreshStatus() {
  const response = await api("/api/status");
  const status = await response.json();
  storageUsage.textContent =
    `保存予約容量: ${formatBytes(status.reservedBytes)} / ${formatBytes(status.capacityBytes)} ` +
    `（公開済み ${status.fileCount} 件）`;
  storageProgress.value = Math.min(1, status.reservedBytes / status.capacityBytes);
  storageProgress.hidden = false;
}

function createFileRow(file) {
  const row = document.createElement("tr");
  const number = document.createElement("td");
  number.className = "number";
  number.textContent = String(file.number);

  const details = document.createElement("td");
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = file.name;
  details.append(name);
  if (file.comment || file.hasPassword) {
    const comment = document.createElement("span");
    comment.className = "file-comment";
    if (file.hasPassword) {
      const lock = document.createElement("span");
      lock.className = "lock-indicator";
      lock.textContent = "🔒";
      lock.setAttribute("aria-label", "ダウンロードパスワード付き");
      lock.title = "ダウンロードパスワード付き";
      comment.append(lock);
    }
    if (file.comment) comment.append(document.createTextNode(file.comment));
    details.append(comment);
  }

  const size = document.createElement("td");
  size.className = "size";
  size.textContent = formatBytes(file.size);

  const date = document.createElement("td");
  date.className = "date";
  date.textContent = formatDate(file.createdAt);

  const downloads = document.createElement("td");
  downloads.className = "downloads";
  downloads.textContent = String(file.downloadCount);

  const action = document.createElement("td");
  action.className = "file-actions";
  const button = document.createElement("button");
  button.className = "download-button";
  button.type = "button";
  button.textContent = "ダウンロード";
  button.addEventListener("click", () => downloadFile(file, button));
  action.append(button);
  const deleteButton = document.createElement("button");
  deleteButton.className = "secondary download-button";
  deleteButton.type = "button";
  deleteButton.textContent = "削除";
  deleteButton.addEventListener("click", () => deleteFile(file, deleteButton));
  action.append(deleteButton);

  row.append(number, details, size, date, downloads, action);
  return row;
}

async function loadFiles({ append = false } = {}) {
  if (loadingMore) return;
  loadingMore = true;
  listStatus.textContent = append ? "読み込み中…" : "";
  listStatus.classList.remove("error");
  moreButton.disabled = true;

  try {
    const query = append && listCursor ? `?before=${listCursor}` : "";
    const response = await api(`/api/files${query}`);
    const result = await response.json();
    if (!append) fileList.replaceChildren();
    for (const file of result.files) {
      fileList.append(createFileRow(file));
    }
    listCursor = result.nextCursor;
    moreButton.hidden = listCursor === null;
    listStatus.textContent = result.files.length === 0 && !append
      ? "ファイルはまだありません。"
      : "";
    await refreshStatus();
  } catch (error) {
    listStatus.textContent = `一覧を読み込めませんでした: ${error.message}`;
    listStatus.classList.add("error");
  } finally {
    loadingMore = false;
    moreButton.disabled = false;
  }
}

async function uploadChunk(id, index, bytes, signal) {
  const url = `/api/uploads/${id}/chunks/${index}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
        signal,
      });
      return;
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === 2) throw error;
    }
  }
  throw lastError;
}

async function uploadFile(file, comment, password, deleteKey, signal) {
  const initResponse = await api("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, comment, password, deleteKey }),
    signal,
  });
  const init = await initResponse.json();
  if (init.chunkSize !== UPLOAD_CHUNK_BYTES) {
    throw new Error("サーバーとチャンク設定が一致しません。");
  }

  let nextIndex = 0;
  let completed = 0;
  let failure = null;
  const workers = Array.from(
    { length: Math.min(UPLOAD_CONCURRENCY, init.chunkCount) },
    async () => {
      while (!failure && !signal.aborted) {
        const index = nextIndex++;
        if (index >= init.chunkCount) return;
        const start = index * init.chunkSize;
        try {
          await uploadChunk(
            init.id,
            index,
            file.slice(start, Math.min(file.size, start + init.chunkSize)),
            signal
          );
          completed++;
          uploadProgress.value = completed / init.chunkCount;
          uploadStatus.textContent =
            `アップロード中… ${Math.floor(completed / init.chunkCount * 100)}%`;
        } catch (error) {
          failure = error;
          uploadController.abort();
          return;
        }
      }
    }
  );
  await Promise.all(workers);
  if (failure) throw failure;
  if (signal.aborted) throw new DOMException("中止しました。", "AbortError");

  await api(`/api/uploads/${init.id}/complete`, {
    method: "POST",
    signal,
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) return;

  if (file.size > MAX_FILE_BYTES) {
    uploadStatus.textContent = "ファイルは100MiB以下にしてください。";
    uploadStatus.classList.add("error");
    return;
  }

  uploadController = new AbortController();
  uploadButton.disabled = true;
  cancelButton.hidden = false;
  uploadProgress.hidden = false;
  uploadProgress.value = 0;
  uploadStatus.classList.remove("error");
  uploadStatus.textContent = "アップロードを準備しています…";

  try {
    await uploadFile(file, commentInput.value, passwordInput.value, deleteKeyInput.value,
      uploadController.signal);
    uploadStatus.textContent = "アップロードが完了しました。";
    fileInput.value = "";
    commentInput.value = "";
    passwordInput.value = "";
    deleteKeyInput.value = "";
    await loadFiles();
  } catch (error) {
    uploadStatus.textContent = error.name === "AbortError"
      ? "アップロードを中止しました。未完了データは24時間後に削除されます。"
      : `アップロードに失敗しました: ${error.message}`;
    uploadStatus.classList.add("error");
  } finally {
    uploadController = null;
    uploadButton.disabled = false;
    cancelButton.hidden = true;
    uploadProgress.hidden = true;
  }
});

cancelButton.addEventListener("click", () => uploadController?.abort());
moreButton.addEventListener("click", () => loadFiles({ append: true }));
document.querySelector("#refresh-button").addEventListener("click", () => loadFiles());

function requestSecret(file, purpose) {
  if (secretDialog.open) {
    throw new Error("ほかの認証画面を閉じてからお試しください。");
  }
  return new Promise((resolve) => {
    const label = purpose === "delete" ? "削除キー" : "ダウンロードパスワード";
    document.querySelector("#secret-title").textContent = label;
    document.querySelector("#secret-label").textContent = label;
    document.querySelector("#secret-description").textContent =
      `「${file.name}」の${label}を入力してください。`;
    secretInput.value = "";

    function finish(value) {
      secretForm.removeEventListener("submit", submit);
      secretDialog.removeEventListener("close", close);
      secretInput.value = "";
      if (secretDialog.open) secretDialog.close();
      resolve(value);
    }

    function submit(event) {
      event.preventDefault();
      finish(secretInput.value);
    }

    function close() {
      finish(null);
    }

    secretForm.addEventListener("submit", submit);
    secretDialog.addEventListener("close", close);
    secretDialog.showModal();
    secretInput.focus();
  });
}

document.querySelector("#secret-cancel").addEventListener("click", () => secretDialog.close());

async function authenticateFile(file, action, secret) {
  const response = await api(`/api/files/${file.id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  return response.json();
}

async function deleteFile(file, button) {
  button.disabled = true;
  try {
    let secret = "";
    if (file.hasDeleteKey) {
      secret = await requestSecret(file, "delete");
      if (secret === null) return;
    }
    if (!window.confirm(`「${file.name}」を削除します。この操作は取り消せません。`)) return;
    await authenticateFile(file, "delete", secret);
    await loadFiles();
    listStatus.textContent = "ファイルを削除しました。";
  } catch (error) {
    listStatus.textContent = `削除に失敗しました: ${error.message}`;
    listStatus.classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function downloadFile(file, button) {
  button.disabled = true;
  const originalText = button.textContent;
  const totalBlocks = Math.ceil(file.size / DOWNLOAD_BLOCK_BYTES);
  try {
    listStatus.textContent = "";
    listStatus.classList.remove("error");
    let token = null;
    if (file.hasPassword) {
      const secret = await requestSecret(file, "download");
      if (secret === null) return;
      const result = await authenticateFile(file, "authorize", secret);
      token = result.token;
    }
    const output = new Uint8Array(file.size);
    for (let block = 0; block < totalBlocks; block++) {
      const start = block * DOWNLOAD_BLOCK_BYTES;
      const end = Math.min(file.size, start + DOWNLOAD_BLOCK_BYTES) - 1;
      const response = await api(
        `/api/files/${file.id}/range?start=${start}&end=${end}`,
        { headers: {
          Range: `bytes=${start}-${end}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        } }
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== end - start + 1) {
        throw new Error("受信したデータのサイズが一致しません。");
      }
      output.set(bytes, start);
      button.textContent = `取得中 ${Math.floor((block + 1) / totalBlocks * 100)}%`;
    }

    const blob = new Blob([output], { type: "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    const downloads = button.closest("tr").querySelector(".downloads");
    downloads.textContent = String(file.downloadCount + 1);
    file.downloadCount++;
  } catch (error) {
    listStatus.textContent = `ダウンロードに失敗しました: ${error.message}`;
    listStatus.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

loadFiles();
