/**
 * Shared track parsing and geometry for the walk ingest scripts.
 * No dependencies — GPX/TCX are read with regexes, which is fine for the
 * machine-generated files Strava and Health Auto Export produce.
 */

// ── Parsing ─────────────────────────────────────────────────────────────────

const TRKPT_RE = /<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/g;
const ELE_RE = /<ele>([-\d.]+)<\/ele>/;
const TIME_RE = /<time>([^<]+)<\/time>/;

/** Parse GPX text into [{lon, lat, ele, time}] — time is a Date or null. */
export function parseGpx(xml) {
  const points = [];
  let m;
  TRKPT_RE.lastIndex = 0;
  while ((m = TRKPT_RE.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const body = m[3] ?? "";
    const ele = ELE_RE.exec(body);
    const time = TIME_RE.exec(body);
    points.push({
      lon,
      lat,
      ele: ele ? parseFloat(ele[1]) : 0,
      time: time ? new Date(time[1]) : null,
    });
  }
  return points;
}

const TCX_PT_RE = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
const TCX_LAT_RE = /<LatitudeDegrees>([-\d.]+)<\/LatitudeDegrees>/;
const TCX_LON_RE = /<LongitudeDegrees>([-\d.]+)<\/LongitudeDegrees>/;
const TCX_ALT_RE = /<AltitudeMeters>([-\d.]+)<\/AltitudeMeters>/;
const TCX_TIME_RE = /<Time>([^<]+)<\/Time>/;

/** Parse TCX text into the same shape as parseGpx. */
export function parseTcx(xml) {
  const points = [];
  let m;
  TCX_PT_RE.lastIndex = 0;
  while ((m = TCX_PT_RE.exec(xml)) !== null) {
    const body = m[1];
    const lat = TCX_LAT_RE.exec(body);
    const lon = TCX_LON_RE.exec(body);
    if (!lat || !lon) continue; // indoor/paused points carry no position
    const alt = TCX_ALT_RE.exec(body);
    const time = TCX_TIME_RE.exec(body);
    points.push({
      lon: parseFloat(lon[1]),
      lat: parseFloat(lat[1]),
      ele: alt ? parseFloat(alt[1]) : 0,
      time: time ? new Date(time[1]) : null,
    });
  }
  return points;
}

/**
 * Parse a FIT file into the same shape as parseGpx.
 *
 * Strava's export keeps whatever you originally uploaded, and for an Apple
 * Watch that is FIT — 714 of the 869 activity files here. Without this the
 * back catalogue is invisible.
 *
 * fit-file-parser is callback-based, hence the wrapper. `force` keeps it
 * going through the malformed trailers some exports carry.
 */
export async function parseFit(buffer) {
  const { default: FitParser } = await import("fit-file-parser");
  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    lengthUnit: "m",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "list",
  });

  const data = await new Promise((resolve, reject) => {
    parser.parse(buffer, (err, out) => (err ? reject(err) : resolve(out)));
  });

  return (data.records ?? [])
    .filter((r) => Number.isFinite(r.position_lat) && Number.isFinite(r.position_long))
    .map((r) => ({
      lon: r.position_long,
      lat: r.position_lat,
      ele: Number.isFinite(r.altitude) ? r.altitude : 0,
      time: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
    }));
}

/** The activity type a FIT file declares, e.g. "hiking", "walking". */
export async function fitSport(buffer) {
  const { default: FitParser } = await import("fit-file-parser");
  const parser = new FitParser({ force: true, mode: "list" });
  try {
    const data = await new Promise((resolve, reject) => {
      parser.parse(buffer, (err, out) => (err ? reject(err) : resolve(out)));
    });
    return (
      data.sessions?.[0]?.sport ??
      data.activity?.sessions?.[0]?.sport ??
      null
    );
  } catch {
    return null;
  }
}

// ── Geometry ────────────────────────────────────────────────────────────────

export function haversine(a, b) {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Distance, ascent and duration for a track.
 * Ascent uses a 1m threshold to damp GPS jitter, which otherwise inflates
 * the total by hundreds of metres over a long walk.
 */
export function trackStats(points) {
  let metres = 0;
  for (let i = 0; i < points.length - 1; i++) {
    metres += haversine(points[i], points[i + 1]);
  }

  let ascentM = 0;
  let descentM = 0;
  let ref = points[0]?.ele ?? 0;
  for (const p of points.slice(1)) {
    const delta = p.ele - ref;
    if (delta > 1) ascentM += delta;
    else if (delta < -1) descentM += -delta;
    if (Math.abs(delta) > 1) ref = p.ele;
  }

  const times = points.map((p) => p.time).filter((t) => t && !isNaN(t));
  const start = times[0] ?? null;
  const end = times[times.length - 1] ?? null;
  const durationMin = start && end ? (end - start) / 60000 : null;

  const eles = points.map((p) => p.ele);

  return {
    miles: metres / 1609.34,
    km: metres / 1000,
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    durationMin: durationMin === null ? null : Math.round(durationMin),
    start,
    end,
    minEle: Math.round(Math.min(...eles)),
    maxEle: Math.round(Math.max(...eles)),
    bounds: {
      minLat: Math.min(...points.map((p) => p.lat)),
      maxLat: Math.max(...points.map((p) => p.lat)),
      minLon: Math.min(...points.map((p) => p.lon)),
      maxLon: Math.max(...points.map((p) => p.lon)),
    },
  };
}

// ── Simplification (Ramer–Douglas–Peucker) ──────────────────────────────────

function perpendicularDist(p, a, b) {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.lon - a.lon, p.lat - a.lat);
  const t = Math.max(
    0,
    Math.min(1, ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / len2),
  );
  return Math.hypot(p.lon - (a.lon + t * dx), p.lat - (a.lat + t * dy));
}

function rdp(points, eps) {
  if (points.length < 3) return points;
  let maxDist = 0;
  let idx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > eps) {
    return [
      ...rdp(points.slice(0, idx + 1), eps).slice(0, -1),
      ...rdp(points.slice(idx), eps),
    ];
  }
  return [first, last];
}

/** Simplify to roughly `target` points, preserving route shape. */
export function simplify(points, target) {
  if (points.length <= target) return points;
  let lo = 0;
  let hi = 0.01;
  let result = points;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const s = rdp(points, mid);
    if (s.length > target) lo = mid;
    else {
      hi = mid;
      result = s;
    }
    if (Math.abs(s.length - target) < 10) break;
  }
  return result;
}

// ── Output ──────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
  );

export function toGpx({ name, points }) {
  const time = points.find((p) => p.time)?.time;
  const trkpts = points
    .map((p) => {
      const ele = Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : "";
      const t = p.time && !isNaN(p.time) ? `<time>${p.time.toISOString()}</time>` : "";
      return `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}${t}</trkpt>`;
    })
    .join("\n      ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="walkingwithember" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(name)}</name>${time ? `\n    <time>${time.toISOString()}</time>` : ""}
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
      ${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "walk";
}
