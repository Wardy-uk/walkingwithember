const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;
const API_KEY    = process.env.INTERVALS_API_KEY;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const WALK_TYPES = ['Walk', 'Hike', 'Run', 'TrailRun', 'Snowshoe', 'Hiking'];

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!ATHLETE_ID || !API_KEY) {
    return new Response(JSON.stringify({ error: 'Intervals.icu not configured' }), { status: 503, headers: CORS });
  }

  const url  = new URL(req.url);
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid date param' }), { status: 400, headers: CORS });
  }

  try {
    const auth = Buffer.from(`API_KEY:${API_KEY}`).toString('base64');

    // Fetch activities for the given day (use day +1 as exclusive upper bound)
    const [year, month, day] = date.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const nextDate = next.toISOString().slice(0, 10);

    const res = await fetch(
      `https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/activities?oldest=${date}&newest=${nextDate}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    if (!res.ok) throw new Error(`Intervals.icu API error: ${res.status}`);
    const activities = await res.json();

    const walking = activities.filter(a => WALK_TYPES.includes(a.type));

    if (!walking.length) {
      return new Response(JSON.stringify({ activity: null }), { headers: CORS });
    }

    const a = walking[0];
    const movingMin = a.moving_time ? Math.round(a.moving_time / 60) : null;

    return new Response(JSON.stringify({
      activity: {
        name:            a.name,
        type:            a.type,
        distance_miles:  a.distance ? (a.distance / 1609.34).toFixed(1) : null,
        distance_km:     a.distance ? (a.distance / 1000).toFixed(1) : null,
        moving_time_min: movingMin,
        elevation_ft:    a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.281) : null,
        elevation_m:     a.total_elevation_gain ? Math.round(a.total_elevation_gain) : null,
        avg_hr:          a.average_heartrate ? Math.round(a.average_heartrate) : null,
        max_hr:          a.max_heartrate     ? Math.round(a.max_heartrate)     : null,
        calories:        a.calories || null,
        strava_url:      null,
      },
    }), { headers: CORS });

  } catch (err) {
    console.error('[intervals fn]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export const config = { path: '/api/strava' };
