import { now } from "../db.js";

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// الإجراءات الحساسة (حذف نهائي، إرسال، نشر، تعديل خارجي) لا تُنفَّذ إلا بعد موافقة المستخدم.
export function makeApprovals(db) {
  const get = (id) => db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id);
  return {
    get,
    list(status) {
      return db.prepare(`SELECT * FROM pending_actions ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 200`).all(...(status ? [status] : []));
    },
    create({ runId, tool, input, summary }) {
      const r = db.prepare("INSERT INTO pending_actions (run_id, tool, input_json, summary, created_at) VALUES (?,?,?,?,?)")
        .run(runId ?? null, tool, JSON.stringify(input), summary, now());
      return get(Number(r.lastInsertRowid));
    },
    decide(id, status, result) {
      const cur = get(id);
      if (!cur) throw httpError(404, "الطلب غير موجود");
      if (cur.status !== "pending") throw httpError(409, "تم البت في هذا الطلب مسبقًا");
      db.prepare("UPDATE pending_actions SET status = ?, result_json = ?, decided_at = ? WHERE id = ?")
        .run(status, result === undefined ? null : JSON.stringify(result), now(), id);
      return get(id);
    },
  };
}
