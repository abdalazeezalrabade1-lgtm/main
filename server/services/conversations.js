import { now } from "../db.js";

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function makeConversations(db) {
  return {
    list(source) {
      return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c ${source ? "WHERE source = ?" : ""} ORDER BY updated_at DESC LIMIT 200`).all(...(source ? [source] : []));
    },
    get(id) { return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id); },
    create(title, source = "chat") {
      const t = now();
      const r = db.prepare("INSERT INTO conversations (title, source, created_at, updated_at) VALUES (?,?,?,?)").run(String(title || "محادثة جديدة").slice(0, 120), source, t, t);
      return this.get(Number(r.lastInsertRowid));
    },
    rename(id, title) {
      if (!this.get(id)) throw httpError(404, "المحادثة غير موجودة");
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(String(title).slice(0, 120), now(), id);
      return this.get(id);
    },
    remove(id) {
      const r = db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      if (!r.changes) throw httpError(404, "المحادثة غير موجودة");
      return { deleted: id };
    },
    addMessage(conversationId, role, content, runId = null) {
      db.prepare("INSERT INTO messages (conversation_id, role, content_json, run_id, created_at) VALUES (?,?,?,?,?)")
        .run(conversationId, role, JSON.stringify(content), runId, now());
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conversationId);
    },
    /** السجل بصيغة Messages API — يُحفظ كما هو (append-only) ليبقى صالحًا لإعادة الإرسال */
    history(conversationId) {
      return db.prepare("SELECT role, content_json FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId)
        .map((r) => ({ role: r.role, content: JSON.parse(r.content_json) }));
    },
    messages(conversationId) {
      return db.prepare("SELECT id, role, content_json, run_id, created_at FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId)
        .map((r) => ({ id: r.id, role: r.role, run_id: r.run_id, created_at: r.created_at, content: JSON.parse(r.content_json) }));
    },
  };
}
