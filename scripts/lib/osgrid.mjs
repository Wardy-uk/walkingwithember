/**
 * WGS84 latitude/longitude to an Ordnance Survey grid reference.
 *
 * A GPX records WGS84, which is what satellites use. OS maps use OSGB36 on the
 * Airy 1830 ellipsoid, which was fitted to Britain in the nineteenth century
 * and sits roughly 100m away from WGS84 in this country. So this is not a
 * projection alone: the datum has to be shifted first with a Helmert
 * transformation, then projected with Transverse Mercator, then expressed in
 * the lettered 100km squares.
 *
 * Skipping the Helmert step is the classic mistake and puts you a field or two
 * off, which is exactly the error that matters when naming a car park.
 */

// Airy 1830 — the ellipsoid the National Grid is built on.
const AIRY = { a: 6377563.396, b: 6356256.909 };
// WGS84 — what the GPS gives you.
const WGS84 = { a: 6378137, b: 6356752.3142 };

// National Grid true origin and scale.
const F0 = 0.9996012717;
const LAT0 = (49 * Math.PI) / 180;
const LON0 = (-2 * Math.PI) / 180;
const E0 = 400000;
const N0 = -100000;

// Helmert parameters, WGS84 -> OSGB36 (OS-published).
const HELMERT = {
  tx: -446.448, ty: 125.157, tz: -542.060,
  rx: -0.1502, ry: -0.2470, rz: -0.8421, // arc-seconds
  s: 20.4894, // ppm
};

const toRad = (d) => (d * Math.PI) / 180;

/** Shift a WGS84 position onto the OSGB36 datum. */
function helmert(lat, lon) {
  const { a, b } = WGS84;
  const e2 = 1 - (b * b) / (a * a);
  const phi = toRad(lat);
  const lambda = toRad(lon);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);

  // Geodetic to cartesian
  const x1 = nu * Math.cos(phi) * Math.cos(lambda);
  const y1 = nu * Math.cos(phi) * Math.sin(lambda);
  const z1 = (1 - e2) * nu * Math.sin(phi);

  const sec = Math.PI / 180 / 3600;
  const rx = HELMERT.rx * sec;
  const ry = HELMERT.ry * sec;
  const rz = HELMERT.rz * sec;
  const s1 = HELMERT.s / 1e6 + 1;

  const x2 = HELMERT.tx + x1 * s1 - y1 * rz + z1 * ry;
  const y2 = HELMERT.ty + x1 * rz + y1 * s1 - z1 * rx;
  const z2 = HELMERT.tz - x1 * ry + y1 * rx + z1 * s1;

  // Cartesian back to geodetic, on Airy this time
  const { a: a2, b: b2 } = AIRY;
  const e2b = 1 - (b2 * b2) / (a2 * a2);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let phi2 = Math.atan2(z2, p * (1 - e2b));
  let nu2;
  for (let i = 0; i < 10; i++) {
    nu2 = a2 / Math.sqrt(1 - e2b * Math.sin(phi2) ** 2);
    const next = Math.atan2(z2 + e2b * nu2 * Math.sin(phi2), p);
    if (Math.abs(next - phi2) < 1e-12) { phi2 = next; break; }
    phi2 = next;
  }
  return { phi: phi2, lambda: Math.atan2(y2, x2) };
}

/** OSGB36 latitude/longitude to National Grid eastings and northings. */
function toEastingNorthing(phi, lambda) {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);

  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const nu = a * F0 * (1 - e2 * sinPhi ** 2) ** -0.5;
  const rho = a * F0 * (1 - e2) * (1 - e2 * sinPhi ** 2) ** -1.5;
  const eta2 = nu / rho - 1;

  const dPhi = phi - LAT0;
  const sPhi = phi + LAT0;
  const M =
    b * F0 *
    ((1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * dPhi -
      (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(dPhi) * Math.cos(sPhi) +
      ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) * Math.sin(2 * dPhi) * Math.cos(2 * sPhi) -
      (35 / 24) * n ** 3 * Math.sin(3 * dPhi) * Math.cos(3 * sPhi));

  const I = M + N0;
  const II = (nu / 2) * sinPhi * cosPhi;
  const III = (nu / 24) * sinPhi * cosPhi ** 3 * (5 - Math.tan(phi) ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sinPhi * cosPhi ** 5 * (61 - 58 * Math.tan(phi) ** 2 + Math.tan(phi) ** 4);
  const IV = nu * cosPhi;
  const V = (nu / 6) * cosPhi ** 3 * (nu / rho - Math.tan(phi) ** 2);
  const VI =
    (nu / 120) * cosPhi ** 5 *
    (5 - 18 * Math.tan(phi) ** 2 + Math.tan(phi) ** 4 + 14 * eta2 - 58 * Math.tan(phi) ** 2 * eta2);

  const dL = lambda - LON0;
  return {
    northing: I + II * dL ** 2 + III * dL ** 4 + IIIA * dL ** 6,
    easting: E0 + IV * dL + V * dL ** 3 + VI * dL ** 5,
  };
}

/** The lettered 100km square plus digits, e.g. "SK 2683 8531". */
export function toGridRef(lat, lon, digits = 8) {
  const { phi, lambda } = helmert(lat, lon);
  const { easting, northing } = toEastingNorthing(phi, lambda);

  const e100 = Math.floor(easting / 100000);
  const n100 = Math.floor(northing / 100000);
  if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return null; // outside GB

  // The National Grid letter scheme, relative to the false origin.
  let l1 = (19 - n100) - ((19 - n100) % 5) + Math.floor((e100 + 10) / 5);
  let l2 = ((19 - n100) * 5) % 25 + (e100 % 5);
  // 'I' is skipped in the sequence.
  if (l1 > 7) l1++;
  if (l2 > 7) l2++;
  const letters = String.fromCharCode(l1 + 65, l2 + 65);

  const per = digits / 2;
  const e = Math.floor((easting % 100000) / 10 ** (5 - per));
  const n = Math.floor((northing % 100000) / 10 ** (5 - per));

  return {
    ref: `${letters} ${String(e).padStart(per, "0")} ${String(n).padStart(per, "0")}`,
    letters,
    easting: Math.round(easting),
    northing: Math.round(northing),
  };
}
