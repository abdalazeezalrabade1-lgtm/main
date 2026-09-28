// الاستخدام: npm run backup   (يعمل أثناء تشغيل الخادم أيضًا — VACUUM INTO آمن مع WAL)
import { loadDotEnv, buildConfig } from "../config.js";
import { openDb } from "../db.js";
import { runBackup } from "../services/backup.js";

loadDotEnv();
const config = buildConfig();
const db = openDb(config.dbPath);
try {
  const r = runBackup({ db, config, keep: config.backupKeep });
  console.log(`✅ نسخة احتياطية في: ${r.dir} (قاعدة البيانات ${(r.db_bytes / 1024).toFixed(1)} KB)`);
  if (r.removed.length) console.log(`حُذفت نسخ قديمة: ${r.removed.join(", ")}`);
} catch (e) {
  console.error(`❌ فشل النسخ الاحتياطي: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
