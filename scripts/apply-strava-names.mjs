/**
 * Applies Strava activity names to walk titles — but only the useful ones.
 *
 * Most Strava names are whatever the app defaulted to: "Saturday Morning
 * Hike", "Lunch Walk". Four of the sixteen walks would end up sharing a
 * title. So a name is only taken when it survives two filters:
 *
 *   - not a day-of-week + Hike/Walk pattern
 *   - not an Apple Fitness+ / auto-generated label
 *
 * Anything rejected keeps its existing place-and-distance title. Strava
 * descriptions are carried into the summary when present, since those are
 * always hand-written.
 *
 * Re-run it after renaming walks in Strava and it will pick the new names up.
 *
 * Usage: node scripts/apply-strava-names.mjs <export-dir> [--dry-run]
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const WALKS = join(ROOT, "src", "content", "walks");

const argv = process.argv.slice(2);
const SOURCE = argv.find((a) => !a.startsWith("--"));
const DRY = argv.includes("--dry-run");

if (!SOURCE) {
  console.error("Usage: node scripts/apply-strava-names.mjs <export-dir> [--dry-run]");
  process.exit(1);
}

/** Strava's own default naming, in every variant it produces. */
const GENERIC =
  /^(morning|afternoon|evening|lunch|night|early morning|late night)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(morning|afternoon|evening|lunch|night)?\s*(hike|walk|hiking|walking)\s*$/i;

/** Labels from connected apps, and Strava's date-stamped auto-names. */
const MACHINE = /apple fitness|treadmill|^untitled|^workout\b|^\d{1,2}\/\d{1,2}\/\d{4}\b/i;

/** Strava's activity type is unreliable — a round of golf is filed as a walk. */
const NOT_A_WALK = /\bgolf\b|\bpar 3\b|\bdriving range\b/i;

/**
 * Strava also auto-names by location: "Woodhouse, Charnwood / Newtown
 * Linford, Charnwood". That is real information but a poor title, so it is
 * reshaped into the site's own "A to B — N miles" form rather than used raw.
 */
const LOCATION_PAIR = /^([^,/]+?)(?:,[^/]*)?\s*\/\s*([^,/]+?)(?:,.*)?$/;

function fromLocationPair(name, distance) {
  const m = LOCATION_PAIR.exec(name.trim());
  if (!m) return null;
  const [a, b] = [m[1].trim(), m[2].trim()];
  if (!a || !b) return null;
  return a.toLowerCase() === b.toLowerCase()
    ? `${a} — ${distance} miles`
    : `${a} to ${b} — ${distance} miles`;
}

function isUseful(name, currentTitle) {
  if (!name) return false;
  const n = name.trim();
  if (n.length < 3) return false;
  if (GENERIC.test(n)) return false;
  if (MACHINE.test(n)) return false;
  if (NOT_A_WALK.test(n)) return false;
  // A bare place name ("Coalville") says less than the title it would replace
  // ("Coalville — 3.1 miles"), so only take it if it adds something.
  if (!n.includes("/") && currentTitle.toLowerCase().startsWith(n.toLowerCase())) return false;
  return true;
}

/** Minimal CSV reader — Strava quotes fields containing commas. */
function parseCsv(text) {
  const rows = [];
  let row = [""];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++; }
      else if (c === '"') q = false;
      else row[row.length - 1] += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push("");
    else if (c === "\n") { rows.push(row); row = [""]; }
    else if (c !== "\r") row[row.length - 1] += c;
  }
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

function parseDate(s) {
  // "Sep 27, 2025, 8:55:52 AM" and the 24-hour variant
  const m = /^(\w{3}) (\d{1,2}), (\d{4})/.exec(s.trim());
  if (!m) return null;
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const mo = months[m[1]];
  if (mo === undefined) return null;
  return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
}

const csv = parseCsv(await readFile(join(SOURCE, "activities.csv"), "utf8"));
const header = csv.shift().map((h) => h.trim().toLowerCase());
const col = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
const iDate = col("activity date");
const iName = col("activity name");
const iDesc = col("activity description");
const iType = col("activity type");

const byDate = new Map();
for (const r of csv) {
  const type = (r[iType] ?? "").toLowerCase();
  if (!type.includes("hike") && !type.includes("walk")) continue;
  const date = parseDate(r[iDate] ?? "");
  if (!date) continue;
  if (!byDate.has(date)) {
    byDate.set(date, { name: (r[iName] ?? "").trim(), desc: (r[iDesc] ?? "").trim() });
  }
}

const files = (await readdir(WALKS)).filter((f) => f.endsWith(".md"));
const applied = [];
const kept = [];

for (const f of files.sort()) {
  const date = basename(f).slice(0, 10);
  const hit = byDate.get(date);
  const path = join(WALKS, f);
  const s = await readFile(path, "utf8");
  const current = (/^title: "(.*)"$/m.exec(s) ?? [null, "?"])[1];

  if (!hit || !isUseful(hit.name, current)) {
    kept.push({ date, current, why: hit ? `"${hit.name}" is a default name` : "not in Strava" });
    continue;
  }

  const distance = (/^distance: (.*)$/m.exec(s) ?? [null, ""])[1].trim();
  const title = fromLocationPair(hit.name, distance) ?? hit.name;
  let out = s.replace(/^title: ".*"$/m, `title: ${JSON.stringify(title)}`);

  // A hand-written Strava description is worth more than the generated summary.
  if (hit.desc) {
    const summary = hit.desc.replace(/\s+/g, " ").slice(0, 240);
    out = out.replace(/^summary: ".*"$/m, `summary: ${JSON.stringify(summary)}`);
  }

  if (!DRY && out !== s) await writeFile(path, out);
  applied.push({ date, from: current, to: title, desc: Boolean(hit.desc) });
}

console.log(`applied ${applied.length}, kept ${kept.length}\n`);
for (const a of applied) {
  console.log(`  ${a.date}  "${a.from}"\n            -> "${a.to}"${a.desc ? "  (+ description)" : ""}`);
}
if (kept.length) {
  console.log(`\nkept the existing title:`);
  for (const k of kept) console.log(`  ${k.date}  ${k.why}`);
}
if (DRY) console.log("\n(dry run — nothing written)");
