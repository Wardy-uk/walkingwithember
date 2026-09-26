/**
 * Builds a photo index (path, timestamp, GPS) for walk matching.
 *
 * Two sources:
 *   • A folder of exported photos — read with `mdls`, needs no permissions.
 *   • The Photos library itself — read with sqlite3, needs Full Disk Access.
 *
 * Usage:
 *   node scripts/index-photos.mjs <folder>            # folder of exports
 *   node scripts/index-photos.mjs --photos-library    # ~/Pictures/Photos Library.photoslibrary
 *   node scripts/index-photos.mjs --photos-library "/path/to/Other.photoslibrary"
 *
 * Writes .cache/photo-index.json
 */

import { writeFile, mkdir, readdir, stat, access } from "fs/promises";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dir, "..", ".cache");

const SEP = String.fromCharCode(31); // ASCII unit separator, safe inside filenames

const exists = (p) => access(p).then(() => true, () => false);

const IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".heic", ".heif", ".png",
  ".tif", ".tiff", ".dng", ".raw", ".cr2", ".nef",
]);

const argv = process.argv.slice(2);
const USE_LIBRARY = argv.includes("--photos-library");
const positional = argv.filter((a) => !a.startsWith("--"));

// ── Source A: a folder, via mdls (no permissions needed) ────────────────────

async function indexFolder(root) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — skip rather than abort the whole scan
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // Library bundles are handled by the --photos-library path instead
        if (e.name.endsWith(".photoslibrary") || e.name.endsWith(".lrlibrary")) continue;
        await walk(p);
      } else if (IMAGE_EXT.has(extname(e.name).toLowerCase())) {
        files.push(p);
      }
    }
  };
  await walk(root);
  console.log(`${files.length} image files found under ${root}`);
  if (!files.length) return [];

  const out = [];
  const BATCH = 200; // mdls accepts many paths at once; keeps argv under limits
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const { stdout } = await exec(
      "mdls",
      [
        "-name", "kMDItemContentCreationDate",
        "-name", "kMDItemLatitude",
        "-name", "kMDItemLongitude",
        ...batch,
      ],
      { maxBuffer: 1 << 28 },
    );

    // mdls separates records for multiple files with a line of dashes
    const blocks = stdout.split(/^-{5,}$/m);
    blocks.forEach((block, idx) => {
      const path = batch[idx];
      if (!path) return;
      const get = (k) => {
        const m = new RegExp(`${k}\\s*=\\s*(.+)`).exec(block);
        const v = m?.[1]?.trim();
        return !v || v === "(null)" ? null : v.replace(/^"|"$/g, "");
      };
      const dateRaw = get("kMDItemContentCreationDate");
      if (!dateRaw) return;
      const lat = Number(get("kMDItemLatitude"));
      const lon = Number(get("kMDItemLongitude"));
      const time = new Date(dateRaw.replace(" +0000", "Z").replace(" ", "T"));
      if (isNaN(time)) return;
      out.push({
        path,
        filename: path.split("/").pop(),
        time: time.toISOString(),
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
      });
    });
    process.stdout.write(`\r  indexed ${Math.min(i + BATCH, files.length)}/${files.length}`);
  }
  process.stdout.write("\n");
  return out;
}

// ── Source B: the Photos library database (needs Full Disk Access) ──────────

/**
 * Maps asset UUID → local derivative JPEG.
 *
 * With iCloud "Optimise Mac Storage" the originals/ tree is empty, but Photos
 * keeps a smaller rendition of every asset under resources/derivatives. Those
 * are only ~480px on the long edge — fine for map-pin popups and thumbnails,
 * not for a hero image — but they are on disk right now, which beats waiting
 * on a background sync that may never run.
 */
async function buildDerivativeIndex(libPath) {
  const root = join(libPath, "resources", "derivatives");
  const index = new Map();

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(jpe?g|heic)$/i.test(e.name)) {
        // Files are named <UUID>_<variant>.jpeg — key on the UUID.
        const uuid = e.name.split("_")[0].toUpperCase();
        const prev = index.get(uuid);
        // Prefer the largest rendition when several exist.
        if (!prev) index.set(uuid, p);
        else {
          try {
            const [a, b] = await Promise.all([stat(prev), stat(p)]);
            if (b.size > a.size) index.set(uuid, p);
          } catch {
            /* keep what we have */
          }
        }
      }
    }
  };

  await walk(root);
  return index;
}

async function indexPhotosLibrary(libPath) {
  const db = join(libPath, "database", "Photos.sqlite");
  const uri = `file:${db}?immutable=1`;

  // Column names have shifted across Photos schema versions, so discover them
  // rather than assuming one layout.
  let schema;
  try {
    ({ stdout: schema } = await exec("sqlite3", [uri, ".schema ZASSET"], { maxBuffer: 1 << 26 }));
  } catch (e) {
    throw new Error(
      `Cannot read the Photos library: ${(e.stderr || e.message).trim()}\n` +
        "Full Disk Access for Claude is required (System Settings → Privacy & Security).",
    );
  }

  const has = (c) => new RegExp(`\\b${c}\\b`).test(schema);
  const dateCol = has("ZDATECREATED") ? "ZDATECREATED" : "ZADDEDDATE";
  const latCol = has("ZLATITUDE") ? "ZLATITUDE" : "NULL";
  const lonCol = has("ZLONGITUDE") ? "ZLONGITUDE" : "NULL";
  const dirCol = has("ZDIRECTORY") ? "ZDIRECTORY" : "''";
  const nameCol = has("ZFILENAME") ? "ZFILENAME" : "''";
  const where = has("ZTRASHEDSTATE") ? "WHERE ZTRASHEDSTATE = 0" : "";

  const sql = `SELECT ${dateCol}, ${latCol}, ${lonCol}, ${dirCol}, ${nameCol} FROM ZASSET ${where};`;
  const { stdout } = await exec("sqlite3", ["-separator", SEP, uri, sql], { maxBuffer: 1 << 28 });

  const derivatives = await buildDerivativeIndex(libPath);

  // Core Data stores timestamps as seconds since 2001-01-01 UTC.
  const APPLE_EPOCH = Date.UTC(2001, 0, 1);
  const out = [];
  let fromOriginal = 0;
  let fromDerivative = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [d, lat, lon, dir, name] = line.split(SEP);
    const secs = Number(d);
    if (!Number.isFinite(secs)) continue;
    const time = new Date(APPLE_EPOCH + secs * 1000);
    if (isNaN(time)) continue;

    const uuid = (name || "").split(".")[0].toUpperCase();
    const original = dir && name ? join(libPath, "originals", dir, name) : null;
    let path = null;
    let source = null;
    if (original && (await exists(original))) {
      path = original;
      source = "original";
      fromOriginal++;
    } else if (derivatives.has(uuid)) {
      path = derivatives.get(uuid);
      source = "derivative";
      fromDerivative++;
    }

    const la = Number(lat);
    const lo = Number(lon);
    out.push({
      path,
      source,
      filename: name || null,
      time: time.toISOString(),
      // Photos writes -180 to mean "no location"
      lat: Number.isFinite(la) && la !== -180 ? la : null,
      lon: Number.isFinite(lo) && lo !== -180 ? lo : null,
    });
  }

  console.log(`  ${fromOriginal} full originals, ${fromDerivative} derivatives on disk`);
  if (fromDerivative && !fromOriginal) {
    console.log("  (iCloud Optimise Mac Storage is on — derivatives are ~480px)");
  }
  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────

let photos;
if (USE_LIBRARY) {
  const lib = positional[0] ?? join(homedir(), "Pictures", "Photos Library.photoslibrary");
  console.log(`Reading Photos library: ${lib}`);
  photos = await indexPhotosLibrary(lib);
} else {
  if (!positional[0]) {
    console.error("Usage: node scripts/index-photos.mjs <folder> | --photos-library [path]");
    process.exit(1);
  }
  photos = await indexFolder(positional[0]);
}

photos.sort((a, b) => a.time.localeCompare(b.time));
const geo = photos.filter((p) => p.lat !== null);

await mkdir(CACHE, { recursive: true });
await writeFile(join(CACHE, "photo-index.json"), JSON.stringify(photos, null, 2));

console.log(`\n${photos.length} photos indexed, ${geo.length} with GPS.`);
if (photos.length) {
  console.log(`Date range: ${photos[0].time.slice(0, 10)} → ${photos.at(-1).time.slice(0, 10)}`);
}
console.log("→ .cache/photo-index.json");
