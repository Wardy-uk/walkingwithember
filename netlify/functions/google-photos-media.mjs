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
      return json({
        ok: true,
        configured: missingGoogleEnv.length === 0,
        importConfigured: missingImportEnv.length === 0,
        missingGoogleEnv,
        missingImportEnv,
      }, 200);
    }

    const missingGoogleEnv = getMissingEnvVars(REQUIRED_GOOGLE_ENV);
    if (missingGoogleEnv.length > 0) {
      return json({
        error: `Google Photos Picker integration is not configured. Missing: ${missingGoogleEnv.join(", ")}`,
        missingEnv: missingGoogleEnv,
      }, 500);
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
            return {
              id: String(m.id || ""),
              type: String(m.type || ""),
              createTime: String(m.createTime || ""),
              baseUrl,
              mimeType,
              filename,
              previewUrl: baseUrl ? buildPreviewUrl(baseUrl, mimeType) : "",
              downloadUrl: baseUrl ? buildDownloadUrl(baseUrl, mimeType) : "",
            };
          })
        : [];

      return json({ ok: true, mediaItems, nextPageToken: String(data.nextPageToken || "") }, 200);
    }

    if (action === "import_media") {
      const missingImportEnv = getMissingEnvVars(REQUIRED_IMPORT_ENV);
      if (missingImportEnv.length > 0) {
        return json({
          error: `Import is not configured. Missing: ${missingImportEnv.join(", ")}`,
          missingImportEnv,
        }, 500);
      }

      const baseUrl = String(payload.baseUrl || "").trim();
      const mimeType = String(payload.mimeType || "").toLowerCase();
      const filenameRaw = String(payload.filename || "photo");
      const mediaItemId = String(payload.mediaItemId || filenameRaw || Date.now()).trim();
      if (!baseUrl) return json({ error: "baseUrl is required for import_media" }, 400);

      const binaryResponse = await fetch(buildDownloadUrl(baseUrl, mimeType), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!binaryResponse.ok) {
        const text = await binaryResponse.text();
        return json({ error: `Google Photos binary fetch failed (${binaryResponse.status}): ${text}` }, 502);
      }

      const arr = await binaryResponse.arrayBuffer();
      const contentBase64 = Buffer.from(arr).toString("base64");
      const ext = extensionFromMimeType(mimeType, filenameRaw);
      const safeStem = sanitizeFilename(filenameRaw.replace(/\.[^.]+$/, ""));
      const hash = shortHash(mediaItemId || filenameRaw);
      const fileName = `${safeStem}-${hash}.${ext}`;
      const imagePath = `public/uploads/images/${fileName}`;
      const branch = process.env.GITHUB_BRANCH || "main";

      const write = await upsertRepoFile({
        path: imagePath,
        contentBase64,
        message: `feat(media): import google photo ${fileName}`,
        branch,
      });
      if (!write.ok) return json({ error: write.error }, 502);

      return json(
        {
          ok: true,
          imported: {
            id: mediaItemId,
            filename: filenameRaw || fileName,
            mimeType,
            path: imagePath,
            publicPath: `/${stripPublicPrefix(imagePath)}`,
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
    scope: process.env.GOOGLE_PHOTOS_SCOPE || "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await parseJson(response);
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token exchange failed (${response.status}): ${stringifyError(data)}`);
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

async function upsertRepoFile({ path, contentBase64, message, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  try {
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

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `GitHub commit failed (${response.status}): ${text}` };
    }

    const data = await response.json();
    return { ok: true, data: { path, sha: data.content?.sha, commitUrl: data.commit?.html_url } };
  } catch (error) {
    return { ok: false, error: `GitHub request failed: ${String(error?.message || error)}` };
  }
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

