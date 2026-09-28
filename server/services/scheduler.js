// جدولة فعلية داخل عملية الخادم باستخدام croner.
// مهم: المهام تعمل فقط ما دام الخادم يعمل. أي موعد يفوت أثناء التوقف يُسجَّل "missed" ولا يُنفَّذ بأثر رجعي.
import { Cron } from "croner";
import { now } from "../db.js";

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
const MIN_INTERVAL_MINUTES = 15;

export function validateCron(expr, timezone) {
  if (typeof expr !== "string" || expr.trim().split(/\s+/).length !== 5) {
    throw httpError(400, "صيغة cron يجب أن تكون 5 حقول: دقيقة ساعة يوم-الشهر شهر يوم-الأسبوع (مثال: 0 9 * * *)");
  }
  let job;
  try {
    job = new Cron(expr, { timezone, paused: true });
    const runs = job.nextRuns(3);
    if (runs.length >= 2 && (runs[1] - runs[0]) / 60000 < MIN_INTERVAL_MINUTES) {
      throw httpError(400, `أقل فاصل مسموح بين التشغيلات ${MIN_INTERVAL_MINUTES} دقيقة (للتحكم في التكلفة)`);
    }
    return runs[0]?.toISOString() ?? null;
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, `صيغة cron غير صالحة: ${e.message}`);
  } finally {
    job?.stop();
  }
}

export function makeScheduler(db, { timezone, enabled, logger }) {
  const jobs = new Map();
  let runner = null; // يُضبط لاحقًا: async (schedule) => void
  let started = false;
  const get = (id) => db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);

  function unschedule(id) { jobs.get(id)?.stop(); jobs.delete(id); }
  function schedule(s) {
    unschedule(s.id);
    if (!started || !s.enabled) {
      db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(s.enabled ? validateCron(s.cron, timezone) : null, s.id);
      return;
    }
    const job = new Cron(s.cron, { timezone, protect: true }, async () => {
      const cur = get(s.id);
      if (!cur || !cur.enabled) return;
      const next = job.nextRun();
      db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?").run(now(), next ? next.toISOString() : null, s.id);
      try { await runner?.(cur); } catch (e) { logger.error("scheduler", `فشل تشغيل المهمة المجدولة #${s.id}: ${e.message}`); }
    });
    jobs.set(s.id, job);
    const next = job.nextRun();
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(next ? next.toISOString() : null, s.id);
  }

  return {
    setRunner(fn) { runner = fn; },
    get isRunning() { return started; },
    get enabled() { return enabled; },
    start() {
      if (!enabled) { logger.warn("scheduler", "المجدول معطّل (SCHEDULER_ENABLED=false)"); return; }
      started = true;
      const t = now();
      for (const s of db.prepare("SELECT * FROM schedules WHERE enabled = 1").all()) {
        // موعد فات أثناء توقف الخادم: نسجله بوضوح ولا ندّعي تنفيذه
        if (s.next_run_at && s.next_run_at < t) {
          db.prepare("INSERT INTO schedule_runs (schedule_id, status, error, started_at, finished_at) VALUES (?, 'missed', ?, ?, ?)")
            .run(s.id, `فات الموعد ${s.next_run_at} لأن الخادم كان متوقفًا`, s.next_run_at, t);
          logger.warn("scheduler", `موعد فائت للمهمة المجدولة #${s.id} (${s.name}) — الخادم كان متوقفًا`);
        }
        schedule(s);
      }
      logger.info("scheduler", `بدأ المجدول مع ${jobs.size} مهمة مفعّلة`);
    },
    stop() { for (const id of [...jobs.keys()]) unschedule(id); started = false; },
    list() {
      return db.prepare(`SELECT s.*, (SELECT status FROM schedule_runs r WHERE r.schedule_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_status
        FROM schedules s ORDER BY s.id DESC`).all();
    },
    get,
    create({ name, cron, prompt, enabled: en = true }) {
      if (!name || !String(name).trim()) throw httpError(400, "الاسم مطلوب");
      if (!prompt || !String(prompt).trim()) throw httpError(400, "نص المهمة (prompt) مطلوب");
      validateCron(cron, timezone);
      const t = now();
      const r = db.prepare("INSERT INTO schedules (name, cron, prompt, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(String(name).trim(), cron.trim(), String(prompt).trim(), en ? 1 : 0, t, t);
      const s = get(Number(r.lastInsertRowid));
      schedule(s);
      return get(s.id);
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) throw httpError(404, "المهمة المجدولة غير موجودة");
      const next = { ...cur };
      for (const k of ["name", "cron", "prompt"]) if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
      if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
      validateCron(next.cron, timezone);
      db.prepare("UPDATE schedules SET name=?, cron=?, prompt=?, enabled=?, updated_at=? WHERE id=?").run(next.name, next.cron, next.prompt, next.enabled, now(), id);
      schedule(get(id));
      return get(id);
    },
    remove(id) {
      unschedule(id);
      const r = db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
      if (!r.changes) throw httpError(404, "المهمة المجدولة غير موجودة");
      return { deleted: id };
    },
    runs(scheduleId, limit = 50) {
      return scheduleId
        ? db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?").all(scheduleId, limit)
        : db.prepare("SELECT r.*, s.name AS schedule_name FROM schedule_runs r LEFT JOIN schedules s ON s.id = r.schedule_id ORDER BY r.id DESC LIMIT ?").all(limit);
    },
    /** تشغيل يدوي فوري */
    async runNow(id) {
      const s = get(id);
      if (!s) throw httpError(404, "المهمة المجدولة غير موجودة");
      if (!runner) throw httpError(503, "المشغّل غير جاهز");
      db.prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?").run(now(), id);
      return runner(s);
    },
  };
}
