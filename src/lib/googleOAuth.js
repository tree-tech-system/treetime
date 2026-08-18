// Thin wrapper around Google's OAuth2 endpoints for connecting a Gmail /
// Google Workspace mailbox as a TreeTime sender (owner panel -> מייל ->
// "התחבר עם Google"). Plain fetch() calls to Google's REST endpoints --
// deliberately no googleapis SDK dependency, this is the entire surface we need.
const APP_URL = process.env.APP_URL || 'https://treetime.tree-tech-system.com';
const REDIRECT_URI = `${APP_URL}/api/owner/email/google/callback`;

// Full mail scope is required for SMTP XOAUTH2 against smtp.gmail.com (the
// narrower gmail.send scope only works against the Gmail REST API, which
// mailer.js doesn't use -- see the migration 030 comment). openid+email let
// us look up which address was just connected right after the exchange.
const SCOPES = ['openid', 'email', 'https://mail.google.com/'].join(' ');

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    // Forces the consent screen every time so Google always hands back a
    // refresh_token (it only does that on a mailbox's very first consent
    // otherwise), even when an owner is reconnecting/rotating an account.
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
  return data; // { access_token, refresh_token, id_token, expires_in, ... }
}

async function getUserInfo(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google userinfo lookup failed');
  return data; // { email, name, ... }
}

// Best-effort only -- called when disconnecting an account. A failed revoke
// just means the token dies naturally later; it must never block the delete.
async function revokeToken(token) {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch (err) {
    console.error('[googleOAuth] revoke failed:', err.message);
  }
}

module.exports = { buildAuthUrl, exchangeCodeForTokens, getUserInfo, revokeToken, REDIRECT_URI };
