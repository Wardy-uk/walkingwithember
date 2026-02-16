export type CameraPresetId = "cinematic" | "balanced" | "chase";

export type CameraPreset = {
  id: CameraPresetId;
  label: string;
  lookaheadMeters: number;
  chaseMeters: number;
  pitch: number;
  zoomBase: number;
  zoomMin: number;
  zoomMax: number;
  bearingSmoothing: number;
};

export type FlybyPoint = {
  lat: number;
  lon: number;
  distanceFromStartM: number;
  ele?: number | null;
  time?: string | null;
};

export const cameraPresets: CameraPreset[] = [
  {
    id: "cinematic",
    label: "Cinematic",
    lookaheadMeters: 320,
    chaseMeters: 135,
    pitch: 72,
    zoomBase: 13.6,
    zoomMin: 11.5,
    zoomMax: 14.2,
    bearingSmoothing: 0.14,
  },
  {
    id: "balanced",
    label: "Balanced",
    lookaheadMeters: 250,
    chaseMeters: 105,
    pitch: 68,
    zoomBase: 13.8,
    zoomMin: 11.6,
    zoomMax: 14.3,
    bearingSmoothing: 0.16,
  },
  {
    id: "chase",
    label: "Chase",
    lookaheadMeters: 180,
    chaseMeters: 80,
    pitch: 62,
    zoomBase: 14.1,
    zoomMin: 11.8,
    zoomMax: 14.5,
    bearingSmoothing: 0.2,
  },
];

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const toRad = (deg: number) => (deg * Math.PI) / 180;
export const toDeg = (rad: number) => (rad * 180) / Math.PI;

export const bearingDeg = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const lambda1 = toRad(lon1);
  const lambda2 = toRad(lon2);
  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

export const shortestAngleDiff = (from: number, to: number) => ((to - from + 540) % 360) - 180;

export const haversineMeters = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const interpolatePointAtDistance = <T extends FlybyPoint>(
  points: T[],
  targetDistanceM: number,
): { lat: number; lon: number; index: number } => {
  if (points.length === 0) return { lat: 0, lon: 0, index: 0 };
  if (points.length === 1) return { lat: points[0].lat, lon: points[0].lon, index: 0 };

  const maxDistance = points[points.length - 1].distanceFromStartM;
  const target = clamp(targetDistanceM, 0, Math.max(maxDistance, 0));

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].distanceFromStartM < target) low = mid + 1;
    else high = mid;
  }

  const rightIndex = clamp(low, 1, points.length - 1);
  const leftIndex = rightIndex - 1;
  const left = points[leftIndex];
  const right = points[rightIndex];
  const span = Math.max(right.distanceFromStartM - left.distanceFromStartM, 0.0001);
  const t = clamp((target - left.distanceFromStartM) / span, 0, 1);

  return {
    lat: lerp(left.lat, right.lat, t),
    lon: lerp(left.lon, right.lon, t),
    index: leftIndex,
  };
};

export const buildPlaybackPoints = <T extends FlybyPoint>(points: T[], maxPoints = 1800): T[] => {
  if (points.length <= 2 || points.length <= maxPoints) return points;
  const totalDistance = Math.max(points[points.length - 1].distanceFromStartM, 1);
  const interval = totalDistance / (maxPoints - 1);
  const sampled: T[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const targetDistance = Math.min(totalDistance, i * interval);
    const interp = interpolatePointAtDistance(points, targetDistance);
    const nearest = points[interp.index] ?? points[0];
    sampled.push({
      ...nearest,
      lat: interp.lat,
      lon: interp.lon,
      distanceFromStartM: targetDistance,
    });
  }
  return sampled;
};

export const smoothPlaybackPoints = <T extends FlybyPoint>(points: T[], radius = 2): T[] => {
  if (points.length <= 4 || radius <= 0) return points;
  return points.map((point, i) => {
    if (i === 0 || i === points.length - 1) return point;
    let latSum = 0;
    let lonSum = 0;
    let wSum = 0;
    for (let j = -radius; j <= radius; j += 1) {
      const idx = clamp(i + j, 0, points.length - 1);
      const weight = radius + 1 - Math.abs(j);
      latSum += points[idx].lat * weight;
      lonSum += points[idx].lon * weight;
      wSum += weight;
    }
    return {
      ...point,
      lat: latSum / wSum,
      lon: lonSum / wSum,
    };
  });
};
