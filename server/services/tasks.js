import { now } from "../db.js";

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"];
export const PRIORITIES = ["urgent", "high", "medium", "low"];
export const PROJECT_STATUSES = ["active", "paused", "done", "archived"];

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function normDate(v) {
  if (v === null || v === "") return null;
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(400, `تاريخ غير صالح: ${v}`);
  return d.toISOString();
}

export function makeTasks(db) {
  const getTask = (id) => db.prepare("SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(id);
  const getProject = (id) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  const checkProject = (pid) => { if (pid != null && !getProject(pid)) throw httpError(400, `المشروع ${pid} غير موجود`); };

  return {
    // ——— المشاريع
    listProjects() {
      return db.prepare(`SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
        FROM projects p ORDER BY p.status = 'active' DESC, p.updated_at DESC`).all();
    },
    getProject,
    createProject({ name, description = "", status = "active" }) {
      if (!name || !String(name).trim()) throw httpError(400, "اسم المشروع مطلوب");
      if (!PROJECT_STATUSES.includes(status)) throw httpError(400, "حالة مشروع غير صالحة");
      const t = now();
      const r = db.prepare("INSERT INTO projects (name, description, status, created_at, updated_at) VALUES (?,?,?,?,?)").run(String(name).trim(), description, status, t, t);
      return getProject(Number(r.lastInsertRowid));
    },
    updateProject(id, patch) {
      const cur = getProject(id);
      if (!cur) throw httpError(404, "المشروع غير موجود");
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => ["name", "description", "status"].includes(k) && v !== undefined)) };
      if (!PROJECT_STATUSES.includes(next.status)) throw httpError(400, "حالة مشروع غير صالحة");
      db.prepare("UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?").run(next.name, next.description, next.status, now(), id);
      return getProject(id);
    },
    removeProject(id) {
      const r = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      if (!r.changes) throw httpError(404, "المشروع غير موجود");
      return { deleted: id };
    },

    // ——— المهام
    listTasks({ status, project_id, priority, due_before, include_closed } = {}) {
      const where = [], args = [];
      if (status) { where.push("t.status = ?"); args.push(status); }
      else if (!include_closed || include_closed === "false") where.push("t.status NOT IN ('done','cancelled')");
      if (project_id) { where.push("t.project_id = ?"); args.push(Number(project_id)); }
      if (priority) { where.push("t.priority = ?"); args.push(priority); }
      if (due_before) { where.push("t.due_at IS NOT NULL AND t.due_at <= ?"); args.push(normDate(due_before)); }
      return db.prepare(`SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 t.due_at IS NULL, t.due_at, t.id`).all(...args);
    },
    getTask,
    createTask({ title, description = "", priority = "medium", status = "todo", due_at = null, project_id = null, notes = "" }) {
      if (!title || !String(title).trim()) throw httpError(400, "عنوان المهمة مطلوب");
      if (!PRIORITIES.includes(priority)) throw httpError(400, `أولوية غير صالحة. المسموح: ${PRIORITIES.join(", ")}`);
      if (!TASK_STATUSES.includes(status)) throw httpError(400, `حالة غير صالحة. المسموح: ${TASK_STATUSES.join(", ")}`);
      checkProject(project_id);
      const t = now();
      const r = db.prepare(`INSERT INTO tasks (project_id, title, description, status, priority, due_at, notes, created_at, updated_at, completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(project_id ?? null, String(title).trim(), description, status, priority, normDate(due_at) ?? null, notes, t, t, status === "done" ? t : null);
      return getTask(Number(r.lastInsertRowid));
    },
    updateTask(id, patch) {
      const cur = getTask(id);
      if (!cur) throw httpError(404, "المهمة غير موجودة");
      const allowed = ["title", "description", "status", "priority", "due_at", "project_id", "notes"];
      const next = { ...cur };
      for (const k of allowed) if (patch[k] !== undefined) next[k] = k === "due_at" ? normDate(patch[k]) : patch[k];
      if (!TASK_STATUSES.includes(next.status)) throw httpError(400, "حالة غير صالحة");
      if (!PRIORITIES.includes(next.priority)) throw httpError(400, "أولوية غير صالحة");
      checkProject(next.project_id);
      const completed = next.status === "done" ? (cur.completed_at || now()) : null;
      db.prepare(`UPDATE tasks SET title=?, description=?, status=?, priority=?, due_at=?, project_id=?, notes=?, updated_at=?, completed_at=? WHERE id=?`)
        .run(next.title, next.description, next.status, next.priority, next.due_at ?? null, next.project_id ?? null, next.notes, now(), completed, id);
      return getTask(id);
    },
    removeTask(id) {
      const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      if (!r.changes) throw httpError(404, "المهمة غير موجودة");
      return { deleted: id };
    },
    summary() {
      const n = now();
      const q = (sql, ...a) => db.prepare(sql).get(...a).c;
      return {
        open: q("SELECT COUNT(*) c FROM tasks WHERE status NOT IN ('done','cancelled')"),
        in_progress: q("SELECT COUNT(*) c FROM tasks WHERE status = 'in_progress'"),
        blocked: q("SELECT COUNT(*) c FROM tasks WHERE status = 'blocked'"),
        overdue: q("SELECT COUNT(*) c FROM tasks WHERE status NOT IN ('done','cancelled') AND due_at IS NOT NULL AND due_at < ?", n),
        done: q("SELECT COUNT(*) c FROM tasks WHERE status = 'done'"),
      };
    },
  };
}
