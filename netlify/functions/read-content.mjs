const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.WALK_BUILDER_PASSWORD;
const REPO           = 'Wardy-uk/walkingwithember';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url  = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) return json({ error: 'Missing path param' }, 400);
  if (!GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN not configured' }, 503);

  const ghRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'walkingwithember-admin',
    },
  });

  if (!ghRes.ok) {
    const err = await ghRes.text();
    return json({ error: `GitHub (${ghRes.status}): ${err}` }, ghRes.status);
  }

  const data = await ghRes.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');

  return json({ content, sha: data.sha, path: data.path }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export const config = { path: '/api/read-content' };
