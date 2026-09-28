import { now } from "../db.js";
import { detectSecrets } from "./secrets.js";

export const MEMORY_CATEGORIES = ["preference", "project", "decision", "fact", "contact", "other"];

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function makeMemory(db) {
  function validate({ category, content, certainty }) {
    if (!MEMORY_CATEGORIES.includes(category)) throw httpError(400, `تصنيف غير صالح. المسموح: ${MEMORY_CATEGORIES.join(", ")}`);
    if (typeof content !== "string" || !content.trim()) throw httpError(400, "المحتوى مطلوب");
    if (content.length > 2000) throw httpError(400, "المحتوى أطول من 2000 حرف");
    if (!["confirmed", "inferred"].includes(certainty)) throw httpError(400, "certainty يجب أن تكون confirmed أو inferred");
    const secrets = detectSecrets(content);
    if (secrets.length) throw httpError(422, "رُفض الحفظ: يبدو أن النص يحتوي على كلمة مرور أو مفتاح أو بيانات سرية. لا تُحفظ الأسرار في الذاكرة.");
  }
  return {
    list({ category, certainty, q } = {}) {
      const where = [], args = [];
      if (category) { where.push("category = ?"); args.push(category); }
      if (certainty) { where.push("certainty = ?"); args.push(certainty); }
      if (q) { where.push("content LIKE ?"); args.push(`%${q}%`); }
      return db.prepare(`SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`).all(...args);
    },
    get(id) { return db.prepare("SELECT * FROM memories WHERE id = ?").get(id); },
    create({ category, content, certainty = "confirmed", source = "user" }) {
      validate({ category, content, certainty });
      const t = now();
      const r = db.prepare("INSERT INTO memories (category, content, certainty, source, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(category, content.trim(), certainty, source, t, t);
      return this.get(Number(r.lastInsertRowid));
    },
    update(id, patch) {
      const cur = this.get(id);
      if (!cur) throw httpError(404, "العنصر غير موجود");
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => ["category", "content", "certainty"].includes(k) && v !== undefined)) };
      validate(next);
      db.prepare("UPDATE memories SET category=?, content=?, certainty=?, updated_at=? WHERE id=?").run(next.category, next.content.trim(), next.certainty, now(), id);
      return this.get(id);
    },
    remove(id) {
      const r = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      if (!r.changes) throw httpError(404, "العنصر غير موجود");
      return { deleted: id };
    },
    /** نص الذاكرة الذي يُمرَّر للنموذج، مع تمييز المؤكد من المستنتج */
    promptBlock() {
      const rows = this.list();
      if (!rows.length) return "لا توجد عناصر محفوظة في الذاكرة بعد.";
      const fmt = (r) => `- [#${r.id} | ${r.category}] ${r.content}`;
      const confirmed = rows.filter((r) => r.certainty === "confirmed").slice(0, 150);
      const inferred = rows.filter((r) => r.certainty === "inferred").slice(0, 50);
      return [
        "معلومات مؤكدة (من المستخدم أو أكّدها):",
        confirmed.length ? confirmed.map(fmt).join("\n") : "- لا يوجد",
        "",
        "استنتاجات غير مؤكدة (عاملها كفرضيات، ولا تقدّمها كحقائق):",
        inferred.length ? inferred.map(fmt).join("\n") : "- لا يوجد",
      ].join("\n");
    },
  };
}
