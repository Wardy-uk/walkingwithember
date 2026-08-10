/**
 * Extracts walk/hike GPX files from a Health Auto Export zip,
 * downsamples track points, and saves compact GeoJSON files to
 * public/routes/YYYY-MM-DD.json (keyed by date for walk page lookup).
 *
 * Usage: node scripts/process-routes.mjs <path-to-zip>
 */

import { createReadStream } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createUnzip } from 'zlib';
import { pipeline } from 'stream/promises';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '..');
const OUT    = join(ROOT, 'public', 'routes');

const WALK_TYPES = ['Hiking', 'Outdoor Walk', 'Trail Run', 'Running'];
const TARGET_PTS = 1500; // max points per route after downsampling

// ── GPX parser (no deps, regex-based for speed) ─────────────────────────────

function parseGpx(xml) {
  const points = [];
  // Match each trkpt element: lat, lon, ele
  const re = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>(?:[^<]*<[^/][^>]*>[^<]*<\/[^>]*>)*?[^<]*<ele>([^<]+)<\/ele>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    const ele = parseFloat(m[3]);
    if (!isNaN(lat) && !isNaN(lon)) {
      points.push([lon, lat, isNaN(ele) ? 0 : Math.round(ele * 10) / 10]);
    }
  }
  return points;
}

// ── Ramer-Douglas-Peucker simplification ────────────────────────────────────

function perpendicularDist([x, y], [lx1, ly1], [lx2, ly2]) {
  const dx = lx2 - lx1, dy = ly2 - ly1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - lx1, y - ly1);
  const t = Math.max(0, Math.min(1, ((x - lx1) * dx + (y - ly1) * dy) / len2));
  return Math.hypot(x - (lx1 + t * dx), y - (ly1 + t * dy));
}

function rdp(points, eps) {
  if (points.length < 3) return points;
  let maxDist = 0, idx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > eps) {
    const l = rdp(points.slice(0, idx + 1), eps);
    const r = rdp(points.slice(idx), eps);
    return [...l.slice(0, -1), ...r];
  }
  return [first, last];
}

function simplify(points, target) {
  if (points.length <= target) return points;
  // Binary search for epsilon that gives ~target points
  let lo = 0, hi = 0.01, result = points;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const s = rdp(points, mid);
    if (s.length > target) lo = mid;
    else { hi = mid; result = s; }
    if (Math.abs(s.length - target) < 10) break;
  }
  return result;
}

// ── Zip reading (streaming, no deps) ────────────────────────────────────────

async function readZipEntries(zipPath) {
  // Use the system `unzip` to extract GPX files we care about
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);

  // List entries
  const { stdout } = await exec('unzip', ['-l', zipPath]);
  const lines = stdout.split('\n');
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^\s+\d+\s+[\d-]+\s+[\d:]+\s+(.+\.gpx)$/);
    if (!m) continue;
    const name = m[1].trim();
    const type = WALK_TYPES.find(t => name.startsWith(t + '-Route-'));
    if (!type) continue;
    // Extract date from filename: Type-Route-YYYYMMDD_HHMMSS.gpx
    const dm = name.match(/(\d{8})_\d{6}\.gpx$/);
    if (!dm) continue;
    const raw = dm[1]; // YYYYMMDD
    const date = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
    entries.push({ name, date, type });
  }
  return entries;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const zipPath = process.argv[2];
if (!zipPath) { console.error('Usage: node process-routes.mjs <zip>'); process.exit(1); }

await mkdir(OUT, { recursive: true });

const entries = await readZipEntries(zipPath);
console.log(`Found ${entries.length} walk/hike GPX files`);

const { execFile } = await import('child_process');
const { promisify } = await import('util');
const exec = promisify(execFile);

// Group by date — keep largest file (most GPS data) if duplicates
const byDate = {};
for (const e of entries) {
  if (!byDate[e.date] || e.type === 'Hiking') byDate[e.date] = e;
}

let saved = 0, skipped = 0;
for (const [date, entry] of Object.entries(byDate).sort()) {
  try {
    // Extract GPX content
    const { stdout: xml } = await exec('unzip', ['-p', zipPath, entry.name],
      { maxBuffer: 50 * 1024 * 1024 });

    const raw = parseGpx(xml);
    if (raw.length < 10) { skipped++; console.log(`  skip ${date}: only ${raw.length} points`); continue; }

    const simplified = simplify(raw, TARGET_PTS);

    // Compute bounds
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let minEle = Infinity, maxEle = -Infinity;
    for (const [lon, lat, ele] of simplified) {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (ele < minEle) minEle = ele; if (ele > maxEle) maxEle = ele;
    }

    const out = {
      date,
      type: entry.type,
      count: simplified.length,
      bounds: {
        minLat: Math.round(minLat * 1e5) / 1e5,
        maxLat: Math.round(maxLat * 1e5) / 1e5,
        minLon: Math.round(minLon * 1e5) / 1e5,
        maxLon: Math.round(maxLon * 1e5) / 1e5,
        minEle: Math.round(minEle),
        maxEle: Math.round(maxEle),
      },
      // [lon, lat, ele] — GeoJSON coordinate order
      coords: simplified.map(([lon, lat, ele]) => [
        Math.round(lon * 1e5) / 1e5,
        Math.round(lat * 1e5) / 1e5,
        Math.round(ele),
      ]),
    };

    const outPath = join(OUT, `${date}.json`);
    await writeFile(outPath, JSON.stringify(out));

    const kb = (JSON.stringify(out).length / 1024).toFixed(1);
    console.log(`  ${date}  ${raw.length} → ${simplified.length} pts  ${kb}KB  [${entry.type}]`);
    saved++;
  } catch (err) {
    console.error(`  ERROR ${date}: ${err.message}`);
    skipped++;
  }
}

console.log(`\nDone: ${saved} routes saved, ${skipped} skipped → ${OUT}`);
