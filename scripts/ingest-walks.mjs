/**
 * Ingests recorded walks from an activity archive and prepares everything the
 * site needs for a walk page.
 *
 * Handles two archive shapes:
 *   • Strava bulk export  — activities.csv + activities/<id>.{gpx,tcx,fit}[.gz]
 *   • Health Auto Export  — Hiking-Route-YYYYMMDD_HHMMSS.gpx
 * A plain directory of .gpx/.tcx files also works.
 *
 * Writes:
 *   public/uploads/gpx/<date>-<slug>.gpx  — full-resolution, for the download link
 *   public/routes/<date>.json             — simplified track, for the walk map
 *   .cache/walks-manifest.json            — stats + draft frontmatter values
 *
 * Usage:
 *   node scripts/ingest-walks.mjs <archive.zip|dir> [options]
 *     --min-minutes 60     only walks at least this long (default 60)
 *     --since 2025-09-26   only walks on/after this date
 *     --dry-run            report what would be written, write nothing
 *     --force              overwrite existing GPX/route files
 */

import { readFile, writeFile, mkdir, readdir, access, stat } from "fs/promises";
import { join, basename, extname } from "path";
import { gunzipSync } from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname } from "path";

import {
  parseGpx, parseTcx, parseFit, trackStats, simplify, toGpx, slugify,
} from "./lib/track.mjs";

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const GPX_OUT = join(ROOT, "public", "uploads", "gpx");
const ROUTES_OUT = join(ROOT, "public", "routes");
const CACHE = join(ROOT, ".cache");

const ROUTE_TARGET_PTS = 1500;
const WALK_WORDS = /hik|walk|trail/i;

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const SOURCE = argv.find((a) => !a.startsWith("--"));
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const MIN_MINUTES = Number(flag("min-minutes", "60"));
const SINCE = flag("since", "0000-01-01");

if (!SOURCE) {
  console.error("Usage: node scripts/ingest-walks.mjs <archive.zip|dir> [--min-minutes 60] [--since YYYY-MM-DD] [--dry-run] [--force]");
  process.exit(1);
}

const exists = (p) => access(p).then(() => true, () => false);

// ── reading the archive ─────────────────────────────────────────────────────

/** Returns [{name, buf}] for every track file in the archive. */
async function readSource(src) {
  const st = await stat(src);

  if (st.isDirectory()) {
    const out = [];
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(gpx|tcx|fit)(\.gz)?$/i.test(e.name)) {
          out.push({ name: e.name, buf: await readFile(p) });
        } else if (e.name === "activities.csv") {
          out.push({ name: e.name, buf: await readFile(p) });
        }
      }
    };
    await walk(src);
    return out;
  }

  // Zip: extract the entries we care about to a temp dir via system unzip.
  const tmp = join(CACHE, "ingest-tmp");
  await mkdir(tmp, { recursive: true });
  for (const pattern of ["*.gpx", "*.tcx", "*.gpx.gz", "*.tcx.gz", "activities.csv"]) {
    try {
      await exec("unzip", ["-o", "-j", src, pattern, "-d", tmp], { maxBuffer: 1 << 28 });
    } catch {
      /* pattern not present in this archive — fine */
    }
  }
  const files = await readdir(tmp);
  return Promise.all(
    files.map(async (name) => ({ name, buf: await readFile(join(tmp, name)) })),
  );
}

/**
 * Strava's activities.csv → Map<file stem, {name, description, type}>
 *
 * Keyed on the Filename column, NOT Activity ID. In Strava's export those
 * two disagree for most activities — a row can carry id 18925426885 while
 * pointing at activities/20038038854.fit.gz — so keying on the id silently
 * loses every file whose stem differs, which here was all 714 FIT files.
 */
function parseActivitiesCsv(text) {
  const rows = [];
  let cur = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur[cur.length - 1] += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") cur.push("");
    else if (c === "\n") { rows.push(cur); cur = [""]; }
    else if (c !== "\r") cur[cur.length - 1] += c;
  }
  if (cur.length > 1 || cur[0]) rows.push(cur);

  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const iId = col(["activity id"]);
  const iName = col(["activity name"]);
  const iDesc = col(["activity description"]);
  const iType = col(["activity type"]);
  const iGear = col(["activity gear"]);
  const iFilename = col(["filename"]);

  const map = new Map();
  for (const r of rows) {
    const file = (r[iFilename] ?? "").trim();
    // Strip directory and every extension: activities/123.fit.gz -> 123
    const stem = file ? file.split("/").pop().split(".")[0] : "";
    const id = (r[iId] ?? "").trim();
    const key = stem || id;
    if (!key) continue;
    map.set(key, {
      name: (r[iName] ?? "").trim(),
      description: (r[iDesc] ?? "").trim(),
      type: (r[iType] ?? "").trim(),
      gear: iGear !== -1 ? (r[iGear] ?? "").trim() : "",
    });
  }
  return map;
}

// ── main ────────────────────────────────────────────────────────────────────

const entries = await readSource(SOURCE);

const csvEntry = entries.find((e) => e.name === "activities.csv");
const meta = csvEntry ? parseActivitiesCsv(csvEntry.buf.toString("utf8")) : new Map();
if (csvEntry) console.log(`Strava export detected — ${meta.size} activities in activities.csv\n`);

const skippedFit = [];
const walks = [];

for (const entry of entries) {
  if (entry.name === "activities.csv") continue;

  let name = entry.name;
  let buf = entry.buf;
  if (name.endsWith(".gz")) {
    try { buf = gunzipSync(buf); } catch { continue; }
    name = name.slice(0, -3);
  }

  const ext = extname(name).toLowerCase();

  if (ext !== ".gpx" && ext !== ".tcx" && ext !== ".fit") continue;

  const stravaId = basename(name, ext);
  const info = meta.get(stravaId);

  // Filter to walking activities. Strava tells us the type; Health Auto
  // Export encodes it in the filename.
  const typeHint = info?.type || name;
  if (!WALK_WORDS.test(typeHint)) continue;

  let points;
  if (ext === ".fit") {
    try {
      points = await parseFit(buf);
    } catch {
      skippedFit.push(name);
      continue;
    }
  } else {
    const text = buf.toString("utf8");
    points = ext === ".gpx" ? parseGpx(text) : parseTcx(text);
  }
  if (!points || points.length < 2) continue;

  const stats = trackStats(points);
  if (!stats.start) continue;

  const date = stats.start.toISOString().slice(0, 10);
  if (date < SINCE) continue;
  if (stats.durationMin !== null && stats.durationMin < MIN_MINUTES) continue;

  walks.push({ date, points, stats, info, source: name });
}

walks.sort((a, b) => a.date.localeCompare(b.date));

if (!DRY) {
  await mkdir(GPX_OUT, { recursive: true });
  await mkdir(ROUTES_OUT, { recursive: true });
  await mkdir(CACHE, { recursive: true });
}

const manifest = [];

for (const w of walks) {
  const title = w.info?.name && !/^(hike|walk|morning|afternoon|evening|lunch)\b/i.test(w.info.name)
    ? w.info.name
    : null;
  const slug = `${w.date}-${slugify(title ?? "walk")}`;
  const gpxPath = join(GPX_OUT, `${slug}.gpx`);
  const routePath = join(ROUTES_OUT, `${w.date}.json`);

  const simplified = simplify(w.points, ROUTE_TARGET_PTS);
  const routeJson = {
    date: w.date,
    type: w.info?.type ?? "Hiking",
    count: simplified.length,
    bounds: {
      minLat: w.stats.bounds.minLat, maxLat: w.stats.bounds.maxLat,
      minLon: w.stats.bounds.minLon, maxLon: w.stats.bounds.maxLon,
      minEle: w.stats.minEle, maxEle: w.stats.maxEle,
    },
    coords: simplified.map((p) => [
      Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5)), Math.round(p.ele),
    ]),
  };

  const wroteGpx = FORCE || !(await exists(gpxPath));
  const wroteRoute = FORCE || !(await exists(routePath));

  if (!DRY) {
    if (wroteGpx) await writeFile(gpxPath, toGpx({ name: title ?? `Walk ${w.date}`, points: w.points }));
    if (wroteRoute) await writeFile(routePath, JSON.stringify(routeJson));
  }

  const mid = simplified[Math.floor(simplified.length / 2)];
  manifest.push({
    date: w.date,
    slug,
    sourceFile: w.source,
    stravaName: w.info?.name ?? null,
    stravaDescription: w.info?.description || null,
    title: title ?? null,
    distanceMiles: Number(w.stats.miles.toFixed(1)),
    ascentM: w.stats.ascentM,
    ascentFt: Math.round(w.stats.ascentM * 3.281),
    descentM: w.stats.descentM,
    durationMin: w.stats.durationMin,
    durationLabel: w.stats.durationMin
      ? `${Math.floor(w.stats.durationMin / 60)}h${String(w.stats.durationMin % 60).padStart(2, "0")}`
      : null,
    points: w.points.length,
    gpxDownload: `/uploads/gpx/${slug}.gpx`,
    routeMapLat: Number(((routeJson.bounds.minLat + routeJson.bounds.maxLat) / 2).toFixed(5)),
    routeMapLng: Number(((routeJson.bounds.minLon + routeJson.bounds.maxLon) / 2).toFixed(5)),
    startLat: Number(w.points[0].lat.toFixed(5)),
    startLng: Number(w.points[0].lon.toFixed(5)),
    midLat: Number(mid.lat.toFixed(5)),
    midLng: Number(mid.lon.toFixed(5)),
    bounds: routeJson.bounds,
  });

  const flags = [wroteGpx ? "gpx" : "gpx=kept", wroteRoute ? "route" : "route=kept"].join(" ");
  console.log(
    `${w.date}  ${String(manifest.at(-1).durationLabel ?? "-").padStart(5)}  ` +
    `${w.stats.miles.toFixed(1).padStart(5)}mi  ${String(w.stats.ascentM).padStart(4)}m  ` +
    `${(title ?? "(untitled)").slice(0, 34).padEnd(34)} ${flags}`,
  );
}

if (!DRY) {
  // Merge rather than replace, so several sources can be layered. Health Auto
  // Export carries barometric ascent from the watch and reads far higher than
  // Strava's GPS-derived figure — 811m vs 581m on the same walk — so run the
  // broad Strava pass first and the Health pass second to let it win on the
  // dates it covers. A later run only overwrites a date it actually has.
  const merged = new Map();
  try {
    const existing = JSON.parse(await readFile(join(CACHE, "walks-manifest.json"), "utf8"));
    for (const w of existing) merged.set(w.date, w);
  } catch {
    /* first run */
  }
  for (const w of manifest) merged.set(w.date, w);

  const all = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(join(CACHE, "walks-manifest.json"), JSON.stringify(all, null, 2));
  console.log(`\nmanifest now holds ${all.length} walks (${manifest.length} from this source).`);
}

console.log(`\n${manifest.length} walks ≥${MIN_MINUTES} min since ${SINCE}.`);
if (skippedFit.length) {
  console.log(`\n${skippedFit.length} .fit file(s) could not be decoded and were skipped.`);
}
if (DRY) console.log("\n(dry run — nothing written)");
else console.log(`Manifest → .cache/walks-manifest.json`);
