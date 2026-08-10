/**
 * One-time Google Photos OAuth helper.
 * Run: node scripts/google-auth.mjs <clientId> <clientSecret>
 * Opens a browser, you approve, then it prints the new refresh token.
 */

import http from 'http';
import { exec } from 'child_process';

const [,, clientId, clientSecret] = process.argv;
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/google-auth.mjs <clientId> <clientSecret>');
  console.error('\nGet these values from Netlify → Site configuration → Environment variables');
  console.error('  GOOGLE_PHOTOS_CLIENT_ID');
  console.error('  GOOGLE_PHOTOS_CLIENT_SECRET');
  process.exit(1);
}

const PORT     = 3086;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE    = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId.trim());
authUrl.searchParams.set('redirect_uri', REDIRECT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // forces new refresh token

console.log('\n── Google Photos One-Time Auth ───────────────────');
console.log('Opening Google auth in your browser…\n');
exec(`open "${authUrl.toString()}"`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url   = new URL(req.url, `http://localhost:${PORT}`);
    const code  = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.end('Auth denied. You can close this tab.');
      server.close();
      reject(new Error(`Google denied access: ${error}`));
      return;
    }
    if (code) {
      res.end('Authorised! You can close this tab and return to the terminal.');
      server.close();
      resolve(code);
    }
  });
  server.listen(PORT, () => {
    console.log(`Waiting for Google callback on port ${PORT}…`);
  });
});

console.log('\nExchanging code for tokens…');
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id:     clientId.trim(),
    client_secret: clientSecret.trim(),
    code,
    redirect_uri:  REDIRECT,
    grant_type:    'authorization_code',
  }).toString(),
});

if (!res.ok) {
  console.error('Token exchange failed:', res.status, await res.text());
  process.exit(1);
}

const data = await res.json();

if (!data.refresh_token) {
  console.error('\nNo refresh token returned. This can happen if the app already has permission.');
  console.error('Try revoking access at https://myaccount.google.com/permissions then run this script again.');
  process.exit(1);
}

console.log('\n── New token — update in Netlify ─────────────────');
console.log(`GOOGLE_PHOTOS_REFRESH_TOKEN = ${data.refresh_token}`);
console.log('\nRun this to update Netlify:');
console.log(`  source ~/.nvm/nvm.sh && nvm use 20 && npx netlify-cli env:set GOOGLE_PHOTOS_REFRESH_TOKEN "${data.refresh_token}"`);
console.log('\nThen re-deploy:');
console.log('  npx netlify-cli deploy --prod --no-build --dir=dist');
