/**
 * Names the places each route actually passes through.
 *
 * The first version asked Nominatim at zoom 13 and took whatever came back,
 * which is administrative: it described the Redmires walk as going "towards
 * Low Bradfield" because that is the parish the sample point sat in. The walk
 * actually drops through Wyming Brook, a named ravine two miles away. A parish
 * name is not a route description.
 *
 * So it now asks at zoom 16 and prefers concrete features over administrative
 * ones: water, woods and moors first, then named roads and tracks, and only
 * then settlements. It also finds the high and low points of the track and
 * names those, since on a hill walk they are the two places worth mentioning.
 *
 * The GPX start point is where the car was, so it is geocoded at full detail
 * with its postcode and converted to an OS grid reference: that is the
 * parking note written for you rather than asked of you, in the form a walker
 * would actually use. It also catches mistakes. Redmires was written up as starting
 * at the Lower reservoir when the track begins 262m from the Upper and 1079m
 * from the Lower.
 *
 * Cache keys include the zoom, so changing it does not read stale answers.
 *
 * Usage: node scripts/route-waypoints.mjs [--walk DATE] [--samples 14]
 */

import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { parseGpx, haversine } from "./lib/track.mjs";
import { toGridRef } from "./lib/osgrid.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");
const GEO = join(CACHE, "waypoint-geocode.json");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const ONLY = flag("walk", null);
const SAMPLES = Number(flag("samples", "14"));
const ZOOM = 16;

const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let geo = {};
if (await exists(GEO)) geo = JSON.parse(await readFile(GEO, "utf8"));

/**
 * The name a walker would use for a place, in preference order.
 *
 * Concrete features beat administrative ones. "Wyming Brook" and "Stanage
 * Edge" tell you where you are; "Bradfield" and "High Peak" are just the
 * parish and the district, and on a moorland walk those can be miles wide.
 */
const PREFERENCE = [
  "water", "waterway", "natural", "peak", "ridge", "valley",
  "leisure", "nature_reserve", "forest", "wood",
  "man_made", "tourism",
  "road", "footway", "path",
  "hamlet", "isolated_dwelling", "farm",
  "village", "suburb", "neighbourhood",
  "town", "city",
];

/** Roads whose names say nothing useful about where you were. */
const DULL = /^(unnamed|track|path|footpath|public footpath|bridleway|unclassified)$/i;

async function place(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}@${ZOOM}`;
  if (geo[key]) return geo[key];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=${ZOOM}&extratags=1`,
      { headers: { "User-Agent": "walkingwithember-site/1.0 (route description)" } },
    );
    const d = await res.json();
    const a = d.address ?? {};
    let name = null;
    for (const k of PREFERENCE) {
      const v = a[k];
      if (v && !DULL.test(v)) { name = v; break; }
    }
    geo[key] = { name, county: a.county ?? a.state_district ?? null };
  } catch {
    geo[key] = { name: null, county: null };
  }
  await sleep(1100); // Nominatim: one request per second
  return geo[key];
}

/** The start point in full: road, nearest settlement and postcode. */
async function startPlace(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}@start`;
  if (geo[key]) return geo[key];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18`,
      { headers: { "User-Agent": "walkingwithember-site/1.0 (parking lookup)" } },
    );
    const a = (await res.json()).address ?? {};
    geo[key] = {
      road: a.road ?? null,
      postcode: a.postcode ?? null,
      place: a.hamlet ?? a.village ?? a.suburb ?? a.town ?? a.city ?? null,
      amenity: a.amenity ?? null,
    };
  } catch {
    geo[key] = { road: null, postcode: null, place: null, amenity: null };
  }
  await sleep(1100);
  return geo[key];
}

let manifest = JSON.parse(await readFile(join(CACHE, "walks-manifest.json"), "utf8"));
if (ONLY) manifest = manifest.filter((w) => w.date === ONLY);

const out = [];

for (const walk of manifest) {
  let points;
  try {
    points = parseGpx(await readFile(join(ROOT, "public", walk.gpxDownload), "utf8"))
      .filter((p) => p.time && !isNaN(p.time));
  } catch {
    continue;
  }
  if (points.length < 2) continue;

  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  const total = cum[cum.length - 1];

  const waypoints = [];
  for (let s = 0; s < SAMPLES; s++) {
    const target = (total * s) / (SAMPLES - 1);
    const idx = Math.max(0, cum.findIndex((d) => d >= target));
    const p = points[idx];
    const { name, county } = await place(p.lat, p.lon);
    const last = waypoints[waypoints.length - 1];
    if (name && (!last || last.name !== name)) {
      waypoints.push({
        name, county,
        km: Number((target / 1000).toFixed(1)),
        ele: Math.round(p.ele),
        fraction: s / (SAMPLES - 1),
      });
    }
  }

  // The high and low points are the two places on a hill walk worth naming.
  let hiIdx = 0;
  let loIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].ele > points[hiIdx].ele) hiIdx = i;
    if (points[i].ele < points[loIdx].ele) loIdx = i;
  }
  const high = { ...(await place(points[hiIdx].lat, points[hiIdx].lon)), ele: Math.round(points[hiIdx].ele), km: Number((cum[hiIdx] / 1000).toFixed(1)) };
  const low = { ...(await place(points[loIdx].lat, points[loIdx].lon)), ele: Math.round(points[loIdx].ele), km: Number((cum[loIdx] / 1000).toFixed(1)) };

  const segments = 5;
  const climb = Array.from({ length: segments }, () => 0);
  let ref = points[0].ele;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.min(segments - 1, Math.floor((cum[i] / total) * segments));
    const d = points[i].ele - ref;
    if (d > 1) climb[seg] += d;
    if (Math.abs(d) > 1) ref = points[i].ele;
  }

  const startAt = await startPlace(points[0].lat, points[0].lon);

  const start = points[0].time;
  const end = points[points.length - 1].time;
  const month = start.toLocaleDateString("en-GB", { month: "long" });
  const endToStart = haversine(points[0], points[points.length - 1]);

  out.push({
    date: walk.date,
    waypoints,
    high,
    low,
    startEle: Math.round(points[0].ele),
    startAt,
    startGridRef: toGridRef(points[0].lat, points[0].lon, 8)?.ref ?? null,
    startLat: Number(points[0].lat.toFixed(5)),
    startLng: Number(points[0].lon.toFixed(5)),
    shape: endToStart < 250 ? "circular" : "point-to-point",
    season:
      [11, 0, 1].includes(start.getMonth()) ? "winter" :
      [2, 3, 4].includes(start.getMonth()) ? "spring" :
      [5, 6, 7].includes(start.getMonth()) ? "summer" : "autumn",
    month,
    startTime: start.toTimeString().slice(0, 5),
    endTime: end.toTimeString().slice(0, 5),
    climbProfile: climb.map((m) => Math.round(m)),
    distanceMiles: walk.distanceMiles,
    ascentM: walk.ascentM,
    durationLabel: walk.durationLabel,
  });

  console.log(
    `${walk.date}  ${String(toGridRef(points[0].lat, points[0].lon, 8)?.ref ?? "?").padEnd(14)} ` +
    `${String([startAt.road, startAt.postcode].filter(Boolean).join(" ") || "?").slice(0, 24).padEnd(24)} ` +
    `high ${String(high.ele).padStart(3)}m ${String(high.name ?? "?").slice(0, 16).padEnd(16)} ` +
    `low ${String(low.ele).padStart(3)}m ${String(low.name ?? "?").slice(0, 18).padEnd(18)} ` +
    `${waypoints.map((w) => w.name).join(" > ").slice(0, 46)}`,
  );
}

await mkdir(CACHE, { recursive: true });
await writeFile(GEO, JSON.stringify(geo, null, 2));
await writeFile(join(CACHE, "route-waypoints.json"), JSON.stringify(out, null, 2));
console.log(`\n${out.length} routes described -> .cache/route-waypoints.json`);
