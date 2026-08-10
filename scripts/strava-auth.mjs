/**
 * One-time Strava OAuth helper.
 * Run: node scripts/strava-auth.mjs
 * Then follow the prompts to get your refresh token.
 */

import http from 'http';
import { exec } from 'child_process';

// Usage: node strava-auth.mjs <clientId> <clientSecret>
const [,, clientId, clientSecret] = process.argv;
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/strava-auth.mjs <clientId> <clientSecret>');
  process.exit(1);
}

console.log('\n── Strava One-Time Auth ──────────────────────────');

const PORT        = 3085;
const REDIRECT    = `http://localhost:${PORT}/callback`;
const authUrl     = `https://www.strava.com/oauth/authorize?client_id=${clientId.trim()}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&approval_prompt=auto&scope=activity:read_all`;

console.log('\nOpening Strava auth in your browser…');
exec(`open "${authUrl}"`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url    = new URL(req.url, `http://localhost:${PORT}`);
    const code   = url.searchParams.get('code');
    const error  = url.searchParams.get('error');

    if (error) {
      res.end('Auth denied. You can close this tab.');
      server.close();
      reject(new Error(`Strava denied access: ${error}`));
      return;
    }
    if (code) {
      res.end('Authorised! You can close this tab and return to the terminal.');
      server.close();
      resolve(code);
    }
  });
  server.listen(PORT, () => {
    console.log(`Waiting for Strava callback on port ${PORT}…`);
  });
});

console.log('\nExchanging code for tokens…');
const res  = await fetch('https://www.strava.com/oauth/token', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_id:     clientId.trim(),
    client_secret: clientSecret.trim(),
    code,
    grant_type: 'authorization_code',
  }),
});

if (!res.ok) {
  console.error('Token exchange failed:', res.status, await res.text());
  process.exit(1);
}

const data = await res.json();

console.log('\n── Copy these into Netlify env vars ──────────────');
console.log(`STRAVA_CLIENT_ID     = ${clientId.trim()}`);
console.log(`STRAVA_CLIENT_SECRET = ${clientSecret.trim()}`);
console.log(`STRAVA_REFRESH_TOKEN = ${data.refresh_token}`);
console.log('\nAuthorised as:', data.athlete?.firstname, data.athlete?.lastname);
console.log('Access token expires:', new Date(data.expires_at * 1000).toLocaleString());
console.log('\nRun from walkingwithember/:');
console.log(`  netlify env:set STRAVA_CLIENT_ID     "${clientId.trim()}"`);
console.log(`  netlify env:set STRAVA_CLIENT_SECRET "${clientSecret.trim()}"`);
console.log(`  netlify env:set STRAVA_REFRESH_TOKEN "${data.refresh_token}"`);
