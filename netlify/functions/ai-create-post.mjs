import crypto from "node:crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUIRED_ENV = ["GITHUB_TOKEN", "GITHUB_REPO"];

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
    if (!token) return json({ error: "Missing admin auth token" }, 401);

    const user = await validateIdentityToken(token, event);
    if (!user) return json({ error: "Unauthorized" }, 401);

    let payload;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
      payload = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON payload" }, 400);
    }

    for (const key of REQUIRED_ENV) {
      if (!process.env[key]) return json({ error: `Missing required environment variable: ${key}` }, 500);
    }

    const action = payload?.action || "generate_post";

    if (action === "analyze_gpx") {
      const validationError = validateGpxAnalyzePayload(payload);
      if (validationError) return json({ error: validationError }, 400);
      const gpxSummary = parseGpx(payload.gpxFile.contentBase64, payload.gpxFile.name);
      if (!gpxSummary.ok) return json({ error: gpxSummary.error }, 400);
      return json({ ok: true, gpxSummary: gpxSummary.data }, 200);
    }

    if (action === "upload_asset") {
      const validationError = validateUploadAssetPayload(payload);
      if (validationError) return json({ error: validationError }, 400);
      const branch = process.env.GITHUB_BRANCH || "main";

      if (payload.asset.kind === "gpx") {
        const gpxSummary = parseGpx(payload.asset.contentBase64, payload.asset.name);
        if (!gpxSummary.ok) return json({ error: gpxSummary.error }, 400);

        const slug = slugify(payload.asset.name.replace(/\.[^.]+$/, ""));
        const hash = shortHash(`${Date.now()}-${payload.asset.name}`);
        const gpxPath = `public/uploads/gpx/${slug}-${hash}.gpx`;
        const write = await upsertRepoFile({
          path: gpxPath,
          contentBase64: payload.asset.contentBase64,
          message: `chore(ai): add gpx asset ${gpxPath}`,
          branch,
        });

        if (!write.ok) return json({ error: write.error }, 502);
        return json({
          ok: true,
          asset: {
            kind: "gpx",
            path: gpxPath,
            publicPath: `/${stripPublicPrefix(gpxPath)}`,
            name: payload.asset.name,
          },
          commit: write.data?.commitUrl || null,
          gpxSummary: gpxSummary.data,
        });
      }

      const safeName = sanitizeFilename(payload.asset.name);
      const ext = getImageExtension(payload.asset.mimeType, safeName);
      const stem = safeName.replace(/\.[^.]+$/, "");
      const hash = shortHash(`${Date.now()}-${safeName}`);
      const fileName = `${stem}-${hash}.${ext}`;
      const imagePath = `public/uploads/images/${fileName}`;

      const write = await upsertRepoFile({
        path: imagePath,
        contentBase64: payload.asset.contentBase64,
        message: `chore(ai): add image asset ${imagePath}`,
        branch,
      });

      if (!write.ok) return json({ error: write.error }, 502);
      const readable = toReadableLabel(stem);
      return json({
        ok: true,
        asset: {
          kind: "image",
          path: imagePath,
          publicPath: `/${stripPublicPrefix(imagePath)}`,
          name: payload.asset.name,
          alt: truncate(`Peak District trail photo: ${readable}`, 140),
          caption: truncate(`Peak District route image: ${readable}.`, 180),
        },
        commit: write.data?.commitUrl || null,
      });
    }


    if (action === "publish_draft") {
      const validationError = validatePublishDraftPayload(payload);
      if (validationError) return json({ error: validationError }, 400);

      const normalizedPath = normalizeManagedContentPath(payload.contentPath);
      if (!normalizedPath.ok) return json({ error: normalizedPath.error }, 400);

      const branch = process.env.GITHUB_BRANCH || "main";
      const publishResult = await publishDraftFile({
        path: normalizedPath.path,
        branch,
      });
      if (!publishResult.ok) return json({ error: publishResult.error }, 502);

      return json({
        ok: true,
        branch,
        published: {
          path: normalizedPath.path,
          slug: pathToSlug(normalizedPath.path),
          type: normalizedPath.type,
        },
        commit: publishResult.data?.commitUrl || null,
      });
    }

    if (action === "manage_post") {
      const validationError = validateManagePostPayload(payload);
      if (validationError) return json({ error: validationError }, 400);

      const normalizedPath = normalizeManagedContentPath(payload.contentPath);
      if (!normalizedPath.ok) return json({ error: normalizedPath.error }, 400);

      const branch = process.env.GITHUB_BRANCH || "main";
      const operation = String(payload.operation || "").toLowerCase();
      const result = operation === "delete"
        ? await deleteContentFile({ path: normalizedPath.path, branch })
        : await archiveContentFile({ path: normalizedPath.path, branch });
      if (!result.ok) return json({ error: result.error }, 502);

      return json({
        ok: true,
        branch,
        operation,
        managed: {
          path: normalizedPath.path,
          slug: pathToSlug(normalizedPath.path),
          type: normalizedPath.type,
        },
        commit: result.data?.commitUrl || null,
      });
    }
    if (action !== "generate_post") return json({ error: "Invalid action" }, 400);

    const validationError = validateGeneratePayload(payload);
    if (validationError) return json({ error: validationError }, 400);

    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const branch = process.env.GITHUB_BRANCH || "main";
    const siteBaseUrl = sanitizeBaseUrl(process.env.SITE_BASE_URL || process.env.URL || deriveBaseUrl(event));

    const gpxSummary = payload.gpxSummary;
    const gpxPublicUrl = siteBaseUrl ? `${siteBaseUrl}${payload.gpxAsset.publicPath}` : payload.gpxAsset.publicPath;

    const walkSlugBase = slugify(payload.walkTitle || payload.answers?.where_walked || `walk-${datePart}`);
    const walkSlug = `${walkSlugBase}-${datePart}`;
    const blogSlugBase = slugify(payload.blogTitle || `${walkSlugBase}-journal`);
    const blogSlug = `${blogSlugBase}-${datePart}`;

    const imageSummaries = payload.imageAssets.map((img) => ({
      path: img.path,
      publicPath: img.publicPath,
      caption: img.caption || `Peak District route image: ${toReadableLabel(img.name || "trail")}.`,
      alt: img.alt || `Peak District trail photo: ${toReadableLabel(img.name || "trail")}`,
    }));

    const content = await generateContent({
      payload,
      gpxSummary,
      imageSummaries,
      walkSlug,
      blogSlug,
      publishDate: datePart,
    });
    if (!content.ok) return json({ error: content.error }, 502);

    let walkPath = null;
    let blogPath = null;
    const commitResults = [];

    if (payload.postMode === "walk" || payload.postMode === "both") {
      walkPath = `src/content/walks/${walkSlug}.md`;
      const walkMarkdown = createWalkMarkdown({
        content: content.data,
        payload,
        gpxSummary,
        publishDate: datePart,
        gpxPublicUrl,
        heroImage: imageSummaries[0]?.publicPath || "https://commons.wikimedia.org/wiki/Special:FilePath/Peak%20District.JPG",
        imageSummaries,
      });
      const write = await upsertRepoFile({
        path: walkPath,
        contentBase64: toBase64Utf8(walkMarkdown),
        message: `feat(ai): create walk post ${walkSlug}`,
        branch,
      });
      if (!write.ok) return json({ error: write.error }, 502);
      commitResults.push(write.data);
    }

    if (payload.postMode === "blog" || payload.postMode === "both") {
      blogPath = `src/content/blog/${blogSlug}.md`;
      const blogMarkdown = createBlogMarkdown({
        content: content.data,
        payload,
        publishDate: datePart,
        coverImage: imageSummaries[0]?.publicPath || "https://commons.wikimedia.org/wiki/Special:FilePath/Peak%20District.JPG",
        includeWalkRelation: payload.postMode === "both",
        walkSlug,
        imageSummaries,
      });
      const write = await upsertRepoFile({
        path: blogPath,
        contentBase64: toBase64Utf8(blogMarkdown),
        message: `feat(ai): create blog post ${blogSlug}`,
        branch,
      });
      if (!write.ok) return json({ error: write.error }, 502);
      commitResults.push(write.data);
    }

    return json({
      ok: true,
      createdBy: user.email || user.id || "admin",
      branch,
      created: {
        walkPath,
        blogPath,
        gpxPath: payload.gpxAsset.path,
        imagePaths: imageSummaries.map((x) => x.path),
      },
      commits: commitResults.map((r) => r.commitUrl).filter(Boolean),
    });
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

function validateGpxAnalyzePayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  if (!payload.gpxFile || !payload.gpxFile.contentBase64 || !payload.gpxFile.name) return "GPX file is required";
  return null;
}

function validateUploadAssetPayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  if (!payload.asset || typeof payload.asset !== "object") return "asset is required";
  if (!["gpx", "image"].includes(payload.asset.kind)) return "asset.kind must be gpx or image";
  if (!payload.asset.name || !payload.asset.contentBase64) return "asset name and content are required";
  if (payload.asset.kind === "image" && !payload.asset.mimeType) return "asset mimeType is required for images";
  return null;
}

function validatePublishDraftPayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  const normalized = normalizeManagedContentPath(payload.contentPath);
  if (!normalized.ok) return normalized.error;
  return null;
}

function validateManagePostPayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  const operation = String(payload.operation || "").toLowerCase();
  if (!["archive", "delete"].includes(operation)) return "operation must be archive or delete";
  const normalized = normalizeManagedContentPath(payload.contentPath);
  if (!normalized.ok) return normalized.error;
  return null;
}

function normalizeManagedContentPath(contentPath) {
  const raw = String(contentPath || "").trim();
  if (!raw) return { ok: false, error: "contentPath is required" };
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return { ok: false, error: "contentPath must be a walk/blog markdown file" };
  }
  const match = normalized.match(/^src\/content\/(walks|blog)\/([a-z0-9][a-z0-9-]{0,120})\.md$/i);
  if (!match) return { ok: false, error: "contentPath must be a walk/blog markdown file" };
  const collection = match[1].toLowerCase();
  const slug = match[2].toLowerCase();
  return {
    ok: true,
    path: `src/content/${collection}/${slug}.md`,
    type: collection === "walks" ? "walk" : "blog",
    slug,
  };
}

function validateGeneratePayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload missing";
  if (!["walk", "blog", "both"].includes(payload.postMode)) return "Invalid postMode";
  if (!payload.answers || typeof payload.answers !== "object") return "answers are required";
  if (!payload.gpxAsset || !payload.gpxAsset.path || !payload.gpxAsset.publicPath) return "gpxAsset is required";
  if (!payload.gpxSummary || typeof payload.gpxSummary !== "object") return "gpxSummary is required";
  if (!Array.isArray(payload.imageAssets) || payload.imageAssets.length === 0) return "At least one image asset is required";
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

  const points = [...extractPoints(xml, "trkpt"), ...extractPoints(xml, "rtept")];
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
  const minMaxElevation = getMinMax(elevations);
  const hasElevation = Number.isFinite(minMaxElevation.min) && Number.isFinite(minMaxElevation.max);

  const timeValues = points.map((p) => p.timeMs).filter((v) => Number.isFinite(v));
  const hasTime = timeValues.length > 1;
  const elapsedSeconds = hasTime ? Math.max(0, Math.round((timeValues[timeValues.length - 1] - timeValues[0]) / 1000)) : null;

  const distanceMiles = Number((meters / 1609.344).toFixed(2));
  const durationHours = elapsedSeconds && elapsedSeconds > 0 ? elapsedSeconds / 3600 : null;
  const avgMph = durationHours && distanceMiles > 0 ? Number((distanceMiles / durationHours).toFixed(2)) : null;
  const avgPaceMinPerMile = durationHours && distanceMiles > 0 ? Number(((durationHours * 60) / distanceMiles).toFixed(2)) : null;

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
      minElevationMeters: hasElevation ? Math.round(minMaxElevation.min) : null,
      maxElevationMeters: hasElevation ? Math.round(minMaxElevation.max) : null,
      elapsedSeconds,
      elapsedHms: elapsedSeconds ? formatDuration(elapsedSeconds) : null,
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
      points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, timeMs: Number.isFinite(ts) ? ts : null });
    }
  }

  const selfClosingRegex = new RegExp(`<${tagName}[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*/>`, "g");
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
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: null, max: null };
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

async function generateContent({ payload, gpxSummary, walkSlug, blogSlug, publishDate }) {
  const answers = payload.answers || {};
  const voiceProfile = "Use direct first-person UK hiking language. Keep it practical, specific, and unsentimental.";
  const bannedPhrases = [
    "rewarding day",
    "memorable terrain",
    "with the right prep",
    "strong day out",
    "good balance of effort",
    "typical for the season",
  ];

  const landmarks = splitDetailItems(answers.route_landmarks);
  const conditionDetails = splitDetailItems(answers.condition_specifics);
  const detailErrors = [];
  if (landmarks.length < 3) detailErrors.push("add at least 3 specific route landmarks");
  if (conditionDetails.length < 2) detailErrors.push("add at least 2 specific condition notes");
  if (!String(answers.day_mistake_lesson || "").trim()) detailErrors.push("add one mistake or lesson from the day");
  if (detailErrors.length) {
    return {
      ok: false,
      error: `Need more concrete detail before generating: ${detailErrors.join("; ")}.`,
    };
  }

  const walkLocation = nonEmpty(payload.walkTitle, answers.where_walked, answers.familiar_or_new, "Peak District");
  const walkTitle = nonEmpty(payload.walkTitle, titleCaseFromSlug(walkSlug), `Walk ${publishDate}`);

  const distance = Number(gpxSummary.distanceMiles || 0);
  const ascentFt = Number(gpxSummary.elevationGainFeet || 0);
  const difficulty = distance >= 10 || ascentFt >= 2200 ? "Hard" : distance >= 6 || ascentFt >= 1200 ? "Moderate" : "Easy";

  const summary = truncate(
    sanitizeVoiceText(
      nonEmpty(
        answers.why_route_today,
        answers.conditions_impact,
        answers.during_after_feeling,
        "A practical day in the hills with route notes, conditions, and lessons from the trail."
      ),
      bannedPhrases
    ),
    230
  );

  const walkTags = dedupeStrings([
    "Peak District",
    difficulty,
    answers.walk_purpose,
    answers.weather_trail_conditions,
    answers.standout_sections,
    answers.kit_layers,
  ]).slice(0, 8);

  const walkIntro = truncate(
    sanitizeVoiceText(
      nonEmpty(
        answers.why_route_today,
        answers.where_walked,
        "This route gives you solid climbing, big views, and enough variety to stay interesting throughout."
      ),
      bannedPhrases
    ),
    280
  );

  const landmarkLines = formatDetailList(
    landmarks,
    ["Start point and first junction", "Key turn on open ground", "Final descent marker"]
  );
  const conditionLines = formatDetailList(
    conditionDetails,
    ["Wind strength and direction on high ground", "Ground firmness or bogginess in key sections"]
  );

  const routeNotesMarkdown = [
    "## Route overview",
    voiceProfile,
    "",
    walkIntro,
    "",
    "## Important before you go",
    `- ${nonEmpty(answers.safety_notes, "Carry and use navigation confidently, especially on open moorland or unclear path sections.")}`,
    `- ${nonEmpty(answers.weather_trail_conditions, "Check the latest weather before setting off and be ready for quick changes on higher ground.")}`,
    `- ${nonEmpty(answers.parking_toilets, "Confirm parking and facilities before travel.")}`,
    "",
    "## Navigation and landmarks",
    ...landmarkLines.map((item) => `- ${item}`),
    "",
    "## Route notes",
    sanitizeVoiceText(
      nonEmpty(answers.familiar_or_new, "The route starts steadily, then gets rougher where line choice matters."),
      bannedPhrases
    ),
    "",
    sanitizeVoiceText(
      nonEmpty(answers.standout_sections, "The middle section is the one that defines this route and where the day opens up."),
      bannedPhrases
    ),
    "",
    sanitizeVoiceText(nonEmpty(answers.pace_comfort, "I kept the pace honest and steady for the conditions."), bannedPhrases),
    "",
    "## Conditions on the day",
    ...conditionLines.map((item) => `- ${item}`),
    "",
    sanitizeVoiceText(
      nonEmpty(answers.conditions_impact, "Conditions changed how fast I could move and where I needed to be careful."),
      bannedPhrases
    ),
    "",
    "## Kit and what I would do next time",
    sanitizeVoiceText(nonEmpty(answers.kit_layers, "Layering was set for mixed UK hill weather."), bannedPhrases),
    "",
    sanitizeVoiceText(nonEmpty(answers.gear_lessons, "A couple of kit choices worked, one or two need changing."), bannedPhrases),
    "",
    "## Mistakes and lessons",
    sanitizeVoiceText(
      nonEmpty(answers.day_mistake_lesson, "I made one route-choice error and corrected quickly with map checks."),
      bannedPhrases
    ),
    "",
    "## Walking with Ember",
    sanitizeVoiceText(nonEmpty(answers.ember_experience, "Ember handled the route well and stayed engaged all day."), bannedPhrases),
    "",
    `- Lead/off-lead: ${nonEmpty(answers.ember_lead_offlead, "Mostly on lead where stock, roads, or steep drops were nearby.")}`,
    `- Triggers and control: ${nonEmpty(answers.ember_triggers, "Watched for stock and other dogs; recalled early to avoid pressure points.")}`,
    `- Aftercare: ${nonEmpty(answers.ember_aftercare, "Water, quick check of paws, then a proper rest once home.")}`,
    "",
    sanitizeVoiceText(nonEmpty(answers.ember_rhythm, "Some sections needed tighter control and clearer pacing cues."), bannedPhrases),
    "",
    "## Final thoughts",
    sanitizeVoiceText(
      nonEmpty(answers.what_it_meant, answers.what_it_taught, answers.overall_rating, "I would do this one again, but with a smarter line choice in the rougher sections."),
      bannedPhrases
    ),
  ].join("\n");

  const finalBlogTitle = nonEmpty(payload.blogTitle, `Walk Notes: ${walkTitle}`, titleCaseFromSlug(blogSlug));
  const blogExcerpt = truncate(
    nonEmpty(
      answers.during_after_feeling,
      answers.what_it_meant,
      "A practical and personal trail note from a recent Peak District walk."
    ),
    250
  );

  const blogBody = [
    "This write-up is from my own route notes and GPX stats, then edited before publish.",
    "",
    "## Route snapshot",
    `- Distance: ${gpxSummary.distanceMiles} mi`,
    `- Elevation gain: ${gpxSummary.elevationGainFeet} ft`,
    ...(gpxSummary.elapsedHms ? [`- Elapsed time: ${gpxSummary.elapsedHms}`] : []),
    ...(gpxSummary.avgPaceMinPerMile ? [`- Average pace: ${gpxSummary.avgPaceMinPerMile} min/mi`] : []),
    "",
    "## Why this route",
    sanitizeVoiceText(
      nonEmpty(answers.why_route_today, "I picked this route for solid climbing, good distance, and proper hill time."),
      bannedPhrases
    ),
    "",
    "## Start and first impressions",
    sanitizeVoiceText(nonEmpty(answers.before_setting_off, "I started steady and watched how the weather was going to behave."), bannedPhrases),
    "",
    "## On the trail",
    sanitizeVoiceText(nonEmpty(answers.weather_trail_conditions, "Conditions shifted through the walk and dictated the pace."), bannedPhrases),
    "",
    sanitizeVoiceText(nonEmpty(answers.standout_sections, "One climb and one exposed section were the defining parts of the day."), bannedPhrases),
    "",
    "## Where I nearly got it wrong",
    sanitizeVoiceText(nonEmpty(answers.day_mistake_lesson, "I made one judgement call that cost time, then corrected it early."), bannedPhrases),
    "",
    "## Gear and takeaways",
    sanitizeVoiceText(nonEmpty(answers.gear_lessons, "Most kit worked, but I would change one item next time."), bannedPhrases),
    "",
    "## Ember notes",
    sanitizeVoiceText(nonEmpty(answers.ember_experience, "Ember was strong throughout, with a couple of sections needing closer handling."), bannedPhrases),
    "",
    `- Lead/off-lead: ${nonEmpty(answers.ember_lead_offlead, "Kept lead decisions tied to terrain and nearby stock.")}`,
    `- Triggers: ${nonEmpty(answers.ember_triggers, "Stayed ahead of obvious trigger points and reset early when needed.")}`,
    "",
    "## Would I do it again?",
    sanitizeVoiceText(nonEmpty(answers.walk_again, answers.overall_rating, "Yes, and I would run the same route with small tactical changes."), bannedPhrases),
  ].join("\n");

  const blogTags = dedupeStrings([
    "Peak District",
    "Walk Journal",
    answers.walk_purpose,
    answers.weather_trail_conditions,
    answers.kit_layers,
  ]).slice(0, 8);

  return {
    ok: true,
    data: {
      walk: {
        title: walkTitle,
        summary,
        location: walkLocation,
        region: "Peak District",
        difficulty,
        parking: nonEmpty(answers.parking_toilets, "Parking available near route start; check facilities before travel."),
        dogFriendly: true,
        tags: walkTags,
        routeNotesMarkdown,
      },
      blog: {
        title: finalBlogTitle,
        excerpt: blogExcerpt,
        bodyMarkdown: blogBody,
        tags: blogTags,
      },
    },
  };
}

function createWalkMarkdown({ content, payload, gpxSummary, publishDate, gpxPublicUrl, heroImage, imageSummaries }) {
  const walk = content.walk;
  const tags = dedupeStrings(walk.tags).slice(0, 8);
  const stravaRecord = String(payload.stravaRecord || "").trim();
  const stravaFlyby = String(payload.stravaFlyby || "").trim();

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
    ...(stravaRecord ? [`stravaRecord: ${quoteYaml(stravaRecord)}`] : []),
    ...(stravaFlyby ? [`stravaFlyby: ${quoteYaml(stravaFlyby)}`] : []),
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
    "## Map and navigation",
    "- Always carry navigation backup and know how to use it.",
    "- Downloaded GPX is provided for route guidance only; conditions and access can change.",
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
  if (imageSummaries.length) lines.push(...imageSummaries.map((img) => `- ${img.caption}`));
  else lines.push("- Captions generated from uploaded photos.");
  lines.push("");
  return lines.join("\n");
}

async function publishDraftFile({ path, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  try {
    const getResponse = await fetch(url + `?ref=${encodeURIComponent(branch)}`, {
      method: "GET",
      headers: githubHeaders(),
    });

    if (!getResponse.ok) {
      const text = await getResponse.text();
      return { ok: false, error: `GitHub read failed (${getResponse.status}): ${text}` };
    }

    const current = await getResponse.json();
    const currentText = Buffer.from(String(current.content || "").replace(/\n/g, ""), "base64").toString("utf8");
    const updatedText = setDraftFlag(currentText, false);
    const contentBase64 = Buffer.from(updatedText, "utf8").toString("base64");

    const putResponse = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `chore(ai): publish draft ${path}`,
        content: contentBase64,
        sha: current.sha,
        branch,
      }),
    });

    if (!putResponse.ok) {
      const text = await putResponse.text();
      return { ok: false, error: `GitHub publish failed (${putResponse.status}): ${text}` };
    }

    const data = await putResponse.json();
    return { ok: true, data: { path, sha: data.content?.sha, commitUrl: data.commit?.html_url } };
  } catch (error) {
    return { ok: false, error: `GitHub publish request failed: ${String(error?.message || error)}` };
  }
}


async function archiveContentFile({ path, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  try {
    const getResponse = await fetch(url + `?ref=${encodeURIComponent(branch)}`, {
      method: "GET",
      headers: githubHeaders(),
    });
    if (!getResponse.ok) {
      const text = await getResponse.text();
      return { ok: false, error: `GitHub read failed (${getResponse.status}): ${text}` };
    }

    const current = await getResponse.json();
    const currentText = Buffer.from(String(current.content || "").replace(/\n/g, ""), "base64").toString("utf8");
    const updatedText = setDraftFlag(currentText, true);
    const contentBase64 = Buffer.from(updatedText, "utf8").toString("base64");

    const putResponse = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `chore(admin): archive content ${path}`,
        content: contentBase64,
        sha: current.sha,
        branch,
      }),
    });
    if (!putResponse.ok) {
      const text = await putResponse.text();
      return { ok: false, error: `GitHub archive failed (${putResponse.status}): ${text}` };
    }

    const data = await putResponse.json();
    return { ok: true, data: { path, sha: data.content?.sha, commitUrl: data.commit?.html_url } };
  } catch (error) {
    return { ok: false, error: `GitHub archive request failed: ${String(error?.message || error)}` };
  }
}

async function deleteContentFile({ path, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  try {
    const getResponse = await fetch(url + `?ref=${encodeURIComponent(branch)}`, {
      method: "GET",
      headers: githubHeaders(),
    });
    if (!getResponse.ok) {
      const text = await getResponse.text();
      return { ok: false, error: `GitHub read failed (${getResponse.status}): ${text}` };
    }

    const current = await getResponse.json();

    const deleteResponse = await fetch(url, {
      method: "DELETE",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `chore(admin): delete content ${path}`,
        sha: current.sha,
        branch,
      }),
    });
    if (!deleteResponse.ok) {
      const text = await deleteResponse.text();
      return { ok: false, error: `GitHub delete failed (${deleteResponse.status}): ${text}` };
    }

    const data = await deleteResponse.json();
    return { ok: true, data: { path, sha: current.sha, commitUrl: data.commit?.html_url } };
  } catch (error) {
    return { ok: false, error: `GitHub delete request failed: ${String(error?.message || error)}` };
  }
}
async function upsertRepoFile({ path, contentBase64, message, branch }) {
  const repo = process.env.GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponentPath(path)}`;

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify({ message, content: contentBase64, branch }),
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

function setDraftFlag(markdown, draftValue) {
  const text = String(markdown || "");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const flagLine = `draft: ${draftValue ? "true" : "false"}`;

  if (!match) return text;

  const frontmatter = match[1];
  const body = text.slice(match[0].length);
  const hasDraft = /^draft:\s*(true|false)\s*$/m.test(frontmatter);
  const newFrontmatter = hasDraft
    ? frontmatter.replace(/^draft:\s*(true|false)\s*$/m, flagLine)
    : frontmatter + "\n" + flagLine;

  return `---\n${newFrontmatter}\n---\n${body}`;
}

function pathToSlug(contentPath) {
  const value = String(contentPath || "");
  const match = value.match(/\/([^/]+)\.md$/);
  return match ? match[1] : "";
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

function stripPublicPrefix(path) {
  return String(path || "").replace(/^public\//, "");
}

function shortHash(input) {
  return crypto.createHash("sha1").update(String(input || "")).digest("hex").slice(0, 10);
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
  return String(value || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "trail";
}

function nonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function titleCaseFromSlug(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function splitDetailItems(value) {
  return String(value || "")
    .split(/\r?\n|,|;|\u2022| - /)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function formatDetailList(items, fallback) {
  return dedupeStrings([...(items || []), ...(fallback || [])]).slice(0, Math.max((items || []).length, 3));
}

function sanitizeVoiceText(value, bannedPhrases) {
  let text = String(value || "").trim();
  for (const phrase of bannedPhrases || []) {
    if (!phrase) continue;
    const pattern = new RegExp(escapeRegex(phrase), "ig");
    text = text.replace(pattern, "").replace(/\s{2,}/g, " ").trim();
  }
  return text || String(value || "").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteYaml(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function escapeInline(value) {
  return String(value || "").replace(/[\[\]]/g, "");
}

