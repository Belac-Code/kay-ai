import express from "express";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { upload, saveUpload, getUpload, uploadDir } from "./src/uploads.js";
import { chatWithProvider, configuredProviders, generateImage, transcribeAudio } from "./src/providers.js";
import { initMemory, listMemory, addMemory, editMemory, deleteMemory, profilePrompt } from "./src/memory.js";
import { createPdf, createDocx } from "./src/exports.js";
import { initAccounts, accountsReady, registerAccount, loginAccount, oauthLoginOrCreate, readAccountCookie, setSessionCookie, clearSessionCookie, accountForId, listConversations, readConversation, saveConversation, removeConversation, listAccountMemory, addAccountMemory, editAccountMemory, deleteAccountMemory, accountProfilePrompt, creatorAuthorized, creatorDashboard, submitCreatorFeedback } from "./src/accounts.js";
import { beginOAuth, completeOAuth, oauthProviders } from "./src/oauth.js";
import { initTrials, trialStatus, recordTrialRequest } from "./src/trial.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
loadEnv();
const app = express();
const port = Number(process.env.PORT || 4173);
const authFailureBuckets = new Map();

function loadEnv() {
  try {
    const raw = readFileSync(path.join(here, ".env"), "utf8").replace(/^\uFEFF/, "");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const [, key] = match;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      // For local KAY runs, .env is the source of truth. In production, the
      // process environment remains authoritative when a variable is set.
      if (process.env.NODE_ENV !== "production" || !Object.hasOwn(process.env, key)) process.env[key] = value;
    }
  } catch {}
}
import { readFileSync } from "node:fs";

await initMemory();
await initAccounts();
await initTrials();
app.disable("x-powered-by");
app.use(express.json({ limit: "24mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/trial", (req, res) => {
  const session = accountsReady() ? readAccountCookie(req) : null;
  res.setHeader("Cache-Control", "no-store");
  const { id: _trialId, ...status } = trialStatus(req, res, Boolean(session));
  res.json(status);
});
app.get("/api/config", async (_req, res) => {
  const memory = await listMemory();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    name: "KAY",
    providers: configuredProviders(),
    ready: configuredProviders().length > 0,
    memoryMode: memory.mode,
    authEnabled: accountsReady(),
    authProviders: oauthProviders().map((provider) => ({ ...provider, enabled: accountsReady() && provider.enabled })),
    features: { uploads: true, camera: true, voice: true, exports: true, imageStudio: true },
  });
});
app.get("/api/auth/me", async (req, res) => {
  const session = readAccountCookie(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: accountsReady(), user: session ? await accountForId(session.id) : null, creator: session ? await creatorAuthorized(session.id) : false });
});
function authBucketKey(req) { return (req.ip || "local") + ":" + String(req.body?.email || "").trim().toLowerCase(); }
function checkAuthAttempt(req, res) {
  const bucket = authFailureBuckets.get(authBucketKey(req));
  if (bucket && bucket.until > Date.now() && bucket.count >= 10) { res.status(429).json({ error: "Too many sign-in attempts. Wait 15 minutes and try again." }); return false; }
  return true;
}
function recordAuthFailure(req) {
  const key = authBucketKey(req); const current = authFailureBuckets.get(key);
  const bucket = current && current.until > Date.now() ? current : { count: 0, until: Date.now() + 15 * 60 * 1000 };
  bucket.count++; authFailureBuckets.set(key, bucket);
  if (authFailureBuckets.size > 1000) for (const [entry, value] of authFailureBuckets) if (value.until < Date.now()) authFailureBuckets.delete(entry);
}
function clearAuthFailure(req) { authFailureBuckets.delete(authBucketKey(req)); }
app.post("/api/auth/signup", async (req, res, next) => {
  if (!checkAuthAttempt(req, res)) return;
  try {
    const result = await registerAccount(req.body || {});
    clearAuthFailure(req);
    setSessionCookie(res, result.cookie);
    res.status(201).json({ user: result.user });
  } catch (error) { recordAuthFailure(req); next(error); }
});
app.post("/api/auth/login", async (req, res, next) => {
  if (!checkAuthAttempt(req, res)) return;
  try {
    const result = await loginAccount(req.body || {});
    clearAuthFailure(req);
    setSessionCookie(res, result.cookie);
    res.json({ user: result.user });
  } catch (error) { recordAuthFailure(req); next(error); }
});
app.post("/api/auth/logout", (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.post("/api/feedback", requireAccount, async (req, res, next) => {
  try { const feedback = await submitCreatorFeedback(req.account.id, req.body || {}); res.status(201).json({ feedback: { id: String(feedback._id), createdAt: feedback.createdAt } }); }
  catch (error) { next(error); }
});
app.get("/api/creator/dashboard", requireAccount, async (req, res, next) => {
  try { res.setHeader("Cache-Control", "private, no-store"); res.json(await creatorDashboard(req.account.id)); } catch (error) { next(error); }
});
app.get("/api/auth/oauth/:provider", (req, res, next) => {
  try { res.redirect(302, beginOAuth(String(req.params.provider).toLowerCase(), res)); } catch (error) { next(error); }
});
async function finishOAuth(req, res) {
  try {
    const provider = String(req.params.provider).toLowerCase();
    const identity = await completeOAuth(provider, req, res);
    const result = await oauthLoginOrCreate(identity);
    setSessionCookie(res, result.cookie);
    res.redirect(303, "/");
  } catch (error) {
    res.redirect(303, "/?authError=" + encodeURIComponent(error.message || "Social sign-in failed."));
  }
}
app.get("/api/auth/oauth/:provider/callback", finishOAuth);
app.post("/api/auth/oauth/:provider/callback", finishOAuth);
function requireAccount(req, res, next) {
  if (!accountsReady()) return res.status(503).json({ error: "Sign-in needs a working MongoDB connection." });
  const account = readAccountCookie(req);
  if (!account) return res.status(401).json({ error: "Sign in to use your saved conversations." });
  req.account = account;
  next();
}
app.get("/api/conversations", requireAccount, async (req, res, next) => {
  try { res.json({ conversations: await listConversations(req.account.id) }); } catch (error) { next(error); }
});
app.post("/api/conversations", requireAccount, async (req, res, next) => {
  try { const conversation = await saveConversation(req.account.id, req.body || {}); res.status(201).json({ conversation }); } catch (error) { next(error); }
});
app.get("/api/conversations/:id", requireAccount, async (req, res, next) => {
  try {
    const conversation = await readConversation(req.account.id, req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });
    res.json({ conversation });
  } catch (error) { next(error); }
});
app.put("/api/conversations/:id", requireAccount, async (req, res, next) => {
  try {
    const conversation = await saveConversation(req.account.id, { ...(req.body || {}), id: req.params.id });
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });
    res.json({ conversation });
  } catch (error) { next(error); }
});
app.delete("/api/conversations/:id", requireAccount, async (req, res, next) => {
  try { if (!await removeConversation(req.account.id, req.params.id)) return res.status(404).json({ error: "Conversation not found." }); res.json({ ok: true }); }
  catch (error) { next(error); }
});
app.post("/api/chat", async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    const trial = account ? null : trialStatus(req, res);
    if (trial && trial.remaining <= 0) throw httpError(402, "Your 5 free KAY requests are used. Sign in to continue chatting.");
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const provider = String(req.body.provider || "");
    const messages = cleanMessages(req.body.messages);
    const ids = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 4) : [];
    const attachments = (await Promise.all(ids.map((id) => getUpload(id)))).filter(Boolean);
    if (ids.length !== attachments.length) throw httpError(400, "One or more attachments expired. Attach the files again.");
    const memory = account ? await listAccountMemory(account.id) : await listMemory();
    await chatWithProvider({
      id: provider, messages, attachments, web: wantsWebSearch(messages.at(-1)?.content || ""),
      profile: account ? accountProfilePrompt(memory.profile) : profilePrompt(memory.profile), res, signal: controller.signal,
      onAccepted: trial ? () => recordTrialRequest(trial.id) : undefined,
    });
  } catch (error) { next(error); }
});

app.post("/api/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, "Choose a file to attach.");
    const saved = await saveUpload(req.file);
    const { text: _extractedText, ...publicFile } = saved;
    res.status(201).json(publicFile);
  } catch (error) { next(error); }
});
app.get("/api/uploads/:id", async (req, res, next) => {
  try {
    const file = await getUpload(req.params.id);
    if (!file || !file.isImage) return res.status(404).json({ error: "Image not found." });
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(file.buffer);
  } catch (error) { next(error); }
});

app.post("/api/export/pdf", async (req, res, next) => {
  try {
    const { text, title } = exportInput(req.body);
    const buffer = await createPdf(text, title);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeFilename(title) + '.pdf"');
    res.send(buffer);
  } catch (error) { next(error); }
});
app.post("/api/export/docx", async (req, res, next) => {
  try {
    const { text, title } = exportInput(req.body);
    const buffer = await createDocx(text, title);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeFilename(title) + '.docx"');
    res.send(buffer);
  } catch (error) { next(error); }
});

app.get("/api/memory", async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    if (accountsReady() && !account) return res.status(401).json({ error: "Sign in to access your saved memory." });
    res.json(account ? await listAccountMemory(account.id) : await listMemory());
  } catch (error) { next(error); }
});
app.post("/api/memory", async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    if (accountsReady() && !account) return res.status(401).json({ error: "Sign in to save account memory." });
    if (account) { const fact = await addAccountMemory(account.id, req.body.text, req.body.kind); return res.status(201).json({ fact, ...(await listAccountMemory(account.id)) }); }
    const fact = await addMemory(req.body.text, req.body.kind);
    res.status(201).json({ fact, ...(await listMemory()) });
  } catch (error) { next(error); }
});
app.put("/api/memory/:id", async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    if (accountsReady() && !account) return res.status(401).json({ error: "Sign in to edit account memory." });
    if (account) { const fact = await editAccountMemory(account.id, req.params.id, req.body.text, req.body.kind); if (!fact) return res.status(404).json({ error: "Memory fact not found." }); return res.json({ fact, ...(await listAccountMemory(account.id)) }); }
    const fact = await editMemory(req.params.id, req.body.text, req.body.kind);
    if (!fact) return res.status(404).json({ error: "Memory fact not found." });
    res.json({ fact, ...(await listMemory()) });
  } catch (error) { next(error); }
});
app.delete("/api/memory/:id", async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    if (accountsReady() && !account) return res.status(401).json({ error: "Sign in to delete account memory." });
    if (account) { if (!await deleteAccountMemory(account.id, req.params.id)) return res.status(404).json({ error: "Memory fact not found." }); return res.json(await listAccountMemory(account.id)); }
    if (!await deleteMemory(req.params.id)) return res.status(404).json({ error: "Memory fact not found." });
    res.json(await listMemory());
  } catch (error) { next(error); }
});

app.post("/api/imagine", async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    const trial = account ? null : trialStatus(req, res);
    if (trial && trial.remaining <= 0) throw httpError(402, "Your 5 free KAY requests are used. Sign in to continue.");
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const prompt = String(req.body.prompt || "").trim().slice(0, 4000);
    if (!prompt) throw httpError(400, "Add a prompt for the image.");
    const attachment = req.body.attachmentId ? await getUpload(req.body.attachmentId) : null;
    if (req.body.attachmentId && (!attachment || !attachment.isImage)) throw httpError(400, "Attach a supported image to edit.");
    const image = await generateImage({ id: String(req.body.provider || ""), prompt, attachment, signal: controller.signal });
    if (trial) await recordTrialRequest(trial.id);
    const directory = path.join(publicDir, "generated");
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const ext = image.mimeType === "image/jpeg" ? ".jpg" : ".png";
    await writeFile(path.join(directory, id + ext), Buffer.from(image.data, "base64"));
    res.status(201).json({ url: "/generated/" + id + ext, description: image.description });
  } catch (error) { next(error); }
});
app.post("/api/transcribe", upload.single("file"), async (req, res, next) => {
  try {
    const account = accountsReady() ? readAccountCookie(req) : null;
    const trial = account ? null : trialStatus(req, res);
    if (trial && trial.remaining <= 0) throw httpError(402, "Your 5 free KAY requests are used. Sign in to continue.");
    if (!req.file) throw httpError(400, "Record audio before requesting transcription.");
    const metadata = await saveUpload(req.file);
    const file = await getUpload(metadata.id);
    const text = await transcribeAudio({
      id: String(req.body.provider || ""), buffer: file.buffer,
      filename: file.originalName, mimeType: file.mimeType,
    });
    if (trial) await recordTrialRequest(trial.id);
    res.json({ text });
  } catch (error) { next(error); }
});

app.use(express.static(publicDir, { extensions: ["html"], maxAge: 0 }));
app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((error, _req, res, _next) => {
  const status = error.status || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: error.message || "Request failed." });
});

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) throw httpError(400, "Send between 1 and 40 chat messages.");
  return input.map((item) => {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") {
      throw httpError(400, "Each message needs a user or assistant role and text content.");
    }
    return { role: item.role, content: item.content.slice(0, 20_000) };
  });
}
function wantsWebSearch(prompt) {
  return /\b(?:web\s*search|search (?:the )?(?:web|internet|online)|look up online|browse (?:the )?(?:web|internet)|online sources?|find (?:me )?(?:sources|references)|citations?|current(?:ly)?|latest|most recent|recent (?:news|updates|version|price|score)|today(?:'s)?|right now|this (?:week|month|year)|as of \d{4}|news|weather|stock price|exchange rate|election results)\b/i.test(prompt);
}
function exportInput(body) {
  if (Array.isArray(body.messages)) {
    const text = body.messages.map((item) => (item.role === "assistant" ? "## KAY\n\n" : "## You\n\n") + String(item.content || "")).join("\n\n---\n\n");
    return { text: text.slice(0, 500_000), title: "KAY-conversation" };
  }
  return { text: String(body.text || "").slice(0, 200_000), title: String(body.title || "KAY-response").slice(0, 80) };
}
function safeFilename(value) {
  return String(value || "KAY").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "KAY";
}
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const memoryMode = (await listMemory()).mode;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, "0.0.0.0", () => {
    console.log("KAY is running at http://0.0.0.0:" + port + " (memory: " + memoryMode + ")");
    if (!configuredProviders().length) console.log("Add a provider key to .env to enable chat.");
  });
}
export default app;


