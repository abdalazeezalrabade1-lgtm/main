// كل الإعدادات من متغيرات البيئة. لا تُطبع القيم السرية في أي سجل.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// تحميل بسيط لملف .env إن وُجد (دون تبعية إضافية). لا يطغى على متغيرات البيئة الموجودة.
export function loadDotEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(String(v).toLowerCase()));

export function buildConfig(env = process.env) {
  const dataDir = path.resolve(ROOT, env.DATA_DIR || "data");
  const model = env.CLAUDE_MODEL || "claude-opus-5";
  return {
    root: ROOT,
    host: env.HOST || "127.0.0.1",
    port: num(env.PORT, 3000),
    dataDir,
    dbPath: path.join(dataDir, "agent.db"),
    uploadsDir: path.join(dataDir, "uploads"),
    outputsDir: path.join(dataDir, "outputs"),
    // المصادقة
    appPassword: env.APP_PASSWORD || "",
    appPasswordHash: env.APP_PASSWORD_HASH || "",
    sessionTtlHours: num(env.SESSION_TTL_HOURS, 72),
    secureCookies: bool(env.SECURE_COOKIES, false),
    // Claude
    hasApiKey: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model,
    effort: env.CLAUDE_EFFORT || "high",
    maxTokens: num(env.CLAUDE_MAX_TOKENS, 16000),
    // fallbacks: "default" مدعوم على claude-opus-5 عبر واجهة beta
    serverFallbacks: bool(env.CLAUDE_SERVER_FALLBACKS, model === "claude-opus-5"),
    // ضغط سياق المحادثات الطويلة على خادم Anthropic (beta) — معطّل افتراضيًا
    compaction: bool(env.CLAUDE_COMPACTION, false),
    // البحث عبر الإنترنت (أداة web_search من Anthropic؛ يجب تفعيلها في Console للمؤسسة)
    webSearchEnabled: bool(env.WEB_SEARCH_ENABLED, false),
    webSearchMaxUses: num(env.WEB_SEARCH_MAX_USES, 5),
    // الحدود الافتراضية (قابلة للتعديل من الواجهة)
    limits: {
      maxSteps: num(env.MAX_STEPS_PER_RUN, 12),
      maxCostPerRunUsd: num(env.MAX_COST_PER_RUN_USD, 0.5),
      dailyCostLimitUsd: num(env.DAILY_COST_LIMIT_USD, 5),
    },
    // تسعير مخصص لنموذج غير موجود في الجدول ($ لكل مليون توكن)
    priceOverride: env.PRICE_INPUT_PER_MTOK && env.PRICE_OUTPUT_PER_MTOK
      ? { input: Number(env.PRICE_INPUT_PER_MTOK), output: Number(env.PRICE_OUTPUT_PER_MTOK) }
      : null,
    maxUploadMb: num(env.MAX_UPLOAD_MB, 15),
    schedulerEnabled: bool(env.SCHEDULER_ENABLED, true),
    timezone: env.TZ_NAME || "Asia/Riyadh",
  };
}
