import { loadDotEnv, buildConfig } from "./config.js";
import { authConfigured } from "./auth.js";
import { createApp } from "./app.js";
import { scheduleBackups } from "./services/backup.js";

loadDotEnv();
const config = buildConfig();

if (!authConfigured(config)) {
  console.error("❌ لم تُضبط كلمة مرور. ضع APP_PASSWORD (أو APP_PASSWORD_HASH عبر: npm run hash-password -- \"...\") في ملف .env");
  process.exit(1);
}
if (config.appPassword && config.appPassword.length < 10) console.warn("⚠️  APP_PASSWORD أقصر من 10 أحرف — استخدم كلمة أقوى قبل الإتاحة عبر الإنترنت.");
if (!["127.0.0.1", "localhost", "::1"].includes(config.host) && !config.secureCookies) {
  console.warn("⚠️  الخادم متاح خارج الجهاز دون SECURE_COOKIES=true. ضعه خلف HTTPS (reverse proxy) قبل الإتاحة عبر الإنترنت.");
}
if (!config.hasApiKey) console.warn("⚠️  ANTHROPIC_API_KEY غير مضبوط: الواجهة والذاكرة والمهام تعمل، لكن المحادثة مع الوكيل معطّلة.");

const { app, scheduler, logger, db } = createApp({ config });
scheduler.start();
let backupJob = null;
try { backupJob = scheduleBackups({ db, config, logger }); } catch (e) { console.error(`❌ BACKUP_CRON غير صالح: ${e.message}`); }

const server = app.listen(config.port, config.host, () => {
  console.log(`✅ الوكيل يعمل على http://${config.host}:${config.port}  (النموذج: ${config.model}، البحث: ${config.webSearchEnabled ? "مفعّل" : "معطّل"})`);
  logger.info("server", "بدء تشغيل الخادم");
});

function shutdown(sig) {
  logger.info("server", `إيقاف الخادم (${sig}) — المهام المجدولة لن تعمل حتى إعادة التشغيل`);
  scheduler.stop();
  backupJob?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
