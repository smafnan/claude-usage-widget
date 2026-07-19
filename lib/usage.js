// Reads Claude Code's OAuth credentials, refreshes the token when expired,
// and fetches usage limits from Anthropic's OAuth usage endpoint.
//
// Credential storage:
//   - Windows/Linux: ~/.claude/.credentials.json
//   - macOS: Keychain item "Claude Code-credentials" (falls back to the file)
// Override with CLAUDE_CREDENTIALS_PATH to force a specific file.

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code's public OAuth client
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const CREDS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH ||
  path.join(os.homedir(), ".claude", ".credentials.json");

const isMac = process.platform === "darwin" && !process.env.CLAUDE_CREDENTIALS_PATH;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// --- credential storage -----------------------------------------------------

function keychainAccount() {
  // The write-back must target the same account the item was created with,
  // otherwise -U creates a duplicate entry and Claude Code may read the stale one.
  try {
    const meta = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], {
      encoding: "utf8",
    });
    const m = meta.match(/"acct"<blob>="([^"]*)"/);
    if (m) return m[1];
  } catch {}
  return os.userInfo().username;
}

function loadCreds() {
  if (isMac) {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8" }
      ).trim();
      return { store: "keychain", json: JSON.parse(raw) };
    } catch {
      // fall through to the file — some macOS installs use it
    }
  }
  try {
    return { store: "file", json: JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) };
  } catch {
    throw err(
      "NO_CREDENTIALS",
      "No Claude sign-in found. Use the button below to sign in."
    );
  }
}

function saveCreds(creds) {
  if (creds.store === "keychain") {
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(),
      "-w",
      JSON.stringify(creds.json),
    ]);
    return;
  }
  // Atomic write so a crash never corrupts Claude Code's credentials file
  fs.mkdirSync(path.dirname(CREDS_PATH), { recursive: true });
  const tmp = CREDS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(creds.json));
  fs.renameSync(tmp, CREDS_PATH);
}

// For fresh sign-ins: reuse the existing store if there is one, otherwise
// start a new credentials file in Claude Code's location/format.
function loadCredsOrEmpty() {
  try {
    return loadCreds();
  } catch {
    return { store: "file", json: {} };
  }
}

// --- OAuth ------------------------------------------------------------------

async function refreshToken(creds) {
  const oauth = creds.json.claudeAiOauth;
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw err(
      "REFRESH_FAILED",
      `Session expired (HTTP ${res.status}). Sign in again below.`
    );
  }
  const data = await res.json();
  oauth.accessToken = data.access_token;
  if (data.refresh_token) oauth.refreshToken = data.refresh_token;
  oauth.expiresAt = Date.now() + data.expires_in * 1000;
  // Write back so Claude Code keeps working with the rotated refresh token
  saveCreds(creds);
  return oauth;
}

function fetchWithTimeout(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// --- usage ------------------------------------------------------------------

async function queryUsage(accessToken) {
  return fetchWithTimeout(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
}

async function fetchUsage() {
  // Re-read every poll: Claude Code may have rotated the token in the meantime
  const creds = loadCreds();
  let oauth = creds.json.claudeAiOauth;
  if (!oauth || !oauth.refreshToken) {
    throw err("NO_CREDENTIALS", "No Claude sign-in found. Use the button below to sign in.");
  }

  if (!oauth.accessToken || Date.now() > (oauth.expiresAt || 0) - 60_000) {
    oauth = await refreshToken(creds);
  }

  let res = await queryUsage(oauth.accessToken);
  if (res.status === 401) {
    // expiresAt lied, or the token was revoked — refresh once and retry
    oauth = await refreshToken(creds);
    res = await queryUsage(oauth.accessToken);
  }
  if (!res.ok) {
    throw err(`HTTP_${res.status}`, `Usage request failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return { data, plan: oauth.subscriptionType || null };
}

module.exports = { fetchUsage, loadCreds, loadCredsOrEmpty, saveCreds, CLIENT_ID };
