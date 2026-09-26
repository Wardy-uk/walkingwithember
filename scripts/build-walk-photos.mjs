/**
 * Turns a folder of exported photos into web assets plus the per-walk photo
 * data the route map pins.
 *
 * Re-indexes and re-matches the folder against the ingested walks, so any
 * non-walk photos caught by exporting a whole day are dropped on GPS, not
 * left for you to weed out by hand.
 *
 * Writes:
 *   public/uploads/images/walks/<date>/<nn>-<uuid>.jpg   web-sized JPEGs
 *   public/photos/<date>.json                            map pins + gallery order
 *
 * Usage:
 *   node scripts/build-walk-photos.mjs <exported-folder> [options]
 *     --width 1600     long-edge pixels for the web copies (default 1600)
 *     --walk 2026-08-06   only this walk
 *     --limit 12       keep at most this many per walk, spread along the route
 *     --force          re-convert images that already exist
 */

import { readFile, writeFile, mkdir, access, readdir } from "fs/promises";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");
const IMG_ROOT = join(ROOT, "public", "uploads", "images", "walks");
const PHOTO_JSON = join(ROOT, "public", "photos");

const argv = process.argv.slice(2);
const SOURCE = argv.find((a) => !a.startsWith("--"));
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const WIDTH = Number(flag("width", "1600"));
const ONLY = flag("walk", null);
const LIMIT = flag("limit", null) ? Number(flag("limit", null)) : null;
const FORCE = argv.includes("--force");

if (!SOURCE) {
  console.error("Usage: node scripts/build-walk-photos.mjs <exported-folder> [--width 1600] [--walk DATE] [--limit 12] [--force]");
  process.exit(1);
}

const exists = (p) => access(p).then(() => true, () => false);

// Re-run the index + match over the export folder so the pipeline is one step.
console.log("Indexing exported folder…");
await exec("node", [join(__dir, "index-photos.mjs"), SOURCE], { cwd: ROOT, maxBuffer: 1 << 28 });
console.log("Matching against walks…");
await exec("node", [join(__dir, "match-photos.mjs")], { cwd: ROOT, maxBuffer: 1 << 28 });

let matches = JSON.parse(await readFile(join(CACHE, "photo-matches.json"), "utf8"));
if (ONLY) matches = matches.filter((w) => w.date === ONLY);

/** Keep `n` photos spread evenly along the route rather than the first n. */
function spread(photos, n) {
  if (!n || photos.length <= n) return photos;
  const step = (photos.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => photos[Math.round(i * step)]);
}

await mkdir(PHOTO_JSON, { recursive: true });

let converted = 0;
let kept = 0;

for (const walk of matches) {
  const chosen = spread(walk.photos, LIMIT);
  const outDir = join(IMG_ROOT, walk.date);
  await mkdir(outDir, { recursive: true });

  const pins = [];
  for (const [i, photo] of chosen.entries()) {
    if (!photo.path) continue;
    const stem = basename(photo.path, extname(photo.path));
    const name = `${String(i + 1).padStart(2, "0")}-${stem.slice(0, 8).toLowerCase()}.jpg`;
    const outPath = join(outDir, name);

    if (FORCE || !(await exists(outPath))) {
      try {
        // sips is built into macOS and reads HEIC without extra tooling.
        await exec("sips", ["-s", "format", "jpeg", "-Z", String(WIDTH), photo.path, "--out", outPath]);
        converted++;
      } catch (e) {
        console.warn(`  ! ${basename(photo.path)} — conversion failed (${e.stderr?.trim() || e.message})`);
        continue;
      }
    }

    pins.push({
      src: `/uploads/images/walks/${walk.date}/${name}`,
      time: photo.time,
      lat: photo.lat,
      lon: photo.lon,
      metresAlongRoute: photo.metresAlongRoute,
      routeFraction: photo.routeFraction,
      // Photos matched on time alone have no trustworthy position, so the map
      // should not pin them — the gallery still shows them.
      pinnable: photo.basis === "gps+time",
    });
    kept++;
  }

  await writeFile(
    join(PHOTO_JSON, `${walk.date}.json`),
    JSON.stringify({ date: walk.date, count: pins.length, photos: pins }),
  );

  const pinned = pins.filter((p) => p.pinnable).length;
  console.log(`${walk.date}  ${String(pins.length).padStart(3)} photos (${pinned} pinnable) → public/photos/${walk.date}.json`);
}

console.log(`\n${kept} photos across ${matches.length} walks; ${converted} newly converted at ${WIDTH}px.`);
