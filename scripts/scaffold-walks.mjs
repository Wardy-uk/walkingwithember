/**
 * Creates draft walk pages from the ingest manifest.
 *
 * The point is to get something on screen to write *against*: real stats,
 * real route, real photos. The prose is left as prompts to fill in, and
 * every page is written with draft: true so nothing reaches the public site
 * until you clear that flag.
 *
 * Draft walks still render at /preview/walks/<slug>/, which is where to
 * browse them.
 *
 * Existing files are never overwritten — once you have written a walk up,
 * re-running this leaves it alone.
 *
 * Usage:
 *   node scripts/scaffold-walks.mjs [--min-minutes 60] [--force]
 */

import { readFile, writeFile, mkdir, access, readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");
const WALKS_DIR = join(ROOT, "src", "content", "walks");
const GEO_CACHE = join(CACHE, "geocode.json");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const MIN_MINUTES = Number(flag("min-minutes", "60"));
const FORCE = argv.includes("--force");

const exists = (p) => access(p).then(() => true, () => false);

const manifest = JSON.parse(await readFile(join(CACHE, "walks-manifest.json"), "utf8"));
const walks = manifest.filter((w) => (w.durationMin ?? 0) >= MIN_MINUTES);

// ── Reverse geocoding, cached so re-runs cost nothing ───────────────────────

let geo = {};
if (await exists(GEO_CACHE)) geo = JSON.parse(await readFile(GEO_CACHE, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function locate(walk) {
  if (geo[walk.date]) return geo[walk.date];
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${walk.midLat}&lon=${walk.midLng}&format=json&zoom=13`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "walkingwithember-site/1.0 (walk page scaffolding)" },
    });
    const d = await res.json();
    const a = d.address ?? {};
    const place = a.village ?? a.hamlet ?? a.town ?? a.city ?? a.parish ?? a.suburb ?? null;
    const county = a.county ?? a.state_district ?? a.state ?? null;
    geo[walk.date] = { place, county };
  } catch {
    geo[walk.date] = { place: null, county: null };
  }
  await sleep(1100); // Nominatim asks for max 1 request/second
  return geo[walk.date];
}

// ── Derived values ──────────────────────────────────────────────────────────

/**
 * Difficulty from distance and ascent together. Distance alone misleads:
 * a flat 10-miler is a stroll next to 8 miles with 700m of climbing.
 */
function difficulty({ distanceMiles, ascentM }) {
  const score = distanceMiles + ascentM / 100;
  if (score >= 18) return "Hard";
  if (score >= 10) return "Moderate";
  return "Easy";
}

/** Zoom that roughly fits the route's bounding box. */
function zoomFor(bounds) {
  const span = Math.max(
    bounds.maxLat - bounds.minLat,
    (bounds.maxLon - bounds.minLon) * Math.cos((bounds.minLat * Math.PI) / 180),
  );
  if (span > 0.18) return 10;
  if (span > 0.09) return 11;
  if (span > 0.045) return 12;
  if (span > 0.02) return 13;
  return 14;
}

const yaml = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

await mkdir(WALKS_DIR, { recursive: true });
const existing = (await readdir(WALKS_DIR).catch(() => [])).filter((f) => f.endsWith(".md"));

let written = 0;
let skipped = 0;

for (const w of walks) {
  const { place, county } = await locate(w);
  const region = county ?? "UK";
  const location = place ? `${place}, ${region}` : region;
  const titleBase = place ?? region;
  const slug = `${w.date}-${titleBase.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const file = join(WALKS_DIR, `${slug}.md`);

  if (!FORCE && (await exists(file))) {
    skipped++;
    continue;
  }
  // A walk already written up under a different slug for this date
  if (!FORCE && existing.some((f) => f.startsWith(w.date))) {
    skipped++;
    continue;
  }

  // Use the walk's own first photo when the set has been built, else fall
  // back to the site masthead so the page still renders.
  let heroImage = "/uploads/images/5da590c5-0884-4c1c-8fc1-012850f889fa-61fec1bcfa.jpg";
  const photoJson = join(ROOT, "public", "photos", `${w.date}.json`);
  if (await exists(photoJson)) {
    try {
      const set = JSON.parse(await readFile(photoJson, "utf8"));
      if (set.photos?.length) heroImage = set.photos[0].src;
    } catch {
      /* keep the fallback */
    }
  }

  const diff = difficulty(w);
  const hours = Math.floor(w.durationMin / 60);
  const mins = w.durationMin % 60;

  const body = `---
title: ${yaml(`${titleBase}, ${w.distanceMiles} miles`)}
summary: ${yaml(`${w.distanceMiles} miles and ${w.ascentM}m of ascent around ${titleBase}, walked in ${hours}h${String(mins).padStart(2, "0")}. Route notes to follow.`)}
heroImage: ${yaml(heroImage)}
publishDate: ${w.date}
walkDate: ${w.date}
difficulty: ${diff}
distance: ${w.distanceMiles}
ascentM: ${w.ascentM}
location: ${yaml(location)}
region: ${yaml(region)}
dogFriendly: true
parking: "TODO: where did you park?"
gpxDownload: ${yaml(w.gpxDownload)}
routeMapLat: ${w.routeMapLat}
routeMapLng: ${w.routeMapLng}
routeMapZoom: ${zoomFor(w.bounds)}
tags: []
draft: true
---

## The day

TODO — what was the weather doing, who came, why this route?

## The route

TODO — the actual line: where you started, the order of the ground, where it
got interesting, where it got tedious.

## For the dog

TODO — livestock, stiles, water, anywhere Ember needed the lead.

## Parking and practicalities

TODO — where you left the car, what it cost, facilities, anything to know.

---

*Recorded ${w.date}: ${w.distanceMiles} miles, ${w.ascentM}m ascent, ${hours}h${String(mins).padStart(2, "0")} moving.*
`;

  await writeFile(file, body);
  written++;
  console.log(`${w.date}  ${String(w.distanceMiles).padStart(5)}mi  ${String(w.ascentM).padStart(4)}m  ${diff.padEnd(8)} ${slug}`);
}

await mkdir(CACHE, { recursive: true });
await writeFile(GEO_CACHE, JSON.stringify(geo, null, 2));

console.log(`\n${written} draft walks written to src/content/walks/, ${skipped} left alone.`);
console.log("All are draft: true — browse them at /preview/walks/<slug>/");
