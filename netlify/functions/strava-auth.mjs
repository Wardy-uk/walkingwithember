import { getStore } from '@netlify/blobs';

const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI  = 'https://walkingwithember.co.uk/api/strava-auth';
const SCOPE         = 'activity:read_all';

export const config = { path: '/api/strava-auth' };

export default async function handler(req) {
  const url   = new URL(req.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  // Step 2: Strava redirected back with a code
  if (code) {
    try {
      const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return html(500, `<h1>Token exchange failed</h1><pre>${text}</pre>`);
      }

      const data = await res.json();
      const store = getStore('strava-tokens');
      await store.set('refresh_token', data.refresh_token);

      return html(200, `
        <h1>✅ Strava authorised!</h1>
        <p>Authorised as: <strong>${data.athlete?.firstname} ${data.athlete?.lastname}</strong></p>
        <p>Scope: <strong>${data.scope}</strong></p>
        <p>Refresh token stored. You can close this tab.</p>
      `);
    } catch (err) {
      return html(500, `<h1>Error</h1><pre>${err.message}</pre>`);
    }
  }

  // Strava denied access
  if (error) {
    return html(400, `<h1>Access denied</h1><p>${error}</p>`);
  }

  // Step 1: Redirect to Strava auth
  const authUrl = new URL('https://www.strava.com/oauth/authorize');
  authUrl.searchParams.set('client_id',       CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',    REDIRECT_URI);
  authUrl.searchParams.set('response_type',   'code');
  authUrl.searchParams.set('approval_prompt', 'force');
  authUrl.searchParams.set('scope',           SCOPE);

  return Response.redirect(authUrl.toString(), 302);
}

function html(status, body) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Strava Auth</title>
    <style>body{font-family:sans-serif;max-width:600px;margin:80px auto;padding:0 20px}</style>
    </head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html' } }
  );
}
