/**
 * Chooses a hero image for each walk: a picture of the landscape, not of Nick.
 *
 * The library's own face detection does the work. Photos records animal faces
 * alongside human ones — ZDETECTIONTYPE 1 is a person, 3 is an animal — so
 * only human detections disqualify a photo. Ember is welcome in a hero on a
 * dog-walking blog; Nick is not.
 *
 * Orientation is left alone. Most walk photos are portrait, and cropping them
 * to a banner would throw away the composition; the page constrains the hero's
 * display instead (see `.article > img` in global.css), so any aspect works.
 *
 * Among the face-free candidates it prefers shots taken further along the
 * route — the view from the top beats the one from the car park.
 *
 * Usage: node scripts/pick-hero-images.mjs [--dry-run]
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";

const exec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");
const LIB = join(homedir(), "Pictures", "Photos Library.photoslibrary");
const DRY = process.argv.includes("--dry-run");

const matches = JSON.parse(await readFile(join(CACHE, "photo-matches.json"), "utf8"));

// ── Face counts, straight from the Photos database ──────────────────────────

const uuids = [
  ...new Set(
    matches
      .flatMap((w) => w.photos.map((p) => (p.filename ?? "").split(".")[0].toUpperCase()))
      .filter(Boolean),
  ),
];
const sql = `SELECT upper(a.ZUUID), a.ZWIDTH, a.ZHEIGHT,
  (SELECT COUNT(*) FROM ZDETECTEDFACE f
     WHERE f.ZASSETFORFACE = a.Z_PK AND f.ZDETECTIONTYPE = 1)
  FROM ZASSET a WHERE upper(a.ZUUID) IN (${uuids.map((u) => `'${u}'`).join(",")});`;

const { stdout } = await exec(
  "sqlite3",
  ["-separator", "|", `file:${join(LIB, "database", "Photos.sqlite")}?immutable=1`, sql],
  { maxBuffer: 1 << 28 },
);

const meta = new Map();
for (const line of stdout.trim().split("\n")) {
  if (!line) continue;
  const [uuid, w, h, faces] = line.split("|"); // faces = humans only
  meta.set(uuid, { w: +w, h: +h, faces: +faces });
}

const walkFiles = await readdir(join(ROOT, "src", "content", "walks"));
const report = [];

for (const walk of matches) {
  const dir = join(ROOT, "public", "uploads", "images", "walks", walk.date);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    continue;
  }

  const candidates = [];
  for (const photo of walk.photos) {
    const m = meta.get((photo.filename ?? "").split(".")[0].toUpperCase());
    if (!m || m.faces > 0) continue; // a human face means it is a photo of someone
    const stem = (photo.filename ?? "").split(".")[0].slice(0, 8).toLowerCase();
    const file = files.find((f) => f.includes(stem));
    if (!file) continue;
    candidates.push({
      file,
      progress: photo.routeFraction ?? 0,
      orientation: m.w > m.h ? "landscape" : "portrait",
    });
  }

  if (!candidates.length) {
    report.push({ date: walk.date, status: "no face-free photo — left as is", n: 0 });
    continue;
  }

  // Furthest along the route wins: the view from the top, not the car park.
  candidates.sort((a, b) => b.progress - a.progress);
  const pick = candidates[0];
  const src = `/uploads/images/walks/${walk.date}/${pick.file}`;

  const mdName = walkFiles.find((f) => f.startsWith(walk.date) && f.endsWith(".md"));
  if (mdName && !DRY) {
    const p = join(ROOT, "src", "content", "walks", mdName);
    const s = await readFile(p, "utf8");
    const s2 = s.replace(/^heroImage: ".*"$/m, `heroImage: "${src}"`);
    if (s2 !== s) await writeFile(p, s2);
  }

  report.push({
    date: walk.date,
    status: `${pick.orientation}, ${Math.round(pick.progress * 100)}% along the route`,
    n: candidates.length,
  });
}

console.log(`${"walk".padEnd(12)} ${"options".padStart(7)}  chosen`);
console.log("-".repeat(56));
for (const r of report) console.log(`${r.date.padEnd(12)} ${String(r.n).padStart(7)}  ${r.status}`);

const gaps = report.filter((r) => r.n === 0);
console.log(`\n${report.length - gaps.length} walks given a landscape hero (no people in frame).`);
if (gaps.length) {
  console.log(`${gaps.length} walk(s) have a face in every photo, so nothing changed:`);
  for (const g of gaps) console.log(`  ${g.date}`);
}
if (DRY) console.log("(dry run — nothing written)");
