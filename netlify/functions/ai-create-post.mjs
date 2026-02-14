import crypto from "node:crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUIRED_ENV_GENERATE = ["OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_REPO"];

export const handler = async (event) => {
  try {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return json({ error: "Missing admin auth token" }, 401);
  }

  const user = await validateIdentityToken(token, event);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON payload" }, 400);
  }

  const action = payload?.action || "generate_post";
  if (action === "analyze_gpx") {
    const gpxValidationError = validateGpxAnalyzePayload(payload);
    if (gpxValidationError) {
      return json({ error: gpxValidationError }, 400);
    }
    const gpxSummary = parseGpx(payload.gpxFile.contentBase64, payload.gpxFile.name);
    if (!gpxSummary.ok) {
      return json({ error: gpxSummary.error }, 400);
    }
    return json({ ok: true, gpxSummary: gpxSummary.data }, 200);
  }

  if (action !== "generate_post") {
    return json({ error: "Invalid action" }, 400);
  }

  for (const key of REQUIRED_ENV_GENERATE) {
    if (!process.env[key]) {
      return json({ error: `Missing required environment variable: ${key}` }, 500);
    }
  }

  const validationError = validateGeneratePayload(payload);
  if (validationError) {
    return json({ error: validationError }, 400);
  }

  const now = new Date();
  const branch = process.env.GITHUB_BRANCH || "main";
  const siteBaseUrl = sanitizeBaseUrl(process.env.SITE_BASE_URL || process.env.URL || deriveBaseUrl(event) || "https://example.com");

  const gpxSummary = parseGpx(payload.gpxFile.contentBase64, payload.gpxFile.name);
  if (!gpxSummary.ok) {
    return json({ error: gpxSummary.error }, 400);
  }

  const walkSlugBase = slugify(payload.walkTitle || payload.answers?.where_walked || `walk-${now.toISOString().slice(0, 10)}`);
  const walkSlug = `${walkSlugBase}-${now.toISOString().slice(0, 10)}`;
  const blogSlugBase = slugify(payload.blogTitle || `${walkSlugBase}-journal`);
  const blogSlug = `${blogSlugBase}-${now.toISOString().slice(0, 10)}`;

  const imageArtifacts = await buildImageArtifacts(payload.images);
  if (!imageArtifacts.ok) {
    return json({ error: imageArtifacts.error }, 400);
  }

  const content = await generateContent({
    payload,
    gpxSummary: gpxSummary.data,
    imageSummaries: imageArtifacts.data.map((img) => ({ path: img.path, caption: img.caption, alt: img.alt })),
    walkSlug,
    blogSlug,
    publishDate: now.toISOString().slice(0, 10),
  });

  if (!content.ok) {
    return json({ error: content.error }, 502);
  }

  const commitResults = [];
  for (const img of imageArtifacts.data) {
    const result = await upsertRepoFile({
      path: img.path,
      contentBase64: img.contentBase64,
      message: `chore(ai): add image asset ${img.path}`,
      branch,
    });
    if (!result.ok) return json({ error: result.error }, 502);
    commitResults.push(result.data);
  }

  const gpxPath = `public/uploads/gpx/${walkSlug}.gpx`;
  const gpxResult = await upsertRepoFile({
    path: gpxPath,
    contentBase64: payload.gpxFile.contentBase64,
    message: `chore(ai): add gpx file ${gpxPath}`,
    branch,
  });
  if (!gpxResult.ok) return json({ error: gpxResult.error }, 502);
  commitResults.push(gpxResult.data);

  let walkPath = null;
  let blogPath = null;

  if (payload.postMode === "walk" || payload.postMode === "both") {
    walkPath = `src/content/walks/${walkSlug}.md`;
    const walkMarkdown = createWalkMarkdown({
      content: content.data,
      payload,
      gpxSummary: gpxSummary.data,
      publishDate: now.toISOString().slice(0, 10),
      gpxPublicUrl: `${siteBaseUrl}/uploads/gpx/${walkSlug}.gpx`,
      heroImage: imageArtifacts.data[0]?.publicPath || "/images/uploads/ember-walking.jpg",
      imageSummaries: imageArtifacts.data,
    });
    const walkResult = await upsertRepoFile({
      path: walkPath,
      contentBase64: toBase64Utf8(walkMarkdown),
      message: `feat(ai): create walk post ${walkSlug}`,
      branch,
    });
    if (!walkResult.ok) return json({ error: walkResult.error }, 502);
    commitResults.push(walkResult.data);
  }

  if (payload.postMode === "blog" || payload.postMode === "both") {
    blogPath = `src/content/blog/${blogSlug}.md`;
    const blogMarkdown = createBlogMarkdown({
      content: content.data,
      payload,
      publishDate: now.toISOString().slice(0, 10),
      coverImage: imageArtifacts.data[0]?.publicPath || "/images/uploads/ember-walking.jpg",
      includeWalkRelation: payload.postMode === "both",
      walkSlug,
      imageSummaries: imageArtifacts.data,
    });
    const blogResult = await upsertRepoFile({
      path: blogPath,
      contentBase64: toBase64Utf8(blogMarkdown),
      message: `feat(ai): create blog post ${blogSlug}`,
      branch,
    });
    if (!blogResult.ok) return json({ error: blogResult.error }, 502);
    commitResults.push(blogResult.data);
  }

  return json(
    {
      ok: true,
      createdBy: user.email || user.id || "admin",
      branch,
      created: {
        walkPath,
        blogPath,
        gpxPath,
        imagePaths: imageArtifacts.data.map((x) => x.path),
      },
      commits: commitResults.map((r) => r.commitUrl).filter(Boolean),
    },
    200
  );
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

function validateGeneratePayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  if (!["walk", "blog", "both"].includes(payload.postMode)) return "Invalid postMode";
  if (!payload.answers || typeof payload.answers !== "object") return "answers are required";
  if (!payload.gpxFile || !payload.gpxFile.contentBase64 || !payload.gpxFile.name) return "GPX file is required";
  if (!payload.stravaRecord || !payload.stravaFlyby) return "Strava URLs are required";
  if (!Array.isArray(payload.images) || payload.images.length === 0) return "At least one image is required";
  return null;
}

function validateGpxAnalyzePayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  if (!payload.gpxFile || !payload.gpxFile.contentBase64 || !payload.gpxFile.name) return "GPX file is required";
  return null;
}

function sanitizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function parseGpx(contentBase64, name) {
  const isGpx = String(name || "").toLowerCase().endsWith(".gpx");
  if (!isGpx) return { ok: false, error: "Uploaded route file must be a .gpx" };

  let xml = "";
  try {
    xml = Buffer.from(contentBase64, "base64").toString("utf8");
  } catch {
    return { ok: false, error: "Unable to decode GPX file" };
  }

  const points = [
    ...extractPoints(xml, "trkpt"),
    ...extractPoints(xml, "rtept"),
  ];

  if (points.length < 2) return { ok: false, error: "GPX did not contain enough track points" };

  let meters = 0;
  let ascentMeters = 0;
  for (let i = 1; i < points.length; i += 1) {
    meters += haversineMeters(points[i - 1], points[i]);
    if (Number.isFinite(points[i - 1].ele) && Number.isFinite(points[i].ele) && points[i].ele > points[i - 1].ele) {
      ascentMeters += points[i].ele - points[i - 1].ele;
    }
  }

  const elevations = points.map((p) => p.ele).filter((v) => Number.isFinite(v));
  const hasElevation = elevations.length > 1;
    const minMaxElevation = getMinMax(elevations);
  const minElevationMeters = hasElevation ? Math.round(minMaxElevation.min) : null;
  const maxElevationMeters = hasElevation ? Math.round(minMaxElevation.max) : null;
  const timeValues = points.map((p) => p.timeMs).filter((v) => Number.isFinite(v));
  const hasTime = timeValues.length > 1;
  const elapsedSeconds = hasTime ? Math.max(0, Math.round((timeValues[timeValues.length - 1] - timeValues[0]) / 1000)) : null;

  const distanceMiles = Number((meters / 1609.344).toFixed(2));
  const durationHours = elapsedSeconds && elapsedSeconds > 0 ? elapsedSeconds / 3600 : null;
  const avgMph = durationHours && distanceMiles > 0 ? Number((distanceMiles / durationHours).toFixed(2)) : null;
  const avgPaceMinPerMile = durationHours && distanceMiles > 0 ? Number(((durationHours * 60) / distanceMiles).toFixed(2)) : null;
  const elapsedHms = elapsedSeconds ? formatDuration(elapsedSeconds) : null;

  return {
    ok: true,
    data: {
      points: points.length,
      startLat: Number(points[0].lat.toFixed(6)),
      startLng: Number(points[0].lon.toFixed(6)),
      centerLat: Number(average(points.map((p) => p.lat)).toFixed(6)),
      centerLng: Number(average(points.map((p) => p.lon)).toFixed(6)),
      distanceMiles,
      elevationGainFeet: Math.round(ascentMeters * 3.28084),
      minElevationMeters,
      maxElevationMeters,
      elapsedSeconds,
      elapsedHms,
      avgMph,
      avgPaceMinPerMile,
    },
  };
}

function extractPoints(xml, tagName) {
  const points = [];
  const blockRegex = new RegExp(`<${tagName}[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "g");
  let match;
  while ((match = blockRegex.exec(xml)) !== null) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    const block = match[3] || "";
    const eleMatch = block.match(/<ele>([^<]+)<\/ele>/);
    const timeMatch = block.match(/<time>([^<]+)<\/time>/);
    const ele = eleMatch ? Number(eleMatch[1]) : null;
    const ts = timeMatch ? Date.parse(timeMatch[1]) : null;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({
        lat,
        lon,
        ele: Number.isFinite(ele) ? ele : null,
        timeMs: Number.isFinite(ts) ? ts : null,
      });
    }
  }

  const selfClosingRegex = new RegExp(`<${tagName}[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*\/>`, "g");
  while ((match = selfClosingRegex.exec(xml)) !== null) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({ lat, lon, ele: null, timeMs: null });
    }
  }

  return points;
}
function getMinMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: null, max: null };
  }
  return { min, max };
}
function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = degToRad(b.lat - a.lat);
  const dLon = degToRad(b.lon - a.lon);
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degToRad(a.lat)) * Math.cos(degToRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function degToRad(v) {
  return (v * Math.PI) / 180;
}

function average(values) {
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

async function buildImageArtifacts(images) {
  const out = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!image?.contentBase64 || !image?.name || !image?.mimeType) {
      return { ok: false, error: `Invalid image input at index ${i}` };
    }

    const safeName = sanitizeFilename(image.name);
    const hash = crypto.createHash("sha1").update(`${Date.now()}-${safeName}-${i}`).digest("hex").slice(0, 10);
    const ext = getImageExtension(image.mimeType, safeName);
    const filename = `${safeName.replace(/\.[^.]+$/, "")}-${hash}.${ext}`;
    const path = `public/uploads/images/${filename}`;
    const publicPath = `/uploads/images/${filename}`;

    const readableName = toReadableLabel(safeName.replace(/\.[^.]+$/, ""));
    out.push({
      path,
      publicPath,
      contentBase64: image.contentBase64,
      alt: truncate(`Peak District trail photo: ${readableName}`, 140),
      caption: truncate(`Peak District route image: ${readableName}.`, 180),
    });
  }
  return { ok: true, data: out };
}

async function generateContent({ payload, gpxSummary, imageSummaries, walkSlug, blogSlug, publishDate }) {
  const response = await callOpenAi({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You are writing content for a UK hiking website.",
              "Use answers as source truth. Avoid fabricated specifics.",
              "Tone: personal, practical, reflective, concise.",
              "Return strict JSON only.",
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(
              {
                postMode: payload.postMode,
                publishDate,
                walkSlug,
                blogSlug,
                gpxSummary,
                answers: payload.answers,
                stravaRecord: payload.stravaRecord,
                stravaFlyby: payload.stravaFlyby,
                imageSummaries,
                extraNotes: payload.extraNotes || "",
              },
              null,
              2
            ),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "post_content",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            walk: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                location: { type: "string" },
                region: { type: "string" },
                difficulty: { type: "string", enum: ["Easy", "Moderate", "Hard"] },
                parking: { type: "string" },
                dogFriendly: { type: "boolean" },
                tags: { type: "array", items: { type: "string" } },
                routeNotesMarkdown: { type: "string" },
              },
              required: ["title", "summary", "location", "region", "difficulty", "parking", "dogFriendly", "tags", "routeNotesMarkdown"],
            },
            blog: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                excerpt: { type: "string" },
                bodyMarkdown: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
              },
              required: ["title", "excerpt", "bodyMarkdown", "tags"],
            },
          },
          required: ["walk", "blog"],
        },
      },
    },
  });

  if (!response.ok) return response;
  try {
    return { ok: true, data: JSON.parse(response.data.outputText) };
  } catch {
    return { ok: false, error: "Failed to parse generated content" };
  }
}

async function callOpenAi(body) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `OpenAI request failed (${response.status}): ${text}` };
    }

    const data = await response.json();
    const outputText = extractOutputText(data);
    if (!outputText) return { ok: false, error: "OpenAI response missing output text" };
    return { ok: true, data: { outputText } };
  } catch (error) {
    return { ok: false, error: `OpenAI call failed: ${String(error?.message || error)}` };
  }
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function createWalkMarkdown({ content, payload, gpxSummary, publishDate, gpxPublicUrl, heroImage, imageSummaries }) {
  const walk = content.walk;
  const tags = dedupeStrings(walk.tags).slice(0, 8);

  return [
    "---",
    `title: ${quoteYaml(walk.title)}`,
    `summary: ${quoteYaml(truncate(walk.summary, 230))}`,
    `heroImage: ${quoteYaml(heroImage)}`,
    `publishDate: ${publishDate}`,
    `difficulty: ${quoteYaml(walk.difficulty)}`,
    `distance: ${Number.isFinite(gpxSummary.distanceMiles) ? gpxSummary.distanceMiles : 0}`,
    `location: ${quoteYaml(walk.location)}`,
    `region: ${quoteYaml(walk.region)}`,
    `dogFriendly: ${walk.dogFriendly ? "true" : "false"}`,
    `parking: ${quoteYaml(walk.parking)}`,
    `gpxDownload: ${quoteYaml(gpxPublicUrl)}`,
    `stravaRecord: ${quoteYaml(payload.stravaRecord)}`,
    `stravaFlyby: ${quoteYaml(payload.stravaFlyby)}`,
    "tags:",
    ...tags.map((tag) => `  - ${quoteYaml(tag)}`),
    `routeMapLat: ${gpxSummary.centerLat}`,
    `routeMapLng: ${gpxSummary.centerLng}`,
    "routeMapZoom: 12",
    "draft: true",
    "---",
    walk.routeNotesMarkdown.trim(),
    "",
    "## Route data",
    `- Distance from GPX: ${gpxSummary.distanceMiles} mi`,
    `- Elevation gain from GPX: ${gpxSummary.elevationGainFeet} ft`,
    ...(gpxSummary.elapsedHms ? [`- GPX elapsed time: ${gpxSummary.elapsedHms}`] : []),
    ...(gpxSummary.avgMph ? [`- Average speed (from GPX time): ${gpxSummary.avgMph} mph`] : []),
    ...(gpxSummary.avgPaceMinPerMile ? [`- Average pace (from GPX time): ${gpxSummary.avgPaceMinPerMile} min/mi`] : []),
    "",
    "## Photo highlights",
    ...(imageSummaries.length
      ? imageSummaries.map((img) => `- ![${escapeInline(img.alt)}](${img.publicPath}) ${img.caption}`)
      : ["- Photos uploaded with this walk."]),
    "",
  ].join("\n");
}

function createBlogMarkdown({ content, payload, publishDate, coverImage, includeWalkRelation, walkSlug, imageSummaries }) {
  const blog = content.blog;
  const tags = dedupeStrings(blog.tags).slice(0, 8);

  const lines = [
    "---",
    `title: ${quoteYaml(blog.title)}`,
    `excerpt: ${quoteYaml(truncate(blog.excerpt, 250))}`,
    `coverImage: ${quoteYaml(coverImage)}`,
    `author: ${quoteYaml(payload.author || "Nick")}`,
    `publishDate: ${publishDate}`,
    "tags:",
    ...tags.map((tag) => `  - ${quoteYaml(tag)}`),
    "relatedWalks:",
  ];

  if (includeWalkRelation) lines.push(`  - ${quoteYaml(walkSlug)}`);
  lines.push("draft: true", "---", blog.bodyMarkdown.trim(), "", "## Photo captions");

  if (imageSummaries.length) {
    lines.push(...imageSummaries.map((img) => `- ${img.caption}`));
  } else {
    lines.push("- Captions generated from uploaded photos.");
  }

  lines.push("");
  return lines.join("\n");
}

async function upsertRepoFile({ path, contentBase64, message, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  let sha;
  try {
    const existing = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: githubHeaders() });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }
  } catch {}

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify({ message, content: contentBase64, branch, sha }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `GitHub commit failed (${response.status}): ${text}` };
    }

    const data = await response.json();
    return {
      ok: true,
      data: { path, sha: data.content?.sha, commitUrl: data.commit?.html_url },
    };
  } catch (error) {
    return { ok: false, error: `GitHub request failed: ${String(error?.message || error)}` };
  }
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "walking-with-ember-ai-tool",
  };
}

function encodeURIComponentPath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function toBase64Utf8(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function slugify(value) {
  return (
    String(value || "post")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 72) || "post"
  );
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

function toReadableLabel(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "trail";
}
function getImageExtension(mimeType, fallbackName) {
  const byMime = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  if (byMime[mimeType]) return byMime[mimeType];
  const match = String(fallbackName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "jpg";
}

function truncate(value, length) {
  const text = String(value || "").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trim()}...`;
}

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function quoteYaml(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function escapeInline(value) {
  return String(value || "").replace(/[\[\]]/g, "");
}




