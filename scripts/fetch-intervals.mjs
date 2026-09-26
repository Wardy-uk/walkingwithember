/**
 * Pulls walk/hike route data from Intervals.icu and writes:
 *   public/uploads/gpx/<date>-<slug>.gpx   — full-resolution GPX for download
 *   public/routes/<date>.json              — downsampled track for the walk map
 *   .cache/intervals-summary.json          — stats, for drafting walk frontmatter
 *
 * Intervals.icu mirrors activities synced from Strava and has a free API, so
 * this needs no Strava API access.
 *
 * Usage:
 *   INTERVALS_API_KEY=… INTERVALS_ATHLETE_ID=… node scripts/fetch-intervals.mjs \
 *     [--oldest 2015-01-01] [--newest 2026-12-31] [--min-miles 0] [--force]
 */

import { writeFile, mkdir, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const GPX_DIR = join(ROOT, "public", "uploads", "gpx");
const ROUTES_DIR = join(ROOT, "public", "routes");
const CACHE_DIR = join(ROOT, ".cache");

const TARGET_PTS = 1500; // match scripts/process-routes.mjs
const WALK_TYPES = ["Walk", "Hike", "Run", "TrailRun", "Snowshoe", "Hiking"];

const API_KEY = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;

if (!API_KEY || !ATHLETE_ID) {
  console.error("Missing INTERVALS_API_KEY or INTERVALS_ATHLETE_ID in the environment.");
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const FORCE = process.argv.includes("--force");
const OLDEST = arg("oldest", "2015-01-01");
const NEWEST = arg("newest", "2026-12-31");
const MIN_MILES = Number(arg("min-miles", "0"));

const auth = "Basic " + Buffer.from(`API_KEY:${API_KEY}`).toString("base64");

async function api(path) {
  const res = await fetch(`https://intervals.icu/api/v1${path}`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const exists = (p) => access(p).then(() => true, () => false);

/** Evenly thin a track to at most TARGET_PTS points, always keeping the ends. */
function downsample(points, target = TARGET_PTS) {
  if (points.length <= target) return points;
  const step = points.length / target;
  const out = [];
  for (let i = 0; i < target; i++) out.push(points[Math.floor(i * step)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}

const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]),
  );

function toGpx({ name, startIso, points }) {
  const start = new Date(startIso);
  const trkpts = points
    .map(([lon, lat, ele, tOffset]) => {
      const time = Number.isFinite(tOffset)
        ? `<time>${new Date(start.getTime() + tOffset * 1000).toISOString()}</time>`
        : "";
      const eleTag = Number.isFinite(ele) ? `<ele>${ele.toFixed(1)}</ele>` : "";
      return `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${eleTag}${time}</trkpt>`;
    })
    .join("\n      ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="walkingwithember/fetch-intervals" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(name)}</name>
    <time>${start.toISOString()}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
      ${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "walk";
}

await mkdir(GPX_DIR, { recursive: true });
await mkdir(ROUTES_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });

console.log(`Fetching activities ${OLDEST} → ${NEWEST}…`);
const all = await api(
  `/athlete/${ATHLETE_ID}/activities?oldest=${OLDEST}&newest=${NEWEST}`,
);

const candidates = all
  .filter((a) => WALK_TYPES.includes(a.type))
  .filter((a) => !MIN_MILES || (a.distance ?? 0) / 1609.34 >= MIN_MILES)
  .sort((a, b) => (a.start_date_local ?? "").localeCompare(b.start_date_local ?? ""));

console.log(`${candidates.length} walk/hike activities matched.\n`);

const summary = [];

for (const a of candidates) {
  const date = (a.start_date_local ?? "").slice(0, 10);
  const miles = a.distance ? a.distance / 1609.34 : null;
  const label = `${date} ${a.type} ${miles ? miles.toFixed(1) + "mi" : ""}`;

  const slug = `${date}-${slugify(a.name !== a.type ? a.name : a.type)}`;
  const gpxPath = join(GPX_DIR, `${slug}.gpx`);
  const routePath = join(ROUTES_DIR, `${date}.json`);

  if (!FORCE && (await exists(gpxPath))) {
    console.log(`· ${label} — GPX already present, skipping`);
    continue;
  }

  let streams;
  try {
    streams = await api(`/activity/${a.id}/streams?types=latlng,altitude,time`);
  } catch (err) {
    console.log(`✗ ${label} — no streams (${err.message})`);
    continue;
  }

  const byType = Object.fromEntries(streams.map((s) => [s.type, s]));

  // Intervals.icu splits the latlng stream into two parallel arrays:
  // `data` holds latitudes and `data2` holds longitudes.
  const lats = byType.latlng?.data ?? [];
  const lons = byType.latlng?.data2 ?? [];
  if (!lats.length || !lons.length) {
    console.log(`✗ ${label} — no GPS track`);
    continue;
  }
  const alt = byType.altitude?.data ?? [];
  const time = byType.time?.data ?? [];

  // [lon, lat, ele, tOffsetSeconds] — lon-first matches public/routes/*.json
  const points = lats
    .map((lat, i) => {
      const lon = lons[i];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return [lon, lat, Number.isFinite(alt[i]) ? alt[i] : 0, time[i]];
    })
    .filter(Boolean);

  if (!points.length) {
    console.log(`✗ ${label} — track had no usable points`);
    continue;
  }

  await writeFile(
    gpxPath,
    toGpx({ name: a.name || `${a.type} ${date}`, startIso: a.start_date_local, points }),
  );

  const thinned = downsample(points);
  const tLats = thinned.map((p) => p[1]);
  const tLons = thinned.map((p) => p[0]);
  const eles = thinned.map((p) => p[2]);
  const routeJson = {
    date,
    type: a.type,
    count: thinned.length,
    bounds: {
      minLat: Math.min(...tLats), maxLat: Math.max(...tLats),
      minLon: Math.min(...tLons), maxLon: Math.max(...tLons),
      minEle: Math.min(...eles), maxEle: Math.max(...eles),
    },
    coords: thinned.map(([lon, lat, ele]) => [
      Number(lon.toFixed(5)), Number(lat.toFixed(5)), Math.round(ele),
    ]),
  };

  const hadRoute = await exists(routePath);
  if (FORCE || !hadRoute) await writeFile(routePath, JSON.stringify(routeJson));

  const mid = thinned[Math.floor(thinned.length / 2)];
  summary.push({
    date,
    intervalsId: a.id,
    type: a.type,
    name: a.name,
    distanceMiles: miles ? Number(miles.toFixed(1)) : null,
    movingTimeMin: a.moving_time ? Math.round(a.moving_time / 60) : null,
    elevationGainM: a.total_elevation_gain ? Math.round(a.total_elevation_gain) : null,
    elevationGainFt: a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.281) : null,
    gpxDownload: `/uploads/gpx/${slug}.gpx`,
    routeMapLat: Number(((routeJson.bounds.minLat + routeJson.bounds.maxLat) / 2).toFixed(5)),
    routeMapLng: Number(((routeJson.bounds.minLon + routeJson.bounds.maxLon) / 2).toFixed(5)),
    startLat: Number(thinned[0][1].toFixed(5)),
    startLng: Number(thinned[0][0].toFixed(5)),
    midLat: Number(mid[1].toFixed(5)),
    midLng: Number(mid[0].toFixed(5)),
    bounds: routeJson.bounds,
    routeJsonWritten: FORCE || !hadRoute,
  });

  console.log(
    `✓ ${label} — ${points.length} pts → GPX, ${thinned.length} pts → route${hadRoute && !FORCE ? " (route existed, kept)" : ""}`,
  );
}

const summaryPath = join(CACHE_DIR, "intervals-summary.json");
await writeFile(summaryPath, JSON.stringify(summary, null, 2));
console.log(`\n${summary.length} activities extracted. Summary → ${summaryPath}`);
