import { randomUUID } from "node:crypto";

let mongoose;
let bcrypt;
let jwt;
let User;
let Conversation;
let Feedback;
let ready = false;

export async function initAccounts() {
  if (!process.env.MONGODB_URI) return false;
  try {
    const [mongooseModule, bcryptModule, jwtModule] = await Promise.all([
      import("mongoose"), import("bcryptjs"), import("jsonwebtoken"),
    ]);
    mongoose = mongooseModule.default || mongooseModule;
    bcrypt = bcryptModule.default || bcryptModule;
    jwt = jwtModule.default || jwtModule;
    const ProfileFactSchema = new mongoose.Schema({ id: String, kind: String, text: String, createdAt: Date }, { _id: false });
    const OAuthIdentitySchema = new mongoose.Schema({ provider: String, subject: String, connectedAt: { type: Date, default: Date.now } }, { _id: false });
    const UserSchema = new mongoose.Schema({
      name: { type: String, required: true, trim: true, maxlength: 100 },
      email: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
      passwordHash: { type: String, default: "" },
      oauthProviders: { type: [OAuthIdentitySchema], default: [] },
      profileFacts: { type: [ProfileFactSchema], default: [] },
      createdAt: { type: Date, default: Date.now },
    }, { versionKey: false });
    const MessageSchema = new mongoose.Schema({
      role: { type: String, enum: ["user", "assistant"], required: true },
      content: { type: String, maxlength: 200000, default: "" },
      imageUrl: { type: String, default: "" },
      attachments: { type: [String], default: [] },
      sources: { type: [mongoose.Schema.Types.Mixed], default: [] },
      createdAt: { type: Date, default: Date.now },
    }, { _id: false });
    const ConversationSchema = new mongoose.Schema({
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "KayUser", required: true, index: true },
      title: { type: String, required: true, maxlength: 100, default: "New chat" },
      messages: { type: [MessageSchema], default: [] },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now, index: true },
    }, { versionKey: false });
    ConversationSchema.index({ userId: 1, updatedAt: -1 });
    const FeedbackSchema = new mongoose.Schema({
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "KayUser", required: true, index: true },
      message: { type: String, required: true, maxlength: 2000 },
      rating: { type: Number, min: 1, max: 5, default: null },
      createdAt: { type: Date, default: Date.now, index: true },
    }, { versionKey: false });
    User = mongoose.models.KayUser || mongoose.model("KayUser", UserSchema);
    Conversation = mongoose.models.KayConversation || mongoose.model("KayConversation", ConversationSchema);
    Feedback = mongoose.models.KayFeedback || mongoose.model("KayFeedback", FeedbackSchema);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 2500, connectTimeoutMS: 2500, maxPoolSize: 8 });
    ready = true;
    return true;
  } catch (error) {
    ready = false;
    console.warn("KAY account storage is unavailable:", error.message);
    return false;
  }
}
export const accountsReady = () => ready;
function publicUser(user) { return { id: String(user._id), name: user.name, email: user.email, createdAt: user.createdAt }; }
function issueToken(user) {
  return jwt.sign({ sub: String(user._id) }, getJwtSecret(), { expiresIn: "7d", issuer: "kay-assistant", audience: "kay-web" });
}
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw httpError(503, "Set JWT_SECRET to a random value with at least 32 characters, then restart KAY.");
  return secret;
}
function cookieOptions() {
  return ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800", ...(process.env.COOKIE_SECURE === "true" ? ["Secure"] : [])].join("; ");
}
export async function registerAccount({ name, email, password }) {
  if (!ready) throw accountUnavailable();
  getJwtSecret();
  const cleanName = String(name || "").trim().slice(0, 100);
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (cleanName.length < 2) throw httpError(400, "Enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw httpError(400, "Enter a valid email address.");
  if (typeof password !== "string" || password.length < 10 || password.length > 200) throw httpError(400, "Use a password with at least 10 characters.");
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name: cleanName, email: cleanEmail, passwordHash });
    return { user: publicUser(user), cookie: issueToken(user) };
  } catch (error) {
    if (error.code === 11000) throw httpError(409, "An account already exists for that email.");
    throw error;
  }
}
export async function loginAccount({ email, password }) {
  if (!ready) throw accountUnavailable();
  getJwtSecret();
  const user = await User.findOne({ email: String(email || "").trim().toLowerCase() });
  if (!user?.passwordHash || typeof password !== "string" || !await bcrypt.compare(password, user.passwordHash)) {
    throw httpError(401, "Email or password is incorrect.");
  }
  return { user: publicUser(user), cookie: issueToken(user) };
}
export async function oauthLoginOrCreate({ provider, subject, email, emailVerified, name }) {
  if (!ready) throw accountUnavailable();
  getJwtSecret();
  const cleanProvider = String(provider || "");
  const cleanSubject = String(subject || "");
  if (!cleanSubject || !["google", "apple", "github"].includes(cleanProvider)) throw httpError(400, "The identity provider returned an invalid account.");
  let user = await User.findOne({ oauthProviders: { $elemMatch: { provider: cleanProvider, subject: cleanSubject } } });
  if (!user) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!emailVerified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw httpError(403, "The provider did not return a verified email address.");
    user = await User.findOne({ email: cleanEmail });
    if (!user) {
      try {
        user = await User.create({ name: String(name || "KAY User").trim().slice(0, 100) || "KAY User", email: cleanEmail, passwordHash: "", oauthProviders: [{ provider: cleanProvider, subject: cleanSubject }] });
      } catch (error) {
        if (error.code !== 11000) throw error;
        user = await User.findOne({ email: cleanEmail });
      }
    }
    if (user && !user.oauthProviders.some((entry) => entry.provider === cleanProvider && entry.subject === cleanSubject)) {
      user.oauthProviders.push({ provider: cleanProvider, subject: cleanSubject });
      await user.save();
    }
  }
  return { user: publicUser(user), cookie: issueToken(user) };
}
export function readAccountCookie(req) {
  if (!ready) return null;
  const cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("kay_session="));
  if (!cookie) return null;
  try {
    const claims = jwt.verify(decodeURIComponent(cookie.slice("kay_session=".length)), getJwtSecret(), { issuer: "kay-assistant", audience: "kay-web" });
    return { id: claims.sub };
  } catch { return null; }
}
export function setSessionCookie(res, token) {
  const existing = res.getHeader("Set-Cookie");
  const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  cookies.push("kay_session=" + encodeURIComponent(token) + "; " + cookieOptions());
  res.setHeader("Set-Cookie", cookies);
}
export function clearSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("Set-Cookie", "kay_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + secure);
}
export async function accountForId(id) {
  if (!ready || !id) return null;
  const user = await User.findById(id).select("name email createdAt").lean();
  return user ? { id: String(user._id), name: user.name, email: user.email, createdAt: user.createdAt } : null;
}
export async function listConversations(userId) {
  return Conversation.find({ userId }).sort({ updatedAt: -1 }).limit(100).select("title updatedAt createdAt").lean();
}
export async function readConversation(userId, id) {
  return Conversation.findOne({ _id: id, userId }).lean();
}
export async function saveConversation(userId, input) {
  const messages = Array.isArray(input.messages) ? input.messages.slice(-200).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content || "").slice(0, 200000),
    imageUrl: String(message.imageUrl || "").slice(0, 2000),
    attachments: Array.isArray(message.attachments) ? message.attachments.slice(0, 8).map((name) => String(name).slice(0, 200)) : [],
    sources: Array.isArray(message.sources) ? message.sources.slice(0, 20) : [],
  })) : [];
  const first = messages.find((message) => message.role === "user")?.content || "New chat";
  const title = String(input.title || first).replace(/[!@*()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 96) || "New chat";
  const values = { title, messages, updatedAt: new Date() };
  if (input.id) return Conversation.findOneAndUpdate({ _id: input.id, userId }, { $set: values }, { new: true, runValidators: true });
  return Conversation.create({ ...values, userId });
}
export async function removeConversation(userId, id) {
  return (await Conversation.deleteOne({ _id: id, userId })).deletedCount > 0;
}
const memoryKinds = new Set(["preferences", "tech_stack", "active_projects", "coding_habits", "other"]);
export async function listAccountMemory(userId) {
  const user = await User.findById(userId).select("profileFacts").lean();
  const facts = user?.profileFacts || [];
  const profile = { preferences: [], tech_stack: [], active_projects: [], coding_habits: [], other: [] };
  for (const fact of facts) profile[memoryKinds.has(fact.kind) ? fact.kind : "other"].push(fact.text);
  return { mode: "mongodb", facts, profile };
}
export async function addAccountMemory(userId, text, kind = "other") {
  const clean = String(text || "").trim().slice(0, 400);
  if (!clean) throw httpError(400, "Memory text cannot be empty.");
  const user = await User.findById(userId);
  if (!user) throw httpError(404, "Account not found.");
  const duplicate = user.profileFacts.find((fact) => fact.text.toLowerCase() === clean.toLowerCase());
  if (duplicate) return duplicate.toObject();
  const fact = { id: randomUUID(), kind: memoryKinds.has(kind) ? kind : "other", text: clean, createdAt: new Date() };
  user.profileFacts.push(fact); await user.save(); return fact;
}
export async function editAccountMemory(userId, id, text, kind = "other") {
  const clean = String(text || "").trim().slice(0, 400);
  if (!clean) throw httpError(400, "Memory text cannot be empty.");
  const user = await User.findById(userId);
  const fact = user?.profileFacts.find((item) => item.id === id);
  if (!fact) return null;
  fact.text = clean; fact.kind = memoryKinds.has(kind) ? kind : "other"; await user.save(); return fact.toObject();
}
export async function deleteAccountMemory(userId, id) {
  const user = await User.findById(userId);
  if (!user) return false;
  const before = user.profileFacts.length;
  user.profileFacts = user.profileFacts.filter((fact) => fact.id !== id);
  if (before === user.profileFacts.length) return false;
  await user.save(); return true;
}
export function accountProfilePrompt(profile) {
  const entries = Object.entries(profile || {}).filter(([, values]) => Array.isArray(values) && values.length);
  if (!entries.length) return "";
  return "User-approved account memory. Use only when relevant and do not infer extra personal details:\n" + entries.map(([kind, values]) => kind.replaceAll("_", " ") + ": " + values.join("; ")).join("\n");
}
export async function creatorAuthorized(userId) {
  const email = String(process.env.KAY_CREATOR_EMAIL || "").trim().toLowerCase();
  if (!ready || !email || !userId) return false;
  const user = await User.findById(userId).select("email oauthProviders").lean();
  const verifiedSocialIdentity = (user?.oauthProviders || []).some((entry) => ["google", "apple"].includes(entry.provider));
  return Boolean(user && user.email === email && verifiedSocialIdentity);
}
export async function submitCreatorFeedback(userId, { message, rating }) {
  if (!ready) throw accountUnavailable();
  const clean = String(message || "").trim().slice(0, 2000);
  if (clean.length < 3) throw httpError(400, "Write a little more feedback before sending.");
  const score = rating === "" || rating == null ? null : Number(rating);
  if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) throw httpError(400, "Choose a rating from 1 to 5, or leave it blank.");
  return Feedback.create({ userId, message: clean, rating: score });
}
export async function creatorDashboard(userId) {
  if (!await creatorAuthorized(userId)) throw httpError(403, "Creator access is not enabled for this account.");
  const [users, feedback] = await Promise.all([
    User.find({ oauthProviders: { $elemMatch: { provider: { $in: ["google", "apple"] } } } })
      .select("name email oauthProviders createdAt").sort({ createdAt: -1 }).limit(500).lean(),
    Feedback.find().sort({ createdAt: -1 }).limit(200).populate("userId", "name email").lean(),
  ]);
  return {
    users: users.map((user) => ({ id: String(user._id), name: user.name, email: user.email, providers: [...new Set((user.oauthProviders || []).filter((entry) => ["google", "apple"].includes(entry.provider)).map((entry) => entry.provider))], createdAt: user.createdAt })),
    feedback: feedback.map((item) => ({ id: String(item._id), message: item.message, rating: item.rating, createdAt: item.createdAt, user: item.userId ? { name: item.userId.name, email: item.userId.email } : null })),
  };
}
function accountUnavailable() { return httpError(503, "Sign-in needs a working MongoDB connection. Set MONGODB_URI and restart KAY."); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
