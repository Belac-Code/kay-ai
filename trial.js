import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const trialFile = path.join(dataDir, "kay-trials.json");
const cookieName = "kay_trial";
const freeRequests = 5;
let secret;
let trials = {};
let writes = Promise.resolve();

export async function initTrials() {
  await mkdir(dataDir, { recursive: true });
  try { trials = JSON.parse(await readFile(trialFile, "utf8")); } catch { trials = {}; }
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(trials)) {
    if (!entry || Number(entry.updatedAt || 0) < cutoff || !Number.isFinite(Number(entry.used))) delete trials[id];
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) secret = Buffer.from(process.env.JWT_SECRET);
  else {
    const secretFile = path.join(dataDir, ".trial-signing-key");
    try { secret = await readFile(secretFile); }
    catch { secret = randomBytes(32); await writeFile(secretFile, secret, { mode: 0o600 }); }
  }
  await persist();
}

function signature(id) { return createHmac("sha256", secret).update(id).digest("base64url"); }
function readCookie(req) {
  const part = String(req.headers.cookie || "").split(";").map((value) => value.trim()).find((value) => value.startsWith(cookieName + "="));
  if (!part) return null;
  const [id, supplied] = part.slice(cookieName.length + 1).split(".");
  if (!id || !supplied) return null;
  const expectedBytes = Buffer.from(signature(id));
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return null;
  return id;
}
function setCookie(res, id) {
  const secure = process.env.COOKIE_SECURE === "true" || /^https:\/\//i.test(process.env.KAY_BASE_URL || "") ? "; Secure" : "";
  const existing = res.getHeader("Set-Cookie");
  const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  cookies.push(cookieName + "=" + id + "." + signature(id) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000" + secure);
  res.setHeader("Set-Cookie", cookies);
}
export function trialStatus(req, res, signedIn = false) {
  if (signedIn) return { signedIn: true, used: 0, remaining: 0, limit: freeRequests };
  let id = readCookie(req);
  if (!id) { id = randomUUID(); setCookie(res, id); }
  const used = Math.min(freeRequests, Number(trials[id]?.used || 0));
  return { signedIn: false, id, used, remaining: Math.max(0, freeRequests - used), limit: freeRequests };
}
export async function recordTrialRequest(id) {
  if (!id) return;
  const current = Number(trials[id]?.used || 0);
  trials[id] = { used: Math.min(freeRequests, current + 1), updatedAt: Date.now() };
  await persist();
}
function persist() {
  writes = writes.catch(() => {}).then(() => writeFile(trialFile, JSON.stringify(trials, null, 2), "utf8"));
  return writes;
}
