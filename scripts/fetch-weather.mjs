/**
 * Pulls the weather each walk was actually done in.
 *
 * Open-Meteo's archive is free, needs no key, and goes back decades. Asking it
 * for the hours the track was moving, at the coordinates it was moving
 * through, turns "what was the weather doing?" from a guess into a fact.
 *
 * Cached, so re-runs cost nothing.
 *
 * Usage: node scripts/fetch-weather.mjs [--walk DATE]
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { parseGpx } from "./lib/track.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(CACHE, "walk-weather.json");

const argv = process.argv.slice(2);
const i = argv.indexOf("--walk");
const ONLY = i !== -1 ? argv[i + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WMO weather codes, in the words a walker would use. */
const CODES = {
  0: "clear", 1: "mostly clear", 2: "part cloud", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

let cache = {};
try { cache = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first run */ }

let manifest = JSON.parse(await readFile(join(CACHE, "walks-manifest.json"), "utf8"));
if (ONLY) manifest = manifest.filter((w) => w.date === ONLY);

let fetched = 0;

for (const walk of manifest) {
  if (cache[walk.date]) continue;

  let points;
  try {
    points = parseGpx(await readFile(join(ROOT, "public", walk.gpxDownload), "utf8"))
      .filter((p) => p.time && !isNaN(p.time));
  } catch { continue; }
  if (points.length < 2) continue;

  const startHour = points[0].time.getHours();
  const endHour = points[points.length - 1].time.getHours();
  const lat = walk.midLat ?? points[0].lat;
  const lon = walk.midLng ?? points[0].lon;

  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(3)}` +
    `&longitude=${lon.toFixed(3)}&start_date=${walk.date}&end_date=${walk.date}` +
    `&hourly=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,cloud_cover,weather_code` +
    `&timezone=Europe%2FLondon`;

  let h;
  try {
    const res = await fetch(url);
    h = (await res.json()).hourly;
    if (!h?.time) throw new Error("no hourly data");
  } catch {
    console.log(`  ${walk.date}  weather unavailable`);
    await sleep(300);
    continue;
  }

  // Only the hours actually spent walking.
  const idx = h.time
    .map((t, n) => ({ hour: Number(t.slice(11, 13)), n }))
    .filter(({ hour }) => hour >= startHour && hour <= Math.max(startHour, endHour))
    .map(({ n }) => n);

  if (!idx.length) { await sleep(300); continue; }

  const pick = (key) => idx.map((n) => h[key][n]).filter((v) => v !== null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const temps = pick("temperature_2m");
  const feels = pick("apparent_temperature");
  const rain = pick("precipitation");
  const wind = pick("wind_speed_10m");
  const gusts = pick("wind_gusts_10m");
  const cloud = pick("cloud_cover");
  const codes = pick("weather_code");

  // The most significant condition of the day, not the most common: an hour
  // of heavy rain matters more to a walk than five hours of overcast.
  const worst = codes.length ? Math.max(...codes) : null;

  cache[walk.date] = {
    tempMin: temps.length ? Math.round(Math.min(...temps)) : null,
    tempMax: temps.length ? Math.round(Math.max(...temps)) : null,
    feelsMin: feels.length ? Math.round(Math.min(...feels)) : null,
    rainMm: rain.length ? Number(rain.reduce((a, b) => a + b, 0).toFixed(1)) : null,
    wetHours: rain.filter((v) => v > 0.1).length,
    windAvgKmh: wind.length ? Math.round(avg(wind)) : null,
    gustMaxKmh: gusts.length ? Math.round(Math.max(...gusts)) : null,
    cloudAvg: cloud.length ? Math.round(avg(cloud)) : null,
    condition: worst !== null ? (CODES[worst] ?? null) : null,
    hours: idx.length,
  };

  const w = cache[walk.date];
  console.log(
    `  ${walk.date}  ${String(w.tempMin).padStart(3)}-${String(w.tempMax).padStart(2)}C  ` +
    `${String(w.cloudAvg).padStart(3)}% cloud  ${String(w.rainMm).padStart(4)}mm  ` +
    `wind ${String(w.windAvgKmh).padStart(2)}  ${w.condition ?? ""}`,
  );
  fetched++;
  await sleep(350); // be polite to a free service
}

await mkdir(CACHE, { recursive: true });
await writeFile(OUT, JSON.stringify(cache, null, 2));
console.log(`\n${fetched} walks fetched, ${Object.keys(cache).length} cached in total.`);
