/**
 * Names the places each route actually passes through.
 *
 * A walk write-up needs a route description, and the GPS track already knows
 * the answer — it just needs the names. This samples points along each track
 * and reverse-geocodes them, keeping the order walked, so the result reads as
 * a sequence: started here, over this, down to there.
 *
 * Also derives what can be measured rather than guessed: the climb profile,
 * where the steep ground was, how the pace varied, and the season.
 *
 * Results are cached, so re-runs cost nothing and Nominatim is asked once per
 * point ever.
 *
 * Usage: node scripts/route-waypoints.mjs [--walk DATE] [--samples 7]
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { parseGpx, haversine } from "./lib/track.mjs";

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
const SAMPLES = Number(flag("samples", "7"));

const exists = async (p) => readFile(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let geo = {};
if (await exists(GEO)) geo = JSON.parse(await readFile(GEO, "utf8"));

async function place(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (geo[key]) return geo[key];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=15`,
      { headers: { "User-Agent": "walkingwithember-site/1.0 (route description)" } },
    );
    const d = await res.json();
    const a = d.address ?? {};
    geo[key] = {
      name:
        a.hamlet ?? a.village ?? a.suburb ?? a.town ?? a.city ??
        a.neighbourhood ?? a.locality ?? a.natural ?? a.parish ?? null,
      county: a.county ?? a.state_district ?? null,
    };
  } catch {
    geo[key] = { name: null, county: null };
  }
  await sleep(1100); // Nominatim: one request per second
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

  // Cumulative distance, so samples are evenly spaced along the ground rather
  // than by index — GPS logs densely when you stop and sparsely when moving.
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  const total = cum[cum.length - 1];

  const waypoints = [];
  for (let s = 0; s < SAMPLES; s++) {
    const target = (total * s) / (SAMPLES - 1);
    const idx = cum.findIndex((d) => d >= target);
    const p = points[Math.max(0, idx)];
    const { name, county } = await place(p.lat, p.lon);
    const last = waypoints[waypoints.length - 1];
    // Consecutive samples often land in the same place; keep the sequence clean.
    if (name && (!last || last.name !== name)) {
      waypoints.push({ name, county, km: target / 1000, fraction: s / (SAMPLES - 1) });
    }
  }

  // Where the climbing actually happened, in fifths of the route.
  //
  // Must use the same moving-reference method as trackStats: at 1Hz each
  // consecutive gain is well under a metre, so a naive `delta > 1` test
  // discards nearly all of it — this profile summed to 48m against a known
  // 811m before the fix.
  const segments = 5;
  const climb = Array.from({ length: segments }, () => 0);
  let ref = points[0].ele;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.min(segments - 1, Math.floor((cum[i] / total) * segments));
    const d = points[i].ele - ref;
    if (d > 1) climb[seg] += d;
    if (Math.abs(d) > 1) ref = points[i].ele;
  }
  const steepest = climb.indexOf(Math.max(...climb));

  const start = points[0].time;
  const end = points[points.length - 1].time;
  const month = start.toLocaleDateString("en-GB", { month: "long" });
  const season =
    [11, 0, 1].includes(start.getMonth()) ? "winter" :
    [2, 3, 4].includes(start.getMonth()) ? "spring" :
    [5, 6, 7].includes(start.getMonth()) ? "summer" : "autumn";

  // A circuit returns to where it began; an out-and-back does too, but a
  // point-to-point does not. Useful to state, and measurable.
  const endToStart = haversine(points[0], points[points.length - 1]);
  const shape = endToStart < 250 ? "circular" : "point-to-point";

  out.push({
    date: walk.date,
    waypoints,
    shape,
    season,
    month,
    startTime: start.toTimeString().slice(0, 5),
    endTime: end.toTimeString().slice(0, 5),
    climbProfile: climb.map((m) => Math.round(m)),
    steepestFifth: steepest + 1,
    distanceMiles: walk.distanceMiles,
    ascentM: walk.ascentM,
    durationLabel: walk.durationLabel,
  });

  console.log(
    `${walk.date}  ${shape.padEnd(14)} ${waypoints.map((w) => w.name).join(" → ").slice(0, 70)}`,
  );
}

await mkdir(CACHE, { recursive: true });
await writeFile(GEO, JSON.stringify(geo, null, 2));
await writeFile(join(CACHE, "route-waypoints.json"), JSON.stringify(out, null, 2));
console.log(`\n${out.length} routes described → .cache/route-waypoints.json`);
