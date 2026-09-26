/**
 * Matches indexed photos to ingested walks.
 *
 * Time alone is a poor signal: a photo taken at home an hour after the walk
 * shares the same date, and a walk often spans a pub stop. So a photo is only
 * claimed by a walk when it falls inside that walk's time window AND sits
 * within --max-metres of the recorded track. Photos with no GPS fall back to
 * time-only and are flagged, so you can see which ones were guessed.
 *
 * Each match records how far along the route the photo was taken, so a walk's
 * photos can be ordered the way you actually walked them rather than by clock
 * time (which reorders anything shot on a there-and-back).
 *
 * Usage:
 *   node scripts/match-photos.mjs [--max-metres 250] [--pad-minutes 30] [--walk 2026-08-06]
 *
 * Reads  .cache/photo-index.json, .cache/walks-manifest.json, public/uploads/gpx/*
 * Writes .cache/photo-matches.json
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { parseGpx, haversine } from "./lib/track.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const MAX_METRES = Number(flag("max-metres", "250"));
const PAD_MIN = Number(flag("pad-minutes", "30"));
const ONLY_WALK = flag("walk", null);

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

let photos, manifest;
try {
  photos = await readJson(join(CACHE, "photo-index.json"));
} catch {
  console.error("No .cache/photo-index.json — run scripts/index-photos.mjs first.");
  process.exit(1);
}
try {
  manifest = await readJson(join(CACHE, "walks-manifest.json"));
} catch {
  console.error("No .cache/walks-manifest.json — run scripts/ingest-walks.mjs first.");
  process.exit(1);
}

if (ONLY_WALK) manifest = manifest.filter((w) => w.date === ONLY_WALK);

// Load each walk's track once, with cumulative distance along the route.
const walks = [];
for (const w of manifest) {
  let points;
  try {
    points = parseGpx(await readFile(join(ROOT, "public", w.gpxDownload), "utf8"));
  } catch {
    console.warn(`! ${w.date}: GPX missing (${w.gpxDownload}) — skipped`);
    continue;
  }
  // Timed points only: positionAtTime binary-searches on the clock, so an
  // untimed point would break the ordering invariant it relies on.
  points = points.filter((p) => p.time && !isNaN(p.time));
  if (points.length < 2) {
    console.warn(`! ${w.date}: track has no timestamps — skipped`);
    continue;
  }

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversine(points[i - 1], points[i]));
  }

  const times = points.map((p) => p.time).filter((t) => t && !isNaN(t));
  walks.push({
    ...w,
    points,
    cumulative,
    startMs: times[0].getTime() - PAD_MIN * 60000,
    endMs: times[times.length - 1].getTime() + PAD_MIN * 60000,
  });
}

/**
 * Where along the route the walker was at a given moment.
 *
 * Position comes from the photo's timestamp, not from the nearest track
 * point. On an out-and-back the two legs run metres apart, so a nearest-point
 * lookup cannot tell the outbound pass from the return one and scrambles the
 * ordering. The clock is unambiguous.
 */
function positionAtTime(walk, ms) {
  const pts = walk.points;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time.getTime() < ms) lo = mid + 1;
    else hi = mid;
  }
  const total = walk.cumulative[walk.cumulative.length - 1];
  return {
    idx: lo,
    alongMetres: walk.cumulative[lo],
    fraction: total ? walk.cumulative[lo] / total : 0,
  };
}

/**
 * True distance from a point to the track — a full scan, no early exit.
 * Used only to decide whether a photo belongs to this walk at all.
 */
function distanceToTrack(walk, lat, lon) {
  let best = Infinity;
  for (const p of walk.points) {
    const d = haversine({ lat, lon }, p);
    if (d < best) best = d;
  }
  return best;
}

const byWalk = new Map(walks.map((w) => [w.date, []]));
const unmatched = [];

for (const photo of photos) {
  const ms = Date.parse(photo.time);
  if (!Number.isFinite(ms)) continue;

  const inWindow = walks.filter((w) => ms >= w.startMs && ms <= w.endMs);
  if (!inWindow.length) continue;

  let claimed = null;

  if (photo.lat !== null && photo.lon !== null) {
    // Prefer the walk whose track the photo actually sits on.
    let best = null;
    for (const w of inWindow) {
      const metres = distanceToTrack(w, photo.lat, photo.lon);
      if (!best || metres < best.metres) best = { w, metres };
    }
    if (best && best.metres <= MAX_METRES) {
      const pos = positionAtTime(best.w, ms);
      claimed = { walk: best.w, metres: best.metres, ...pos, basis: "gps+time" };
    } else if (best) {
      unmatched.push({
        ...photo,
        reason: `nearest walk ${best.w.date} was ${Math.round(best.metres)}m away (limit ${MAX_METRES}m)`,
      });
    }
  } else if (inWindow.length === 1) {
    // No GPS on the photo, but only one walk was happening — take it, and say
    // so. The timestamp still places it along the route.
    claimed = {
      walk: inWindow[0],
      metres: null,
      ...positionAtTime(inWindow[0], ms),
      basis: "time-only",
    };
  } else {
    unmatched.push({ ...photo, reason: "no GPS and overlapping walk windows" });
  }

  if (claimed) {
    byWalk.get(claimed.walk.date).push({
      path: photo.path,
      source: photo.source ?? null,
      filename: photo.filename,
      time: photo.time,
      lat: photo.lat,
      lon: photo.lon,
      metresFromRoute: claimed.metres === null ? null : Math.round(claimed.metres),
      metresAlongRoute: claimed.alongMetres === null ? null : Math.round(claimed.alongMetres),
      routeFraction: claimed.fraction === null ? null : Number(claimed.fraction.toFixed(3)),
      basis: claimed.basis,
    });
  }
}

const result = walks
  .map((w) => {
    const shots = byWalk.get(w.date) ?? [];
    // Order by progress along the route, so a gallery reads as the walk went.
    shots.sort((a, b) => {
      if (a.metresAlongRoute === null || b.metresAlongRoute === null) {
        return a.time.localeCompare(b.time);
      }
      return a.metresAlongRoute - b.metresAlongRoute;
    });
    return {
      date: w.date,
      slug: w.slug,
      distanceMiles: w.distanceMiles,
      ascentM: w.ascentM,
      durationLabel: w.durationLabel,
      photoCount: shots.length,
      photos: shots,
    };
  })
  .filter((w) => w.photoCount > 0);

await mkdir(CACHE, { recursive: true });
await writeFile(join(CACHE, "photo-matches.json"), JSON.stringify(result, null, 2));

console.log(`${"date".padEnd(11)} ${"photos".padStart(6)}  ${"mi".padStart(5)}  walk`);
console.log("-".repeat(60));
for (const w of result) {
  const gpsCount = w.photos.filter((p) => p.basis === "gps+time").length;
  const note = gpsCount === w.photoCount ? "" : ` (${w.photoCount - gpsCount} time-only)`;
  console.log(
    `${w.date.padEnd(11)} ${String(w.photoCount).padStart(6)}  ` +
      `${String(w.distanceMiles).padStart(5)}  ${w.durationLabel ?? ""}${note}`,
  );
}

const total = result.reduce((n, w) => n + w.photoCount, 0);
console.log(`\n${total} photos matched across ${result.length} walks.`);
if (unmatched.length) {
  console.log(`${unmatched.length} photos fell in a walk window but were not claimed:`);
  for (const u of unmatched.slice(0, 8)) {
    console.log(`  ${u.time.slice(0, 16).replace("T", " ")}  ${u.filename ?? "?"} — ${u.reason}`);
  }
  if (unmatched.length > 8) console.log(`  … and ${unmatched.length - 8} more`);
}
console.log("→ .cache/photo-matches.json");
