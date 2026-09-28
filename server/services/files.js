// الملفات المرفوعة ومخرجات الوكيل (تقارير/نصوص). الأسماء المخزنة عشوائية لمنع اجتياز المسارات.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { now } from "../db.js";

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TEXT_TYPES = { ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".log": "text/plain" };
const DOC_TYPES = { ".pdf": "application/pdf" };
const OFFICE_TYPES = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const SUPPORTED_EXTENSIONS = [...Object.keys(IMAGE_TYPES), ...Object.keys(TEXT_TYPES), ...Object.keys(DOC_TYPES), ...Object.keys(OFFICE_TYPES)];
const MAX_TEXT_CHARS = 400_000;

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function classify(name) {
  const ext = path.extname(name || "").toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: "image", mime: IMAGE_TYPES[ext] };
  if (TEXT_TYPES[ext]) return { kind: "text", mime: TEXT_TYPES[ext] };
  if (DOC_TYPES[ext]) return { kind: "pdf", mime: DOC_TYPES[ext] };
  if (ext === ".xlsx") return { kind: "xlsx", mime: OFFICE_TYPES[ext] };
  if (ext === ".docx") return { kind: "docx", mime: OFFICE_TYPES[ext] };
  return null;
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) v = v.toISOString();
  else if (typeof v === "object") v = v.result ?? v.text ?? (Array.isArray(v.richText) ? v.richText.map((r) => r.text).join("") : v.hyperlink ?? JSON.stringify(v));
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** يحوّل xlsx إلى نص CSV لكل ورقة، و docx إلى نص خام */
export async function officeToText(buf, kind) {
  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value.trim();
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(vals.map(csvCell).join(","));
    });
    parts.push(`### ورقة: ${ws.name} (${rows.length} صف)\n${rows.join("\n")}`);
  });
  return parts.join("\n\n");
}

// multer يفك أسماء الملفات كـ latin1؛ نعيدها UTF-8 لدعم الأسماء العربية
export function fixName(name) {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("�") ? name : decoded;
  } catch { return name; }
}

export function makeFiles(db, { uploadsDir, outputsDir }) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  const get = (id) => db.prepare("SELECT * FROM files WHERE id = ?").get(id);
  const diskPath = (f) => path.join(f.kind === "upload" ? uploadsDir : outputsDir, f.stored_name);

  return {
    uploadsDir,
    get,
    diskPath,
    list(kind) {
      return kind
        ? db.prepare("SELECT * FROM files WHERE kind = ? ORDER BY id DESC").all(kind)
        : db.prepare("SELECT * FROM files ORDER BY id DESC").all();
    },
    /** يسجّل ملفًا رفعه multer (موجود على القرص مسبقًا) */
    registerUpload({ originalname, storedPath, size }) {
      const name = fixName(originalname);
      const c = classify(name);
      if (!c) {
        fs.rmSync(storedPath, { force: true });
        throw httpError(415, `نوع الملف غير مدعوم حاليًا. المدعوم: ${SUPPORTED_EXTENSIONS.join(" ")} (ملفات xls/doc القديمة: احفظها بصيغة xlsx/docx).`);
      }
      const stored = crypto.randomUUID() + path.extname(name).toLowerCase();
      fs.renameSync(storedPath, path.join(uploadsDir, stored));
      const r = db.prepare("INSERT INTO files (kind, name, mime, size, stored_name, created_at) VALUES ('upload',?,?,?,?,?)").run(name, c.mime, size, stored, now());
      return get(Number(r.lastInsertRowid));
    },
    /** يحفظ مخرجًا أنشأه الوكيل */
    createOutput({ title, format, content, conversationId = null }) {
      const formats = { md: "text/markdown", html: "text/html", csv: "text/csv", txt: "text/plain", json: "application/json" };
      if (!formats[format]) throw httpError(400, `صيغة غير مدعومة: ${format}`);
      if (typeof content !== "string" || !content.length) throw httpError(400, "المحتوى فارغ");
      let body = content;
      if (format === "html" && !/<html[\s>]/i.test(content)) {
        const esc = String(title).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
        body = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title>
<style>body{font-family:"Noto Naskh Arabic","Segoe UI",Tahoma,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.8;color:#1b1f24}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd;padding:.4rem .6rem;text-align:right}th{background:#f2f4f7}</style></head><body>${content}</body></html>`;
      }
      if (format === "csv") body = "﻿" + content; // BOM ليعرض Excel العربية بشكل صحيح
      const safeTitle = String(title || "output").replace(/[\\/:*?"<>|\n\r]+/g, "-").slice(0, 80).trim() || "output";
      const name = `${safeTitle}.${format}`;
      const stored = crypto.randomUUID() + "." + format;
      fs.writeFileSync(path.join(outputsDir, stored), body, "utf8");
      const r = db.prepare("INSERT INTO files (kind, name, mime, size, stored_name, conversation_id, created_at) VALUES ('output',?,?,?,?,?,?)")
        .run(name, formats[format], Buffer.byteLength(body), stored, conversationId, now());
      return get(Number(r.lastInsertRowid));
    },
    remove(id) {
      const f = get(id);
      if (!f) throw httpError(404, "الملف غير موجود");
      fs.rmSync(diskPath(f), { force: true });
      db.prepare("DELETE FROM files WHERE id = ?").run(id);
      return { deleted: id };
    },
    async readText(id) {
      const f = get(id);
      if (!f) throw httpError(404, `الملف ${id} غير موجود`);
      const c = classify(f.name);
      if (!c || !["text", "xlsx", "docx"].includes(c.kind)) throw httpError(400, `الملف ${f.name} ليس ملفًا نصيًا أو Excel/Word`);
      const buf = fs.readFileSync(diskPath(f));
      const text = c.kind === "text" ? buf.toString("utf8").replace(/^\uFEFF/, "") : await officeToText(buf, c.kind);
      return { file: f, text };
    },
    /** يحوّل ملفًا مرفوعًا إلى كتلة محتوى لرسالة Claude */
    async toContentBlock(id) {
      const f = get(id);
      if (!f || f.kind !== "upload") throw httpError(404, `الملف ${id} غير موجود`);
      const c = classify(f.name);
      const buf = fs.readFileSync(diskPath(f));
      if (c.kind === "image") {
        return { type: "image", source: { type: "base64", media_type: c.mime, data: buf.toString("base64") } };
      }
      if (c.kind === "pdf") {
        return { type: "document", title: f.name, source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
      }
      let text;
      try {
        text = c.kind === "text" ? buf.toString("utf8").replace(/^\uFEFF/, "") : await officeToText(buf, c.kind);
      } catch (e) {
        throw httpError(422, `تعذّرت قراءة ${f.name}: الملف تالف أو بصيغة غير مدعومة (${e.message})`);
      }
      if (!text) throw httpError(422, `الملف ${f.name} لا يحتوي نصًا قابلًا للاستخراج`);
      if (text.length > MAX_TEXT_CHARS) {
        throw httpError(413, `الملف ${f.name} كبير جدًا (${text.length} حرفًا). الحد ${MAX_TEXT_CHARS}. قسّمه أو ارفع جزءًا منه.`);
      }
      return { type: "document", title: f.name, source: { type: "text", media_type: "text/plain", data: text } };
    },
  };
}
