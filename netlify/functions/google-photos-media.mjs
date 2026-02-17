import crypto from "node:crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUIRED_GOOGLE_ENV = [
  "GOOGLE_PHOTOS_CLIENT_ID",
  "GOOGLE_PHOTOS_CLIENT_SECRET",
  "GOOGLE_PHOTOS_REFRESH_TOKEN",
];

const REQUIRED_IMPORT_ENV = ["GITHUB_TOKEN", "GITHUB_REPO"];

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_PICKER_API = "https://photospicker.googleapis.com/v1";
const MEDIA_ROOT = "public/uploads/images";
const MEDIA_GROUPS_PATH = `${MEDIA_ROOT}/.media-groups.json`;
const MEDIA_META_PATH = `${MEDIA_ROOT}/.media-meta.json`;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "mp4", "mov", "webm"]);

export const handler = async (event, context) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ error: "Missing admin auth token" }, 401);

    const user = context?.clientContext?.user || (await validateIdentityToken(token, event));
    if (!user) return json({ error: "Unauthorized" }, 401);

    let payload;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
      payload = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON payload" }, 400);
    }

    const action = String(payload?.action || "").toLowerCase();

    if (action === "setup") {
      const missingGoogleEnv = getMissingEnvVars(REQUIRED_GOOGLE_ENV);
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      return json(
        {
          ok: true,
          configured: missingGoogleEnv.length === 0,
          importConfigured: missingImportEnv.length === 0,
          missingGoogleEnv,
          missingImportEnv,
        },
        200,
      );
    }

    if (action === "list_site_media") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json({ error: `Media library is not configured. Missing: ${missingImportEnv.join(", ")}`, missingImportEnv }, 500);
      }
      const branch = process.env.GITHUB_BRANCH || "main";
      const [groups, meta, files] = await Promise.all([
        getRepoJsonMap(MEDIA_GROUPS_PATH, branch),
        getRepoJsonMap(MEDIA_META_PATH, branch),
        listRepoMediaFiles(branch),
      ]);
      if (!files.ok) return json({ error: files.error }, 502);
      return json(
        {
          ok: true,
          media: files.items.map((item) => ({
            ...item,
            folder: String(groups.data[item.publicPath] || ""),
            meta: meta.data[item.publicPath] || null,
          })),
          folders: uniqueNonEmpty(Object.values(groups.data || {})),
        },
        200,
      );
    }

    if (action === "delete_site_media") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json({ error: `Delete is not configured. Missing: ${missingImportEnv.join(", ")}`, missingImportEnv }, 500);
      }
      const branch = process.env.GITHUB_BRANCH || "main";
      const publicPath = String(payload.publicPath || "").trim();
      if (!publicPath) return json({ error: "publicPath is required" }, 400);

      const repoPath = toRepoMediaPath(publicPath);
      if (!repoPath) return json({ error: "Invalid publicPath" }, 400);

      const deleted = await deleteRepoFile({
        path: repoPath,
        message: `chore(media): delete ${publicPath}`,
        branch,
      });
      if (!deleted.ok) return json({ error: deleted.error }, 502);

      await removePathFromMaps(publicPath, branch);
      return json({ ok: true, deleted: { publicPath, path: repoPath }, commit: deleted.data?.commitUrl || null }, 200);
    }

    if (action === "set_groups") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json({ error: `Grouping is not configured. Missing: ${missingImportEnv.join(", ")}`, missingImportEnv }, 500);
      }
      const branch = process.env.GITHUB_BRANCH || "main";
      const folder = normalizeFolderName(payload.folder);
      const items = Array.isArray(payload.items) ? payload.items.map((v) => String(v || "").trim()).filter(Boolean) : [];
      if (!folder) return json({ error: "folder is required" }, 400);
      if (items.length === 0) return json({ error: "items is required" }, 400);

      const groups = await getRepoJsonMap(MEDIA_GROUPS_PATH, branch);
      const next = { ...groups.data };
      for (const item of items) next[item] = folder;

      const saved = await upsertRepoJsonFile({
        path: MEDIA_GROUPS_PATH,
        data: next,
        message: `feat(media): assign ${items.length} image(s) to folder ${folder}`,
        branch,
      });
      if (!saved.ok) return json({ error: saved.error }, 502);

      return json({ ok: true, folder, count: items.length, commit: saved.data?.commitUrl || null }, 200);
    }

    if (action === "auto_group") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json({ error: `Auto-group is not configured. Missing: ${missingImportEnv.join(", ")}`, missingImportEnv }, 500);
      }
      const branch = process.env.GITHUB_BRANCH || "main";
      const items = Array.isArray(payload.items) ? payload.items.map((v) => String(v || "").trim()).filter(Boolean) : [];
      if (items.length === 0) return json({ error: "items is required" }, 400);

      const groups = await getRepoJsonMap(MEDIA_GROUPS_PATH, branch);
      const meta = await getRepoJsonMap(MEDIA_META_PATH, branch);
      const next = { ...groups.data };
      let updated = 0;

      for (const publicPath of items) {
        const autoFolder = deriveAutoFolder(meta.data[publicPath] || {});
        if (!autoFolder) continue;
        next[publicPath] = autoFolder;
        updated += 1;
      }

      const saved = await upsertRepoJsonFile({
        path: MEDIA_GROUPS_PATH,
        data: next,
        message: `feat(media): auto-group ${updated} image(s) by gps/date`,
        branch,
      });
      if (!saved.ok) return json({ error: saved.error }, 502);

      return json({ ok: true, updated, commit: saved.data?.commitUrl || null }, 200);
    }

    const missingGoogleEnv = getMissingEnvVars(REQUIRED_GOOGLE_ENV);
    if (missingGoogleEnv.length > 0) {
      return json(
        {
          error: `Google Photos Picker integration is not configured. Missing: ${missingGoogleEnv.join(", ")}`,
          missingEnv: missingGoogleEnv,
        },
        500,
      );
    }

    const accessToken = await getGoogleAccessToken();

    if (action === "create_session") {
      const maxItemCount = clampNumber(payload.maxItemCount, 1, 2000, 200);
      const response = await fetch(`${GOOGLE_PICKER_API}/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItemCount) } }),
      });
      const data = await parseJson(response);
      if (!response.ok) {
        return json({ error: `Picker session create failed (${response.status}): ${stringifyError(data)}` }, 502);
      }
      return json({ ok: true, session: toSessionResponse(data) }, 200);
    }

    if (action === "get_session") {
      const sessionId = String(payload.sessionId || "").trim();
      if (!sessionId) return json({ error: "sessionId is required" }, 400);

      const response = await fetch(`${GOOGLE_PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await parseJson(response);
      if (!response.ok) {
        return json({ error: `Picker session get failed (${response.status}): ${stringifyError(data)}` }, 502);
      }
      return json({ ok: true, session: toSessionResponse(data) }, 200);
    }

    if (action === "list_picked_media" || action === "list_media") {
      const sessionId = String(payload.sessionId || "").trim();
      if (!sessionId) return json({ error: "sessionId is required" }, 400);

      const pageSize = clampNumber(payload.pageSize, 1, 100, 30);
      const pageToken = String(payload.pageToken || "").trim();
      const query = new URLSearchParams({ sessionId, pageSize: String(pageSize) });
      if (pageToken) query.set("pageToken", pageToken);

      const response = await fetch(`${GOOGLE_PICKER_API}/mediaItems?${query.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await parseJson(response);
      if (!response.ok) {
        return json({ error: `Picker media list failed (${response.status}): ${stringifyError(data)}` }, 502);
      }

      const mediaItems = Array.isArray(data.mediaItems)
        ? data.mediaItems.map((m) => {
            const file = m.mediaFile || {};
            const baseUrl = String(file.baseUrl || "");
            const mimeType = String(file.mimeType || "");
            const filename = String(file.filename || `google-photo-${String(m.id || "")}`);
            const geo = extractGeo(file);
            return {
              id: String(m.id || ""),
              type: String(m.type || ""),
              createTime: String(m.createTime || ""),
              baseUrl,
              mimeType,
              filename,
              latitude: geo.latitude,
              longitude: geo.longitude,
              previewUrl: baseUrl ? buildPreviewUrl(baseUrl, mimeType) : "",
              downloadUrl: baseUrl ? buildDownloadUrl(baseUrl, mimeType) : "",
            };
          })
        : [];

      return json({ ok: true, mediaItems, nextPageToken: String(data.nextPageToken || "") }, 200);
    }

    if (action === "preview_import") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json(
          {
            error: `Import is not configured. Missing: ${missingImportEnv.join(", ")}`,
            missingImportEnv,
          },
          500,
        );
      }

      const mimeType = String(payload.mimeType || "").toLowerCase();
      const filenameRaw = String(payload.filename || "photo");
      const mediaItemId = String(payload.mediaItemId || filenameRaw || Date.now()).trim();
      const branch = process.env.GITHUB_BRANCH || "main";
      const target = buildImportTarget({ mimeType, filenameRaw, mediaItemId });
      const existing = await getRepoFileMeta(target.imagePath, branch);
      if (!existing.ok) return json({ error: existing.error }, 502);

      return json(
        {
          ok: true,
          exists: existing.exists,
          importTarget: target,
        },
        200,
      );
    }

    if (action === "import_media") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json(
          {
            error: `Import is not configured. Missing: ${missingImportEnv.join(", ")}`,
            missingImportEnv,
          },
          500,
        );
      }

      const baseUrl = String(payload.baseUrl || "").trim();
      const mimeType = String(payload.mimeType || "").toLowerCase();
      const filenameRaw = String(payload.filename || "photo");
      const mediaItemId = String(payload.mediaItemId || filenameRaw || Date.now()).trim();
      if (!baseUrl) return json({ error: "baseUrl is required for import_media" }, 400);

      const branch = process.env.GITHUB_BRANCH || "main";
      const target = buildImportTarget({ mimeType, filenameRaw, mediaItemId });
      const existing = await getRepoFileMeta(target.imagePath, branch);
      if (!existing.ok) return json({ error: existing.error }, 502);

      const binaryResponse = await fetch(buildDownloadUrl(baseUrl, mimeType), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!binaryResponse.ok) {
        const text = await binaryResponse.text();
        return json({ error: `Google Photos binary fetch failed (${binaryResponse.status}): ${text}` }, 502);
      }

      const arr = await binaryResponse.arrayBuffer();
      const contentBase64 = Buffer.from(arr).toString("base64");

      const write = await upsertRepoFile({
        path: target.imagePath,
        contentBase64,
        message: `feat(media): import google photo ${target.fileName}`,
        branch,
      });
      if (!write.ok) return json({ error: write.error }, 502);

      await upsertMediaMeta(target.publicPath, {
        source: "google_photos",
        mediaItemId,
        filename: filenameRaw,
        mimeType,
        createTime: String(payload.createTime || ""),
        latitude: toFinite(payload.latitude),
        longitude: toFinite(payload.longitude),
      }, branch);

      return json(
        {
          ok: true,
          imported: {
            id: mediaItemId,
            filename: filenameRaw || target.fileName,
            mimeType,
            path: target.imagePath,
            publicPath: target.publicPath,
            alreadyExisted: existing.exists,
          },
          commit: write.data?.commitUrl || null,
        },
        200,
      );
    }

    return json({ error: "Invalid action" }, 400);
  } catch (error) {
    return json({ error: `Unexpected server error: ${String(error?.message || error)}` }, 500);
  }
};

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function deriveBaseUrl(event) {
  if (event.rawUrl) {
    try {
      return new URL(event.rawUrl).origin;
    } catch {}
  }
  const host = event.headers?.host;
  if (!host) return "";
  return `https://${host}`;
}

function sanitizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

async function validateIdentityToken(token, event) {
  const baseUrl = sanitizeBaseUrl(process.env.URL || deriveBaseUrl(event));
  if (!baseUrl) return null;
  try {
    const response = await fetch(`${baseUrl}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getGoogleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_PHOTOS_CLIENT_ID,
    client_secret: process.env.GOOGLE_PHOTOS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_PHOTOS_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await parseJson(response);
  if (!response.ok || !data.access_token) {
    const detail = stringifyError(data);
    const hint =
      response.status === 400
        ? " Regenerate GOOGLE_PHOTOS_REFRESH_TOKEN using the same client ID/secret with scope https://www.googleapis.com/auth/photospicker.mediaitems.readonly."
        : "";
    throw new Error(`Google token exchange failed (${response.status}): ${detail}${hint}`);
  }
  return String(data.access_token);
}

function toSessionResponse(data) {
  return {
    id: String(data?.id || ""),
    pickerUri: String(data?.pickerUri || ""),
    mediaItemsSet: Boolean(data?.mediaItemsSet),
    expireTime: String(data?.expireTime || ""),
    pollingConfig: {
      pollInterval: String(data?.pollingConfig?.pollInterval || ""),
      timeoutIn: String(data?.pollingConfig?.timeoutIn || ""),
    },
  };
}

function buildPreviewUrl(baseUrl, mimeType) {
  if (!baseUrl) return "";
  if (String(mimeType || "").startsWith("video/")) return `${baseUrl}=w512-h512`;
  return `${baseUrl}=w700-h700`;
}

function buildDownloadUrl(baseUrl, mimeType) {
  if (!baseUrl) return "";
  if (String(mimeType || "").startsWith("video/")) return `${baseUrl}=dv`;
  return `${baseUrl}=d`;
}

function buildImportTarget({ mimeType, filenameRaw, mediaItemId }) {
  const ext = extensionFromMimeType(mimeType, filenameRaw);
  const safeStem = sanitizeFilename(String(filenameRaw || "photo").replace(/\.[^.]+$/, ""));
  const hash = shortHash(mediaItemId || filenameRaw || Date.now());
  const fileName = `${safeStem}-${hash}.${ext}`;
  const imagePath = `${MEDIA_ROOT}/${fileName}`;
  return {
    fileName,
    imagePath,
    publicPath: `/${stripPublicPrefix(imagePath)}`,
  };
}

async function getRepoFileMeta(path, branch) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(branch)}`;
  try {
    const response = await fetch(url, { method: "GET", headers: githubHeaders() });
    if (response.status === 404) return { ok: true, exists: false };
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `GitHub file check failed (${response.status}): ${text}` };
    }
    const data = await response.json();
    return { ok: true, exists: true, sha: data.sha || "", size: Number(data.size || 0) };
  } catch (error) {
    return { ok: false, error: `GitHub file check request failed: ${String(error?.message || error)}` };
  }
}

async function getRepoFile(path, branch) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(branch)}`;
  try {
    const response = await fetch(url, { method: "GET", headers: githubHeaders() });
    if (response.status === 404) return { ok: true, exists: false, text: "", sha: "" };
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `GitHub file read failed (${response.status}): ${text}` };
    }
    const data = await response.json();
    const content = Buffer.from(String(data.content || "").replace(/\n/g, ""), "base64").toString("utf8");
    return { ok: true, exists: true, text: content, sha: String(data.sha || "") };
  } catch (error) {
    return { ok: false, error: `GitHub file read request failed: ${String(error?.message || error)}` };
  }
}

async function upsertRepoFile({ path, contentBase64, message, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  try {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const existingResponse = await fetch(url + `?ref=${encodeURIComponent(branch)}`, {
        method: "GET",
        headers: githubHeaders(),
      });
      let sha;
      if (existingResponse.ok) {
        const existing = await existingResponse.json();
        sha = existing.sha;
      }

      const response = await fetch(url, {
        method: "PUT",
        headers: githubHeaders(),
        body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) }),
      });

      if (response.ok) {
        const data = await response.json();
        return { ok: true, data: { path, sha: data.content?.sha, commitUrl: data.commit?.html_url } };
      }

      const text = await response.text();
      if (response.status === 409 && attempt < maxAttempts) {
        await wait(120 * attempt);
        continue;
      }

      return { ok: false, error: `GitHub commit failed (${response.status}): ${text}` };
    }

    return { ok: false, error: "GitHub commit failed after retries" };
  } catch (error) {
    return { ok: false, error: `GitHub request failed: ${String(error?.message || error)}` };
  }
}

async function deleteRepoFile({ path, message, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;
  try {
    const existing = await getRepoFileMeta(path, branch);
    if (!existing.ok) return existing;
    if (!existing.exists || !existing.sha) return { ok: false, error: `File not found: ${path}` };

    const response = await fetch(url, {
      method: "DELETE",
      headers: githubHeaders(),
      body: JSON.stringify({ message, sha: existing.sha, branch }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `GitHub delete failed (${response.status}): ${text}` };
    }
    const data = await response.json();
    return { ok: true, data: { commitUrl: data.commit?.html_url || "" } };
  } catch (error) {
    return { ok: false, error: `GitHub delete request failed: ${String(error?.message || error)}` };
  }
}

async function listRepoMediaFiles(branch) {
  const repo = process.env.GITHUB_REPO;
  try {
    const head = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
      headers: githubHeaders(),
    });
    if (!head.ok) {
      const text = await head.text();
      return { ok: false, error: `GitHub ref lookup failed (${head.status}): ${text}` };
    }
    const headData = await head.json();
    const treeSha = String(headData?.object?.sha || "");
    if (!treeSha) return { ok: false, error: "GitHub branch head SHA missing" };

    const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${treeSha}?recursive=1`, {
      headers: githubHeaders(),
    });
    if (!treeRes.ok) {
      const text = await treeRes.text();
      return { ok: false, error: `GitHub tree read failed (${treeRes.status}): ${text}` };
    }

    const treeData = await treeRes.json();
    const rows = Array.isArray(treeData.tree)
      ? treeData.tree.filter((node) => {
          if (node.type !== "blob") return false;
          const p = String(node.path || "");
          if (!p.startsWith(`${MEDIA_ROOT}/`)) return false;
          if (p === MEDIA_GROUPS_PATH || p === MEDIA_META_PATH) return false;
          const ext = (p.split(".").pop() || "").toLowerCase();
          return IMAGE_EXTENSIONS.has(ext);
        })
      : [];

    const items = rows
      .map((node) => {
        const path = String(node.path || "");
        const publicPath = `/${stripPublicPrefix(path)}`;
        return {
          path,
          publicPath,
          filename: path.split("/").pop() || path,
          sha: String(node.sha || ""),
          size: Number(node.size || 0),
        };
      })
      .sort((a, b) => a.filename.localeCompare(b.filename));

    return { ok: true, items };
  } catch (error) {
    return { ok: false, error: `GitHub tree request failed: ${String(error?.message || error)}` };
  }
}

async function getRepoJsonMap(path, branch) {
  const file = await getRepoFile(path, branch);
  if (!file.ok) return { ok: false, error: file.error, data: {} };
  if (!file.exists || !file.text) return { ok: true, data: {}, sha: "" };
  try {
    const parsed = JSON.parse(file.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: true, data: {}, sha: file.sha || "" };
    return { ok: true, data: parsed, sha: file.sha || "" };
  } catch {
    return { ok: true, data: {}, sha: file.sha || "" };
  }
}

async function upsertRepoJsonFile({ path, data, message, branch }) {
  const contentBase64 = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64");
  return upsertRepoFile({ path, contentBase64, message, branch });
}

async function removePathFromMaps(publicPath, branch) {
  const [groups, meta] = await Promise.all([getRepoJsonMap(MEDIA_GROUPS_PATH, branch), getRepoJsonMap(MEDIA_META_PATH, branch)]);
  if (groups.ok && groups.data && Object.prototype.hasOwnProperty.call(groups.data, publicPath)) {
    const next = { ...groups.data };
    delete next[publicPath];
    await upsertRepoJsonFile({ path: MEDIA_GROUPS_PATH, data: next, message: `chore(media): remove deleted file from groups`, branch });
  }
  if (meta.ok && meta.data && Object.prototype.hasOwnProperty.call(meta.data, publicPath)) {
    const next = { ...meta.data };
    delete next[publicPath];
    await upsertRepoJsonFile({ path: MEDIA_META_PATH, data: next, message: `chore(media): remove deleted file metadata`, branch });
  }
}

async function upsertMediaMeta(publicPath, record, branch) {
  const map = await getRepoJsonMap(MEDIA_META_PATH, branch);
  if (!map.ok) return map;
  const next = { ...map.data, [publicPath]: record };
  return upsertRepoJsonFile({ path: MEDIA_META_PATH, data: next, message: `chore(media): update metadata ${publicPath}`, branch });
}

function deriveAutoFolder(meta) {
  const ym = yearMonthFromIso(meta?.createTime);
  const lat = toFinite(meta?.latitude);
  const lon = toFinite(meta?.longitude);
  const geo = Number.isFinite(lat) && Number.isFinite(lon) ? `gps-${roundCoord(lat)}_${roundCoord(lon)}` : "no-gps";
  const datePart = ym || "undated";
  return `auto/${geo}/${datePart}`;
}

function roundCoord(value) {
  return Number(value).toFixed(2).replace(/\./g, "p").replace(/-/g, "m");
}

function yearMonthFromIso(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeFolderName(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return value
    .split("/")
    .map((part) => sanitizeFilename(part))
    .filter(Boolean)
    .join("/")
    .slice(0, 120);
}

function toRepoMediaPath(publicPath) {
  const p = String(publicPath || "").trim();
  if (!p.startsWith("/uploads/images/")) return "";
  const cleaned = p.replace(/\.{2,}/g, "");
  return `public${cleaned}`;
}

function uniqueNonEmpty(items) {
  return [...new Set((items || []).map((v) => String(v || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function extractGeo(mediaFile) {
  const loc = mediaFile?.location || mediaFile?.geoData || mediaFile?.geo || {};
  return {
    latitude: toFinite(loc.latitude),
    longitude: toFinite(loc.longitude),
  };
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extensionFromMimeType(mimeType, fallbackName) {
  const byMime = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  if (byMime[mimeType]) return byMime[mimeType];
  const match = String(fallbackName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "jpg";
}

function sanitizeFilename(name) {
  return (
    String(name || "upload")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "upload"
  );
}

function shortHash(input) {
  return crypto.createHash("sha1").update(String(input || "")).digest("hex").slice(0, 10);
}

function stripPublicPrefix(path) {
  return String(path || "").replace(/^public\//, "");
}

function encodeURIComponentPath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function getMissingEnvVars(names) {
  return names.filter((key) => !process.env[key]);
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function stringifyError(value) {
  if (!value) return "Unknown error";
  if (typeof value === "string") return value;
  if (value.error?.message) return String(value.error.message);
  if (value.error_description) return String(value.error_description);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "walking-with-ember-media-library",
  };
}
