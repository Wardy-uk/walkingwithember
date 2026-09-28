import fs from "node:fs";
import path from "node:path";

/**
 * A walk's elevation profile, read from its GPX at build time.
 *
 * Returns the elevation in metres at `samples + 1` evenly spaced points along
 * the track, each averaged over its own stretch so GPS jitter does not show
 * as teeth. The homepage draws the hero's lower edge with it, so the line is
 * the real ground of a real walk rather than decorative terrain.
 *
 * Returns null when the walk has no local GPX, so the caller can leave the
 * profile out instead of drawing something made up.
 */
export function routeProfile(gpxPath: string | undefined, samples = 160) {
  if (!gpxPath || /^https?:/.test(gpxPath)) return null;
  const file = path.join(process.cwd(), "public", gpxPath);
  if (!fs.existsSync(file)) return null;

  const xml = fs.readFileSync(file, "utf8");
  const pts = [...xml.matchAll(/<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>\s*<ele>([-\d.]+)<\/ele>/g)]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  if (pts.length < 2) return null;

  const rad = (d: number) => (d * Math.PI) / 180;
  const along = [0];
  for (let i = 1; i < pts.length; i++) {
    const [aLat, aLng] = pts[i - 1];
    const [bLat, bLng] = pts[i];
    const h =
      Math.sin(rad(bLat - aLat) / 2) ** 2 +
      Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
    along.push(along[i - 1] + 2 * 6371000 * Math.asin(Math.sqrt(h)));
  }

  const total = along[along.length - 1];
  const step = total / samples;
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k <= samples; k++) {
    const lo = (k - 0.5) * step;
    const hi = (k + 0.5) * step;
    while (j < along.length - 1 && along[j] < lo) j++;
    let sum = 0;
    let n = 0;
    for (let i = j; i < along.length && along[i] <= hi; i++) {
      sum += pts[i][2];
      n++;
    }
    out.push(n ? sum / n : pts[Math.min(j, pts.length - 1)][2]);
  }
  return { elevations: out, totalMetres: total };
}
