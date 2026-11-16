import multer from "multer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const uploadDir = path.join(root, "data", "uploads");
const maxBytes = Math.min(50, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 20))) * 1024 * 1024;
const mimeByExt = new Map([
  [".pdf", "application/pdf"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".txt", "text/plain"], [".csv", "text/csv"], [".tsv", "text/tab-separated-values"],
  [".js", "text/javascript"], [".mjs", "text/javascript"], [".cjs", "text/javascript"], [".ts", "text/typescript"],
  [".tsx", "text/typescript"], [".jsx", "text/javascript"], [".py", "text/x-python"], [".json", "application/json"],
  [".html", "text/html"], [".css", "text/css"], [".md", "text/markdown"], [".sql", "text/plain"],
  [".java", "text/plain"], [".cs", "text/plain"], [".go", "text/plain"], [".rs", "text/plain"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
  [".webm", "audio/webm"], [".wav", "audio/wav"], [".mp3", "audio/mpeg"], [".m4a", "audio/mp4"],
]);
const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    try { await mkdir(uploadDir, { recursive: true }); callback(null, uploadDir); }
    catch (error) { callback(error); }
  },
  filename: (_req, file, callback) => callback(null, randomUUID() + path.extname(file.originalname).toLowerCase()),
});
export const upload = multer({
  storage, limits: { fileSize: maxBytes, files: 4 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!mimeByExt.has(ext)) { const error = new Error("That file type is not supported."); error.status = 400; return callback(error); }
    callback(null, true);
  },
});

function mimeFor(file) {
  return mimeByExt.get(path.extname(file.originalname).toLowerCase()) || file.mimetype || "application/octet-stream";
}
async function extractText(file, buffer, mimeType) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf") {
    const result = await pdfParse(buffer);
    return String(result.text || "").slice(0, 80_000);
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return String(result.value || "").slice(0, 80_000);
  }
  if (mimeType.startsWith("text/") || [".json", ".md", ".sql"].includes(ext)) {
    return buffer.toString("utf8").slice(0, 80_000);
  }
  return "";
}
export async function saveUpload(file) {
  const id = path.basename(file.filename, path.extname(file.filename));
  const buffer = await readFile(file.path);
  const mimeType = mimeFor(file);
  const meta = {
    id, originalName: path.basename(file.originalname).slice(0, 160),
    mimeType, size: buffer.length, isImage: mimeType.startsWith("image/"),
    isAudio: mimeType.startsWith("audio/"), createdAt: new Date().toISOString(),
    text: await extractText(file, buffer, mimeType),
  };
  await writeFile(path.join(uploadDir, id + ".json"), JSON.stringify(meta), "utf8");
  return { ...meta, previewUrl: meta.isImage ? "/api/uploads/" + id : null };
}
export async function getUpload(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  let meta;
  try { meta = JSON.parse(await readFile(path.join(uploadDir, id + ".json"), "utf8")); }
  catch { return null; }
  const filename = id + path.extname(meta.originalName).toLowerCase();
  let diskName;
  try {
    const entries = await (await import("node:fs/promises")).readdir(uploadDir);
    diskName = entries.find((entry) => entry.startsWith(id + ".") && !entry.endsWith(".json"));
  } catch { return null; }
  if (!diskName) return null;
  const buffer = await readFile(path.join(uploadDir, diskName));
  return { ...meta, filename, buffer };
}


