import { createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";

const providers = ["google", "apple", "github"];
let appleKeysCache = { expires: 0, keys: [] };

function baseUrl() {
  const value = String(process.env.KAY_BASE_URL || "").replace(/\/$/, "");
  if (!value) throw httpError(503, "Set KAY_BASE_URL to the exact public KAY URL before enabling social sign-in.");
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw httpError(503, "KAY_BASE_URL must use HTTPS, except for local development.");
  }
  return parsed;
}
function redirectUri(provider) { return new URL("/api/auth/oauth/" + provider + "/callback", baseUrl()).href; }
function providerReady(provider) {
  let appUrl;
  try { appUrl = baseUrl(); } catch { return false; }
  if (provider === "google") return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (provider === "github") return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  if (provider === "apple") {
    return Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY && appUrl.protocol === "https:");
  }
  return false;
}
export function oauthProviders() {
  return providers.map((id) => ({ id, label: id === "github" ? "GitHub" : id[0].toUpperCase() + id.slice(1), enabled: providerReady(id) }));
}
function secret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw httpError(503, "Set JWT_SECRET to a random value with at least 32 characters, then restart KAY.");
  return process.env.JWT_SECRET;
}
function cookieValue(req, name) {
  const part = String(req.headers.cookie || "").split(";").map((value) => value.trim()).find((value) => value.startsWith(name + "="));
  try { return part ? decodeURIComponent(part.slice(name.length + 1)) : ""; } catch { return ""; }
}
function stateCookie(value, provider) {
  const secure = baseUrl().protocol === "https:" ? "; Secure" : "";
  const sameSite = provider === "apple" ? "None" : "Lax";
  return "kay_oauth_state=" + encodeURIComponent(value) + "; HttpOnly; SameSite=" + sameSite + "; Path=/api/auth/oauth; Max-Age=600" + secure;
}
export function beginOAuth(provider, res) {
  if (!providers.includes(provider)) throw httpError(404, "Sign-in provider not found.");
  if (!providerReady(provider)) throw httpError(503, provider[0].toUpperCase() + provider.slice(1) + " sign-in is not configured yet.");
  const state = jwt.sign({ provider }, secret(), { expiresIn: "10m", issuer: "kay-oauth", audience: "kay-web" });
  res.setHeader("Set-Cookie", stateCookie(state, provider));
  const url = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : provider === "github" ? "https://github.com/login/oauth/authorize" : "https://appleid.apple.com/auth/authorize");
  url.searchParams.set("client_id", provider === "google" ? process.env.GOOGLE_CLIENT_ID : provider === "github" ? process.env.GITHUB_CLIENT_ID : process.env.APPLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider === "google") url.searchParams.set("scope", "openid email profile");
  if (provider === "github") url.searchParams.set("scope", "read:user user:email");
  if (provider === "apple") { url.searchParams.set("response_mode", "form_post"); url.searchParams.set("scope", "name email"); }
  return url.href;
}
function checkState(provider, req, res) {
  const fromCookie = cookieValue(req, "kay_oauth_state");
  res.setHeader("Set-Cookie", stateCookie("", provider).replace("Max-Age=600", "Max-Age=0"));
  const fromRequest = String(req.body?.state || req.query?.state || "");
  if (!fromCookie || !fromRequest || fromCookie !== fromRequest) throw httpError(400, "Social sign-in expired or failed its security check. Start sign-in again.");
  try {
    const claims = jwt.verify(fromRequest, secret(), { issuer: "kay-oauth", audience: "kay-web" });
    if (claims.provider !== provider) throw new Error("wrong provider");
  } catch { throw httpError(400, "Social sign-in expired or failed its security check. Start sign-in again."); }
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) throw httpError(502, "The identity provider could not complete sign-in. Check its OAuth app settings and callback URL.");
  return data;
}
function formBody(values) { return new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])); }
async function googleIdentity(code) {
  const tokens = await fetchJson("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formBody({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri("google"), grant_type: "authorization_code" }) });
  const user = await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokens.access_token } });
  return { provider: "google", subject: user.sub, email: user.email, emailVerified: user.email_verified === true || user.email_verified === "true", name: user.name };
}
async function githubIdentity(code) {
  const token = await fetchJson("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json" }, body: formBody({ code, client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, redirect_uri: redirectUri("github") }) });
  if (!token.access_token) throw httpError(502, "GitHub did not return an access token. Check the OAuth app settings.");
  const headers = { Authorization: "Bearer " + token.access_token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "KAY-AI" };
  const [user, emails] = await Promise.all([
    fetchJson("https://api.github.com/user", { headers }),
    fetchJson("https://api.github.com/user/emails", { headers }),
  ]);
  const email = emails.find((entry) => entry.primary && entry.verified)?.email;
  return { provider: "github", subject: String(user.id), email, emailVerified: Boolean(email), name: user.name || user.login };
}
async function appleKeys() {
  if (appleKeysCache.expires > Date.now()) return appleKeysCache.keys;
  const response = await fetchJson("https://appleid.apple.com/auth/keys");
  appleKeysCache = { keys: response.keys || [], expires: Date.now() + 60 * 60 * 1000 };
  return appleKeysCache.keys;
}
function appleClientSecret() {
  const key = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  return jwt.sign({}, key, { algorithm: "ES256", issuer: process.env.APPLE_TEAM_ID, subject: process.env.APPLE_CLIENT_ID, audience: "https://appleid.apple.com", keyid: process.env.APPLE_KEY_ID, expiresIn: "5m" });
}
async function appleIdentity(code, userPayload) {
  const token = await fetchJson("https://appleid.apple.com/auth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formBody({ code, client_id: process.env.APPLE_CLIENT_ID, client_secret: appleClientSecret(), redirect_uri: redirectUri("apple"), grant_type: "authorization_code" }) });
  const decoded = jwt.decode(token.id_token, { complete: true });
  const jwk = (await appleKeys()).find((key) => key.kid === decoded?.header?.kid);
  if (!jwk) throw httpError(502, "Apple returned an unrecognized identity token.");
  const claims = jwt.verify(token.id_token, createPublicKey({ key: jwk, format: "jwk" }), { algorithms: ["RS256"], audience: process.env.APPLE_CLIENT_ID, issuer: "https://appleid.apple.com" });
  let firstName = "";
  let lastName = "";
  try { const user = typeof userPayload === "string" ? JSON.parse(userPayload) : userPayload; firstName = user?.name?.firstName || ""; lastName = user?.name?.lastName || ""; } catch {}
  return { provider: "apple", subject: claims.sub, email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === "true", name: [firstName, lastName].filter(Boolean).join(" ") || "KAY User" };
}
export async function completeOAuth(provider, req, res) {
  if (!providers.includes(provider)) throw httpError(404, "Sign-in provider not found.");
  checkState(provider, req, res);
  if (req.body?.error || req.query?.error) throw httpError(400, "You cancelled or declined social sign-in.");
  const code = String(req.body?.code || req.query?.code || "");
  if (!code) throw httpError(400, "The identity provider did not return a sign-in code.");
  if (!providerReady(provider)) throw httpError(503, "This sign-in provider is not configured on KAY.");
  if (provider === "apple") return appleIdentity(code, req.body?.user);
  return provider === "google" ? googleIdentity(code) : githubIdentity(code);
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
