import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dataDir = path.join(root, "data");
const stateFile = path.join(dataDir, "kay-memory.json");
const defaultUserId = "00000000-0000-4000-8000-000000000001";
const getLocalUserId = () => process.env.KAY_USER_ID || defaultUserId;
const allowedKinds = new Set(["preferences", "tech_stack", "active_projects", "coding_habits", "other"]);
let pool = null;
let postgresReady = false;
let state = { facts: [] };

async function readState() {
  await mkdir(dataDir, { recursive: true });
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8"));
    state = { facts: Array.isArray(value.facts) ? value.facts : [] };
  } catch {
    state = { facts: [] };
    await writeState();
  }
}
async function writeState() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}
async function fallback() {
  postgresReady = false;
  try { await pool?.end(); } catch {}
  pool = null;
  await readState();
}
export async function initMemory() {
  await fallback();
  if (!process.env.DATABASE_URL) return { mode: "json" };
  let candidate;
  try {
    const { Pool } = await import("pg");
    candidate = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 3000 });
    await candidate.query("SELECT 1");
    const schema = await readFile(path.join(root, "db", "schema.sql"), "utf8");
    await candidate.query(schema);
    await candidate.query(
      "INSERT INTO users (id, profile) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
      [getLocalUserId(), JSON.stringify(emptyProfile())]
    );
    pool = candidate;
    postgresReady = true;
    return { mode: "postgres" };
  } catch (error) {
    console.warn("KAY memory is using the local JSON fallback:", error.message);
    try { await candidate?.end(); } catch {}
    await fallback();
    return { mode: "json" };
  }
}
function emptyProfile() {
  return { preferences: [], tech_stack: [], active_projects: [], coding_habits: [], other: [] };
}
function profileFor(facts) {
  const profile = emptyProfile();
  for (const fact of facts) {
    const kind = allowedKinds.has(fact.kind) ? fact.kind : "other";
    profile[kind].push(fact.text);
  }
  return profile;
}
export async function listMemory() {
  if (postgresReady) {
    const result = await pool.query(
      "SELECT id::text, memory_kind AS kind, content AS text, created_at FROM memories WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at DESC",
      [getLocalUserId()]
    );
    const facts = result.rows.map((row) => ({ ...row, createdAt: row.created_at }));
    return { mode: "postgres", facts, profile: profileFor(facts) };
  }
  return { mode: "json", facts: [...state.facts].reverse(), profile: profileFor(state.facts) };
}
async function syncProfile(facts) {
  const profile = profileFor(facts);
  if (postgresReady) {
    await pool.query("UPDATE users SET profile=$2::jsonb, updated_at=now() WHERE id=$1", [getLocalUserId(), JSON.stringify(profile)]);
  } else {
    await writeState();
  }
  return profile;
}
export async function addMemory(text, kind = "other") {
  const content = String(text || "").trim().slice(0, 400);
  const memoryKind = allowedKinds.has(kind) ? kind : "other";
  if (!content) throw new Error("Memory text cannot be empty.");
  const current = await listMemory();
  const duplicate = current.facts.find((fact) => fact.text.toLowerCase() === content.toLowerCase());
  if (duplicate) return duplicate;
  if (postgresReady) {
    const result = await pool.query(
      "INSERT INTO memories (user_id, content, memory_kind, user_approved) VALUES ($1,$2,$3,true) RETURNING id::text, memory_kind AS kind, content AS text, created_at",
      [getLocalUserId(), content, memoryKind]
    );
    const row = result.rows[0];
    const facts = [...current.facts, { id: row.id, kind: row.kind, text: row.text, createdAt: row.created_at }];
    await syncProfile(facts);
    return facts.at(-1);
  }
  const fact = { id: randomUUID(), kind: memoryKind, text: content, createdAt: new Date().toISOString() };
  state.facts.push(fact);
  await syncProfile(state.facts);
  return fact;
}
export async function editMemory(id, text, kind) {
  const content = String(text || "").trim().slice(0, 400);
  const memoryKind = allowedKinds.has(kind) ? kind : "other";
  if (!content) throw new Error("Memory text cannot be empty.");
  if (postgresReady) {
    const result = await pool.query(
      "UPDATE memories SET content=$3, memory_kind=$4 WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id::text, memory_kind AS kind, content AS text, created_at",
      [id, getLocalUserId(), content, memoryKind]
    );
    if (!result.rowCount) return null;
    const list = await listMemory();
    await syncProfile(list.facts);
    return result.rows[0];
  }
  const fact = state.facts.find((item) => item.id === id);
  if (!fact) return null;
  fact.text = content;
  fact.kind = memoryKind;
  await syncProfile(state.facts);
  return fact;
}
export async function deleteMemory(id) {
  if (postgresReady) {
    const result = await pool.query("DELETE FROM memories WHERE id=$1 AND user_id=$2", [id, getLocalUserId()]);
    if (!result.rowCount) return false;
    const list = await listMemory();
    await syncProfile(list.facts);
    return true;
  }
  const before = state.facts.length;
  state.facts = state.facts.filter((fact) => fact.id !== id);
  if (state.facts.length === before) return false;
  await syncProfile(state.facts);
  return true;
}

function extractExplicitFacts(text) {
  const rules = [
    ["preferences", /\bI\s+(?:prefer|like|usually|often)\s+[^.!?\n]{4,180}/gi],
    ["tech_stack", /\bI\s+(?:use|work with|build with)\s+[^.!?\n]{4,180}/gi],
    ["active_projects", /\b(?:I am|I'm|we are|we're)\s+(?:working on|building|developing)\s+[^.!?\n]{4,180}/gi],
    ["coding_habits", /\bI\s+(?:write tests|use tabs|use spaces|prefer typed code|keep my functions)\b[^.!?\n]{0,150}/gi],
  ];
  const matches = [];
  for (const [kind, regex] of rules) {
    for (const match of String(text || "").matchAll(regex)) {
      const value = match[0].trim();
      if (value.length >= 8) matches.push({ kind, text: value });
    }
  }
  return matches;
}
export async function profileUserMessages(messages) {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const fact of extractExplicitFacts(message.content)) await addMemory(fact.text, fact.kind);
  }
}
export function profilePrompt(profile) {
  const entries = Object.entries(profile || {}).filter(([, values]) => Array.isArray(values) && values.length);
  if (!entries.length) return "";
  const lines = entries.map(([kind, values]) => kind.replaceAll("_", " ") + ": " + values.join("; "));
  return "User-approved local profile facts. Use these only when relevant and do not infer extra personal details:\n" + lines.join("\n");
}



