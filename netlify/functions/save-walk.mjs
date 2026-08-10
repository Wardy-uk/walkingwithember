const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.WALK_BUILDER_PASSWORD;
const REPO           = 'Wardy-uk/walkingwithember';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN not configured' }, 503);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const {
    title, summary, heroImage, publishDate, walkDate,
    difficulty, distance, location, region, dogFriendly,
    parking, tags, osMapsLink, routeMapLat, routeMapLng, routeMapZoom,
    draft, notes,
  } = body;

  const errors = [];
  if (!title?.trim())  errors.push('title required');
  if (!heroImage)      errors.push('heroImage required');
  if (!location?.trim()) errors.push('location required');
  if (!distance)       errors.push('distance required');
  if (errors.length)   return json({ error: errors.join(', ') }, 400);

  const dateStr = (walkDate || publishDate || new Date().toISOString()).slice(0, 10);
  const slug    = slugify(title) + '-' + dateStr;
  const content = buildMarkdown({ title, summary, heroImage, publishDate, walkDate, difficulty, distance, location, region, dogFriendly, parking, tags, osMapsLink, routeMapLat, routeMapLng, routeMapZoom, draft, notes });

  const ghPath = `src/content/walks/${slug}.md`;
  const ghRes  = await fetch(`https://api.github.com/repos/${REPO}/contents/${ghPath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'walkingwithember-admin',
    },
    body: JSON.stringify({
      message: `Add walk: ${title}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: 'main',
    }),
  });

  if (!ghRes.ok) {
    const err = await ghRes.text();
    return json({ error: `GitHub API (${ghRes.status}): ${err}` }, 500);
  }

  return json({ slug, filename: `${slug}.md` }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function q(val) {
  return '"' + String(val ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildMarkdown({ title, summary, heroImage, publishDate, walkDate, difficulty, distance, location, region, dogFriendly, parking, tags = [], osMapsLink, routeMapLat, routeMapLng, routeMapZoom = 12, draft = true, notes = '' }) {
  const tagArr  = Array.isArray(tags) ? tags : String(tags).split(',').map(s => s.trim()).filter(Boolean);
  const tagYaml = tagArr.map(t => `  - ${q(t)}`).join('\n') || '  []';
  const today   = new Date().toISOString().slice(0, 10);

  const fm = [
    '---',
    `title: ${q(title)}`,
    `summary: ${q(summary || '')}`,
    `heroImage: ${q(heroImage)}`,
    `publishDate: ${publishDate || today}`,
    walkDate ? `walkDate: ${walkDate}` : null,
    `difficulty: ${difficulty || 'Moderate'}`,
    `distance: ${parseFloat(distance).toFixed(2)}`,
    `location: ${q(location)}`,
    `region: ${q(region || '')}`,
    `dogFriendly: ${Boolean(dogFriendly)}`,
    `parking: ${q(parking || '')}`,
    `tags:\n${tagYaml}`,
    osMapsLink ? `osMapsLink: ${q(osMapsLink)}` : null,
    `routeMapLat: ${parseFloat(routeMapLat || 0).toFixed(6)}`,
    `routeMapLng: ${parseFloat(routeMapLng || 0).toFixed(6)}`,
    `routeMapZoom: ${parseInt(routeMapZoom) || 12}`,
    `draft: ${Boolean(draft)}`,
    '---',
  ].filter(l => l !== null).join('\n');

  return fm + (notes?.trim() ? '\n\n' + notes.trim() : '') + '\n';
}

export const config = { path: '/api/save-walk' };
