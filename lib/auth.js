// In-widget Claude sign-in using the same OAuth authorization-code + PKCE flow
// Claude Code uses. The user signs in at claude.ai in their own browser, copies
// the code shown on the callback page, and pastes it back into the widget.

const crypto = require("crypto");
const { loadCredsOrEmpty, saveCreds, CLIENT_ID } = require("./usage");

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

let pending = null; // { verifier, state } for the in-flight sign-in

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns the URL the user must open in a browser. PKCE state is kept in-process.
function beginLogin() {
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  pending = { verifier, state };
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

// `pasted` is the "code#state" string shown on the claude.ai callback page.
async function completeLogin(pasted) {
  if (!pending) throw new Error("Click 'Sign in with Claude' first.");
  const trimmed = String(pasted || "").trim();
  if (!trimmed) throw new Error("Paste the code shown after signing in.");
  const [code, state] = trimmed.split("#");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: state || pending.state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error_description || body.error || "";
    } catch {}
    throw new Error(`Sign-in failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}. Try again.`);
  }
  const data = await res.json();

  const creds = loadCredsOrEmpty();
  creds.json.claudeAiOauth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: typeof data.scope === "string" ? data.scope.split(" ") : [],
    subscriptionType:
      (data.account && (data.account.subscription_type || data.account.subscriptionType)) || null,
  };
  saveCreds(creds);
  pending = null;
}

module.exports = { beginLogin, completeLogin };
