# 管理手順（生SQL）

管理画面は用意していません。管理はD1への生SQLで行います。認証はCloudflareアカウントとWranglerのログインに任せ、アプリ側に管理者用の認証を持たせないためです。

## 実行方法

`uploader/` ディレクトリで実行します。D1名を `uploader-db` 以外にした場合は読み替えてください。**`wrangler.jsonc` は `remote: true` ですが、SQLの実行時は必ず `--remote` を付けて対象を明示してください。**

```sh
npx wrangler d1 execute uploader-db --remote --command "SELECT 1"
```

- 引用符の内側に `"` を書かないでください。文字列には `'` を使います。
- 長いSQLは `--file admin.sql` でも実行できます。
- 以下の `12` や `<UUID>` は実際の値に置き換えます。
- 変更前に**必ず同じ `WHERE` の `SELECT` で対象を確認**します。`WHERE` のない `DELETE`・`UPDATE` は書かないでください。
- D1は外部キー制約が有効で、`files` の行を消すと `file_chunks`・`file_download_tokens`・`file_auth_attempts` も一緒に消えます。
- 日時は Unix ミリ秒で、UTCです。以下では `datetime(created_at / 1000, 'unixepoch')` で読みやすくします。
- D1の無料枠には1日の読み取り行数の上限があります。`file_chunks` を走査するクエリは行数を多く読むため、必要なときだけ使います。

## 状況の確認

公開中のファイルと、アップロード途中のファイルを新しい順に見ます。

```sql
SELECT file_no, id, name, size, status, download_count,
       download_password_hash IS NOT NULL AS has_password,
       delete_key_hash IS NOT NULL AS has_delete_key,
       datetime(created_at / 1000, 'unixepoch') AS created_utc, comment
FROM files ORDER BY file_no DESC LIMIT 50;
```

容量の予約状況です（`file_chunks` を読まないため軽いです）。

```sql
SELECT COALESCE(SUM(size), 0) AS reserved_bytes,
       ROUND(COALESCE(SUM(size), 0) / 1048576.0, 1) AS reserved_mib,
       SUM(status = 'ready') AS ready_files,
       SUM(status = 'uploading') AS uploading_files
FROM files;
```

名前やコメントから探します。

```sql
SELECT file_no, id, name, size, comment FROM files
WHERE name LIKE '%keyword%' OR comment LIKE '%keyword%' ORDER BY file_no DESC;
```

サイズの大きいファイルを確認します。

```sql
SELECT file_no, id, name, size FROM files ORDER BY size DESC LIMIT 10;
```

## ファイルの削除

通報などで削除するときは、削除キーは不要です。**番号は再利用されることがあるため、UUIDを控えてからUUIDで削除するのが安全です。**

```sql
-- 1. 対象を確認する
SELECT file_no, id, name, size, comment FROM files WHERE file_no = 12;

-- 2. 確認したUUIDで削除する
DELETE FROM files WHERE id = '<UUID>';

-- 3. 消えたことを確認する
SELECT COUNT(*) AS remaining FROM files WHERE id = '<UUID>';
```

特定のファイル名を持つ投稿をまとめて削除するときは、先に件数と内容を確認します。

```sql
SELECT file_no, id, name FROM files WHERE name = 'bad.zip';
DELETE FROM files WHERE name = 'bad.zip';
```

## 未完了アップロードの掃除

アップロード途中のまま放置されたファイルは、通常は次のアップロード開始時に24時間後に自動削除されます。すぐ容量を空けたいときは手動で削除します。

```sql
SELECT file_no, id, name, size, datetime(created_at / 1000, 'unixepoch') AS created_utc
FROM files WHERE status = 'uploading';

DELETE FROM files
WHERE status = 'uploading'
  AND created_at < (CAST(strftime('%s', 'now') AS INTEGER) - 86400) * 1000;
```

## 認証情報の掃除

期限切れのダウンロードトークンと、古い認証の試行回数を削除します。

```sql
DELETE FROM file_download_tokens
WHERE expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;

DELETE FROM file_auth_attempts
WHERE window_start < (CAST(strftime('%s', 'now') AS INTEGER) - 3600) * 1000;
```

## パスワード・削除キーの設定変更

利用者がダウンロードパスワードや削除キーを忘れたときの対応です。

```sql
-- ダウンロードパスワードを解除する（誰でも取得可能になる）
UPDATE files SET download_password_hash = NULL WHERE id = '<UUID>';

-- 削除キーを解除する（**誰でも削除可能になる**）
UPDATE files SET delete_key_hash = NULL WHERE id = '<UUID>';
```

ハッシュはPBKDF2の一方向ハッシュで、SQLから元のパスワードを知る方法はありません。新しいパスワードを設定するにはファイルを再投稿してもらいます。削除キーを解除すると、そのファイルは誰でも削除できます。

## 整合性の確認

公開中のファイルのチャンク数と合計サイズが、記録と一致するかを調べます。`file_chunks` を走査するため、**1ファイルずつ**確認してください。

```sql
SELECT f.size AS expected_size, COUNT(c.chunk_index) AS chunks,
       (f.size + 65535) / 65536 AS expected_chunks,
       COALESCE(SUM(length(c.data)), 0) AS stored_size
FROM files AS f LEFT JOIN file_chunks AS c ON c.file_id = f.id
WHERE f.id = '<UUID>' GROUP BY f.id;
```

`expected_chunks` と `chunks`、`expected_size` と `stored_size` が一致していれば正常です。

## 復旧

誤って消してしまった場合は、D1のTime Travelで過去の時点に戻せる可能性があります。ただし**データベース全体が戻る**ため、その間の投稿や削除も失われます。実行前に必ず現在の状態を確認し、次のコマンドで利用できる時点を確認してください。

```sh
npx wrangler d1 time-travel info uploader-db
```

## 公開運用での補足

- 通報を受け付ける連絡先を決め、対応手順（確認、削除、記録）を決めておきます。
- 違法・有害なファイルは、速やかに削除します。
- 認証を伴う管理画面が将来必要になった場合は、独自のパスワード認証を作らず、Cloudflare Accessなどの外部の認証に任せることを検討してください。
