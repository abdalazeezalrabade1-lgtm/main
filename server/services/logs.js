import { now } from "../db.js";
import { redact } from "./secrets.js";

export function makeLogger(db) {
  const ins = db.prepare("INSERT INTO action_logs (run_id, level, type, message, data_json, created_at) VALUES (?,?,?,?,?,?)");
  const log = (level, type, message, data, runId = null) => {
    const dataJson = data === undefined ? null : redact(data).slice(0, 8000);
    ins.run(runId, level, type, redact(message).slice(0, 2000), dataJson, now());
    if (level === "error") console.error(`[${type}] ${redact(message)}`);
  };
  return {
    info: (type, message, data, runId) => log("info", type, message, data, runId),
    warn: (type, message, data, runId) => log("warn", type, message, data, runId),
    error: (type, message, data, runId) => log("error", type, message, data, runId),
    list({ runId, level, limit = 200 } = {}) {
      const where = [];
      const args = [];
      if (runId) { where.push("run_id = ?"); args.push(runId); }
      if (level) { where.push("level = ?"); args.push(level); }
      const sql = `SELECT * FROM action_logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 1000));
    },
  };
}
