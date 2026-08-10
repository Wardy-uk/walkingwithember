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

  const { password, path, content, message, sha } = body;

  if (password !== ADMIN_PASSWORD) return json({ error: 'Invalid password' }, 403);
  if (!path)    return json({ error: 'Missing path' }, 400);
  if (!content) return json({ error: 'Missing content' }, 400);

  const payload = {
    message: message || `Update ${path}`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (sha) payload.sha = sha;

  const ghRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'walkingwithember-admin',
    },
    body: JSON.stringify(payload),
  });

  if (!ghRes.ok) {
    const err = await ghRes.text();
    return json({ error: `GitHub (${ghRes.status}): ${err}` }, 500);
  }

  return json({ ok: true, path }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export const config = { path: '/api/save-content' };
