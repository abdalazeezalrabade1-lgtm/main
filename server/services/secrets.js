// كشف الأسرار ومنع حفظها في الذاكرة، وتنقيحها من السجلات.
const PATTERNS = [
  { name: "anthropic_key", re: /sk-ant-[A-Za-z0-9_\-]{10,}/g },
  { name: "openai_like_key", re: /\bsk-[A-Za-z0-9_\-]{20,}/g },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi },
  { name: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

// عبارات تدل على أن النص يحمل كلمة مرور أو رمزًا سريًا
const KEYWORDS = /(password|passwd|pwd|passcode|api[_\s-]?key|secret|token|otp|pin\s*code|كلمة\s*(ال)?(مرور|سر)|الرقم\s*السري|رمز\s*(التحقق|الدخول)|كود\s*(التحقق|الدخول)|مفتاح\s*(ال)?api)\s*[:=：]?\s*\S+/i;

function luhnCardNumbers(text) {
  const found = [];
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) found.push(m[0]);
  }
  return found;
}

/** يعيد قائمة بأنواع الأسرار المكتشفة (فارغة إن لم يوجد شيء). */
export function detectSecrets(text) {
  if (!text) return [];
  const hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) hits.push(p.name);
  }
  if (KEYWORDS.test(text)) hits.push("credential_phrase");
  if (luhnCardNumbers(text).length) hits.push("card_number");
  return hits;
}

/** يستبدل الأسرار المعروفة بـ [REDACTED] قبل الكتابة في السجلات. */
export function redact(value) {
  if (value == null) return value;
  let s = typeof value === "string" ? value : JSON.stringify(value);
  for (const p of PATTERNS) s = s.replace(p.re, "[REDACTED]");
  for (const c of luhnCardNumbers(s)) s = s.replace(c, "[REDACTED_CARD]");
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "APP_PASSWORD", "SALLA_ACCESS_TOKEN", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_CLIENT_SECRET", "SMTP_PASS", "TELEGRAM_BOT_TOKEN"]) {
    const v = process.env[k];
    if (v && v.length >= 6) s = s.split(v).join("[REDACTED]");
  }
  return s;
}
