import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, ShadingType } from "docx";

const fence = String.fromCharCode(96, 96, 96);
function cleanProse(value) {
  return String(value || "").split(/(https?:\/\/[^\s]+)/gi).map((part, index) => index % 2 ? part : part.replace(/\*\*(.*?)\*\*/g, "$1").replace(/[!@*()]/g, "")).join("");
}
function cleanTitle(value) { return cleanProse(value).replace(/\s+/g, " ").trim().slice(0, 80) || "KAY"; }
function markdownBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let paragraph = [];
  let code = [];
  let inCode = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  };
  for (const line of lines) {
    if (line.trimStart().startsWith(fence)) {
      flushParagraph();
      if (inCode) { blocks.push({ type: "code", text: code.join("\n") }); code = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ type: "heading", level: heading[1].length, text: cleanProse(heading[2]) }); continue; }
    if (/^\s*\|/.test(line)) {
      flushParagraph();
      const cells = line.split("|").slice(1, -1).map((cell) => cleanProse(cell.trim()));
      if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) blocks.push({ type: "tableRow", cells });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) { flushParagraph(); blocks.push({ type: "bullet", text: cleanProse(bullet[1]) }); continue; }
    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numbered) { flushParagraph(); blocks.push({ type: "number", number: numbered[1], text: cleanProse(numbered[2]) }); continue; }
    if (!line.trim()) { flushParagraph(); continue; }
    paragraph.push(cleanProse(line.trim()));
  }
  flushParagraph();
  if (inCode) blocks.push({ type: "code", text: code.join("\n") });
  return blocks;
}
function inlineRuns(text) {
  const runs = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let previous = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > previous) runs.push(new TextRun(text.slice(previous, match.index)));
    const token = match[0];
    if (token.startsWith("**")) runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    else runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    previous = match.index + token.length;
  }
  if (previous < text.length) runs.push(new TextRun(text.slice(previous)));
  return runs.length ? runs : [new TextRun(text)];
}
export function createPdf(markdown, title = "KAY") {
  return new Promise((resolve, reject) => {
    title = cleanTitle(title);
    const document = new PDFDocument({ size: "A4", margins: { top: 54, right: 52, bottom: 54, left: 52 }, info: { Title: title, Author: "KAY" } });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.font("Helvetica-Bold").fontSize(19).fillColor("#214b32").text(title, { lineGap: 4 });
    document.moveDown(0.6);
    for (const block of markdownBlocks(markdown)) {
      if (block.type === "heading") {
        document.moveDown(0.35).font("Helvetica-Bold").fontSize(Math.max(12, 18 - block.level)).fillColor("#25553a").text(block.text, { keepWithNext: true });
        document.moveDown(0.15);
      } else if (block.type === "code") {
        const options = { width: 470, font: "Courier", fontSize: 8.5, lineGap: 2 };
        const height = document.heightOfString(block.text || " ", options) + 16;
        const y = document.y;
        document.save().roundedRect(52, y, 491, height, 5).fill("#15201a").restore();
        document.font("Courier").fontSize(8.5).fillColor("#d9ebdd").text(block.text, 62, y + 8, { ...options, width: 470 });
        document.y = y + height + 9;
      } else if (block.type === "bullet") {
        document.font("Helvetica").fontSize(10).fillColor("#25312a").text("•  " + block.text, { indent: 14, hanging: 4, lineGap: 3 });
      } else if (block.type === "number") {
        document.font("Helvetica").fontSize(10).fillColor("#25312a").text(block.number + ".  " + block.text, { indent: 14, hanging: 4, lineGap: 3 });
      } else if (block.type === "tableRow") {
        document.font("Courier").fontSize(8.2).fillColor("#26352b").text(block.cells.join("   |   "), { lineGap: 3 });
      } else {
        document.font("Helvetica").fontSize(10).fillColor("#25312a").text(block.text, { lineGap: 4, paragraphGap: 6 });
      }
      document.moveDown(0.45);
    }
    document.end();
  });
}
export async function createDocx(markdown, title = "KAY") {
  title = cleanTitle(title);
  const blocks = markdownBlocks(markdown);
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 280 } })];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === "heading") {
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
      children.push(new Paragraph({ text: block.text, heading: levels[Math.min(block.level - 1, 2)], spacing: { before: 220, after: 100 } }));
    } else if (block.type === "code") {
      for (const line of block.text.split("\n")) {
        children.push(new Paragraph({
          children: [new TextRun({ text: line || " ", font: "Consolas", size: 18, color: "D9EBDD" })],
          shading: { type: ShadingType.CLEAR, fill: "15201A" },
          spacing: { before: 0, after: 0 },
        }));
      }
    } else if (block.type === "bullet") {
      children.push(new Paragraph({ children: inlineRuns(block.text), bullet: { level: 0 }, spacing: { after: 60 } }));
    } else if (block.type === "number") {
      children.push(new Paragraph({ children: [new TextRun(block.number + ". "), ...inlineRuns(block.text)], spacing: { after: 60 } }));
    } else if (block.type === "tableRow") {
      const rows = [];
      while (index < blocks.length && blocks[index].type === "tableRow") {
        const row = blocks[index++];
        rows.push(new TableRow({
          children: row.cells.map((cell) => new TableCell({
            children: [new Paragraph({ children: inlineRuns(cell) })],
            ...(rows.length === 0 ? { shading: { type: ShadingType.CLEAR, fill: "DDEDE1" } } : {}),
          })),
        }));
      }
      index--;
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    } else {
      children.push(new Paragraph({ children: inlineRuns(block.text), spacing: { after: 130, line: 320 } }));
    }
  }
  const doc = new Document({
    creator: "KAY",
    title,
    styles: { default: { document: { run: { font: "Aptos", size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
