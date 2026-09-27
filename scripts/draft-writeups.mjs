/**
 * Drafts a write-up for each walk from evidence only.
 *
 * What goes in is measured or recorded: the places the GPS track passes
 * through in the order walked, the shape of the route, distance, ascent and
 * where the climbing fell, start and finish times, the season, and what the
 * photographs are of and where along the route they were taken.
 *
 * What is NOT written is anything unknowable from the data — the weather, who
 * came, why that route, where the car went, whether the livestock were a
 * problem. Those stay as explicit questions, because inventing them would put
 * fiction about Nick's own walks on his own website.
 *
 * Every draft is marked so an unreviewed one is obvious on the page.
 *
 * Usage: node scripts/draft-writeups.mjs [--walk DATE] [--dry-run] [--overwrite]
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");
const WALKS = join(ROOT, "src", "content", "walks");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const ONLY = flag("walk", null);
const DRY = argv.includes("--dry-run");
// Never clobber prose Nick has written unless explicitly told to.
const OVERWRITE = argv.includes("--overwrite");

const read = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

const waypoints = await read(join(CACHE, "route-waypoints.json"), []);
const manifest = await read(join(CACHE, "walks-manifest.json"), []);
const byDate = new Map(waypoints.map((w) => [w.date, w]));
const statsBy = new Map(manifest.map((w) => [w.date, w]));
const wx = new Map(Object.entries(await read(join(CACHE, "walk-weather.json"), {})));

const files = (await readdir(WALKS)).filter((f) => f.endsWith(".md")).sort();

/** "Hathersage, then Hollow Meadows, Ughill and Sheffield, back to Hathersage" */
function routeSentence(wps, shape) {
  const raw = wps.map((w) => w.name);
  if (!raw.length) return null;

  // A route that crosses its own ground samples the same place more than
  // once — "Wash → Chinley → Hayfield → Wash → Edale → Castleton → Wash"
  // reads as a mistake. Keep first appearances, and let a circular route
  // close back on its start.
  const seen = new Set();
  const names = [];
  for (const n of raw) {
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  if (shape === "circular" && names.length > 1 && names[names.length - 1] !== names[0]) {
    names.push(names[0]);
  }

  if (names.length === 1) {
    return `A loop around ${names[0]}.`;
  }
  if (names.length < 2) return null;
  const circular = shape === "circular" && names[0] === names[names.length - 1];
  const middle = circular ? names.slice(1, -1) : names.slice(1);
  if (!middle.length) return `A loop from ${names[0]}.`;
  const list =
    middle.length === 1
      ? middle[0]
      : `${middle.slice(0, -1).join(", ")} and ${middle[middle.length - 1]}`;
  return circular
    ? `From ${names[0]}, out over ${list}, and back round to ${names[0]}.`
    : `From ${names[0]} through ${list}.`;
}

/** Where the climbing fell, in plain words. */
function climbSentence(profile, ascentM) {
  if (!ascentM || !profile?.length) return null;
  const total = profile.reduce((a, b) => a + b, 0) || 1;
  const share = profile.map((m) => m / total);
  const max = Math.max(...share);
  const idx = share.indexOf(max);
  const where = ["first", "second", "third", "fourth", "last"][idx];
  if (max < 0.32) {
    return `The ${ascentM}m of ascent comes in bits rather than one long pull. It keeps coming.`;
  }
  return `Most of the ${ascentM}m lands in the ${where} fifth${
    idx === 0 ? ". It goes up early" : idx === 4 ? ", so there is a sting in the tail" : ""
  }.`;
}

/**
 * The weather, in the words a walker would use rather than a forecast.
 *
 * Open-Meteo's archive gives the real conditions for the hours the track was
 * moving, so this is recorded fact, not inference from the photographs.
 */
function weatherSentence(w) {
  if (!w) return null;
  const bits = [];

  const cold = w.tempMin !== null && w.tempMin <= 2;
  const warm = w.tempMax !== null && w.tempMax >= 18;

  if (w.condition && /snow/.test(w.condition)) {
    bits.push(
      w.tempMin === w.tempMax
        ? `Snow, and ${w.tempMin} degrees with it`
        : `Snow, and ${w.tempMin} to ${w.tempMax} degrees with it`,
    );
  } else if (w.condition && /heavy rain|heavy showers/.test(w.condition)) {
    bits.push(`Proper rain, ${w.rainMm}mm of it over ${w.wetHours} hours`);
  } else if (w.condition && /(rain|showers|drizzle)/.test(w.condition)) {
    bits.push(
      w.wetHours <= 1
        ? `A bit of ${w.condition} but nothing that lasted`
        : `${w.condition[0].toUpperCase()}${w.condition.slice(1)} on and off for ${w.wetHours} hours`,
    );
  } else if (w.cloudAvg !== null && w.cloudAvg >= 90) {
    bits.push("Grey the whole way, cloud never really breaking");
  } else if (w.cloudAvg !== null && w.cloudAvg <= 25) {
    bits.push("Clear, the sort of day you plan around");
  } else {
    bits.push("Cloud and sun taking turns");
  }

  if (w.tempMin !== null && w.tempMax !== null && !/snow/.test(w.condition ?? "")) {
    // On a short walk the hourly readings often do not move, and "7 to 7
    // degrees" reads like a mistake.
    const range = w.tempMin === w.tempMax
      ? `${w.tempMin} degrees`
      : `${w.tempMin} to ${w.tempMax} degrees`;
    bits.push(cold ? `${range}, cold enough to keep moving`
      : warm ? `${range} and warm for it`
      : range);
  }

  if (w.gustMaxKmh !== null && w.gustMaxKmh >= 45) {
    bits.push(`wind gusting to ${w.gustMaxKmh}km/h`);
  } else if (w.windAvgKmh !== null && w.windAvgKmh >= 20) {
    bits.push(`a steady ${w.windAvgKmh}km/h wind`);
  }

  if (!w.rainMm && !/snow/.test(w.condition ?? "")) bits.push("dry underfoot at least");

  return bits.join(", ").replace(/, ([^,]*)$/, ", $1") + ".";
}

/**
 * A tally of the day's photographs.
 *
 * Deliberately not used in the prose any more. The page shows the photographs,
 * so counting them reads as filler: "2 of the photographs from this one" tells
 * a reader nothing about the walk. Kept because it is useful on the console
 * when deciding which walks have enough material to write up.
 */
function photoSentence(photos) {
  if (!photos?.length) return null;
  const n = photos.length;
  const dog = photos.filter((p) => p.subject === "dog").length;
  const scenery = photos.filter((p) => p.subject === "scenery").length;
  // Photo times are stored as UTC ISO strings; the track prints local. Slicing
  // the ISO would put every summer walk an hour out against its own timings.
  const local = (iso) =>
    new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    });
  const first = local(photos[0].time);
  const last = local(photos[n - 1].time);
  const bits = [`${n} photograph${n === 1 ? "" : "s"} from the day, ${first} to ${last}`];
  if (scenery) bits.push(`${scenery} of the view`);
  if (dog) bits.push(`${dog} with Ember in ${dog === 1 ? "it" : "them"}`);
  return `${bits.join(", ")}.`;
}

let written = 0;
let skipped = 0;

for (const file of files) {
  const date = basename(file, ".md").slice(0, 10);
  if (ONLY && date !== ONLY) continue;

  const path = join(WALKS, file);
  const src = await readFile(path, "utf8");

  // Only writeupStatus decides this. Sniffing for a TODO marker was brittle:
  // removing em dashes turned every "TODO —" into "TODO:", so the check
  // silently classified all 59 drafts as hand-written and regenerating became
  // a no-op.
  const reviewed = /^writeupStatus: reviewed$/m.test(src);
  if (reviewed && !OVERWRITE) {
    skipped++;
    continue;
  }

  // Companions are confirmed by Nick and live in the frontmatter, so they
  // survive a regenerate. Never inferred: the face detector reported two
  // people on 2026-04-06 and the photograph is Nick on his own.
  const companionsRaw = /^companions: (\[.*\])$/m.exec(src)?.[1];
  let companions = [];
  try { companions = companionsRaw ? JSON.parse(companionsRaw) : []; } catch { /* none */ }

  const wp = byDate.get(date);
  const stats = statsBy.get(date);
  const photos = (await read(join(ROOT, "public", "photos", `${date}.json`), {}))?.photos ?? [];

  const route = wp ? routeSentence(wp.waypoints, wp.shape) : null;

  // High and low points say more about a walk than a list of parishes.
  const relief = (() => {
    if (!wp?.high?.ele || !wp?.low?.ele) return null;
    const drop = wp.high.ele - wp.low.ele;
    if (drop < 60) return null;
    const hi = wp.high.name ? `${wp.high.name} at ${wp.high.ele}m` : `${wp.high.ele}m`;
    const lo = wp.low.name ? `${wp.low.name} at ${wp.low.ele}m` : `${wp.low.ele}m`;
    return `The high point is ${hi}, the low ${lo}, so there is ${drop}m of relief between them.`;
  })();

  // The GPX starts where the car was parked.
  const parking = (() => {
    const g = wp?.startGridRef;
    const road = wp?.startAt?.road;
    const pc = wp?.startAt?.postcode;
    if (!g && !road) return null;
    const bits = [];
    if (g) bits.push(`**${g}**`);
    if (road) bits.push(road);
    if (pc) bits.push(pc);
    return `The track starts at ${bits.join(", ")}.`;
  })();
  const climb = wp ? climbSentence(wp.climbProfile, wp.ascentM ?? stats?.ascentM) : null;
  const pics = photoSentence(photos);

  const shape = wp?.shape === "circular" ? "a circular route" : "a point-to-point";
  const when = wp ? `${wp.month} ${date.slice(0, 4)}` : date.slice(0, 4);
  const timing = wp ? `Out at ${wp.startTime}, back at ${wp.endTime}` : null;

  const weather = weatherSentence(wx.get(date));

  const names = companions.length === 1
    ? companions[0]
    : companions.length > 1
      ? `${companions.slice(0, -1).join(", ")} and ${companions[companions.length - 1]}`
      : null;

  const opener = [
    `${wp?.month ?? ""} ${date.slice(0, 4)}.`.trim(),
    `${stats?.distanceMiles ?? "?"} miles${
      wp?.shape === "circular" ? " round" : " point to point"
    }${stats?.ascentM ? ` with ${stats.ascentM}m of climbing` : ""}${
      stats?.durationLabel ? `, ${stats.durationLabel} on the move` : ""
    }.`,
  ].join(" ");

  const body = `## The day

${opener}

${weather ?? ""}

${[
  wp
    ? names
      ? `Out with ${names}, ${wp.startTime} to ${wp.endTime}.`
      : `Out at ${wp.startTime}, back at ${wp.endTime}.`
    : names
      ? `Out with ${names}.`
      : null,
].filter(Boolean).join(" ")}

> **Proposed write-up.** The route, the timings and the weather above are all
> recorded fact.${names ? "" : " Who came is still unknown."} What is still
> missing is why this route on this day, and how it actually felt. Rewrite
> this section and delete this note.

## The route

${route ?? "TODO: where you started, the order of the ground, where it got interesting."}
${relief ? `\n${relief}\n` : ""}${climb ? `\n${climb}\n` : ""}
> TODO: the things a map does not carry. What it was like underfoot, the gates
> and the stiles, where the path gives up, and what is worth stopping for.

## For the dog

> TODO: livestock, anything she could not get over or through, water on the
> route, where she needed the lead, and how she was by the end.

## Parking and practicalities

${parking ?? ""}

> TODO: whether that is where you actually parked, what it cost, facilities,
> and the one thing you would want to know before setting off.

---

*Recorded ${date}. ${stats?.distanceMiles ?? "?"} miles, ${stats?.ascentM ?? "?"}m of ascent, ${
    stats?.durationLabel ?? "?"
  } moving.*
`;

  // Replace the body, keep the frontmatter, and flag the draft state.
  const parts = src.split(/\n---\n/);
  if (parts.length < 2) { skipped++; continue; }
  const frontmatter = parts[0] + "\n---\n";
  let out = frontmatter + "\n" + body;
  if (!out.includes("writeupStatus:")) {
    out = out.replace(/^draft: /m, "writeupStatus: draft\ndraft: ");
  }

  if (!DRY) await writeFile(path, out);
  written++;
  console.log(`  ${date}  ${route ? route.slice(0, 62) : "(no route data)"}`);
}

console.log(`\n${written} drafts written, ${skipped} left alone (marked reviewed).`);
if (DRY) console.log("(dry run — nothing written)");
