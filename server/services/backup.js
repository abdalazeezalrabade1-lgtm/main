// نسخ احتياطي: لقطة متسقة لقاعدة البيانات (VACUUM INTO) + نسخ الملفات، مع الاحتفاظ بآخر N نسخة.
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";

export function runBackup({ db, config, keep = 14 }) {
  const root = config.backupDir;
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(root, `backup-${stamp}`);
  fs.mkdirSync(dir);
  const dbFile = path.join(dir, "agent.db");
  db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  for (const sub of ["uploads", "outputs"]) {
    const src = sub === "uploads" ? config.uploadsDir : config.outputsDir;
    const tmp = path.join(src, "tmp"); // ملفات رفع غير مكتملة
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, sub), { recursive: true, filter: (p) => p !== tmp && !p.startsWith(tmp + path.sep) });
  }
  // تنظيف النسخ القديمة
  const all = fs.readdirSync(root).filter((n) => n.startsWith("backup-")).sort();
  const removed = [];
  while (all.length > keep) {
    const old = all.shift();
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
    removed.push(old);
  }
  const size = fs.statSync(dbFile).size;
  return { dir, db_bytes: size, removed };
}

/** نسخ احتياطي تلقائي داخل الخادم إن ضُبط BACKUP_CRON */
export function scheduleBackups({ db, config, logger }) {
  if (!config.backupCron) return null;
  const job = new Cron(config.backupCron, { timezone: config.timezone, protect: true }, () => {
    try {
      const r = runBackup({ db, config, keep: config.backupKeep });
      logger.info("backup", `نسخة احتياطية: ${r.dir}`, { db_bytes: r.db_bytes, removed: r.removed });
    } catch (e) {
      logger.error("backup", `فشل النسخ الاحتياطي: ${e.message}`);
    }
  });
  logger.info("backup", `النسخ الاحتياطي التلقائي مفعّل (${config.backupCron})`);
  return job;
}
