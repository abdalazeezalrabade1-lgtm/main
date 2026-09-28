// مصادقة مستخدم واحد بكلمة مرور. الجلسة: رمز عشوائي في كوكي HttpOnly، ويُخزَّن تجزئته فقط.
import crypto from "node:crypto";
import { now } from "./db.js";

const COOKIE = "agent_session";
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, config) {
  if (typeof password !== "string" || !password) return false;
  if (config.appPasswordHash) {
    const [algo, saltHex, hashHex] = config.appPasswordHash.split("$");
    if (algo !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const got = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(expected, got);
  }
  if (config.appPassword) {
    const a = crypto.createHash("sha256").update(password).digest();
    const b = crypto.createHash("sha256").update(config.appPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

export const authConfigured = (config) => Boolean(config.appPassword || config.appPasswordHash);

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function makeAuth(db, config, logger) {
  const cookieAttrs = (maxAgeSec) =>
    `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secureCookies ? "; Secure" : ""}`;

  function tooManyAttempts(ip) {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    db.prepare("DELETE FROM login_attempts WHERE at < ?").run(since);
    return db.prepare("SELECT COUNT(*) c FROM login_attempts WHERE ip = ? AND at >= ?").get(ip, since).c >= MAX_ATTEMPTS;
  }

  return {
    login(req, res) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!authConfigured(config)) return res.status(500).json({ error: "لم تُضبط كلمة مرور (APP_PASSWORD أو APP_PASSWORD_HASH)." });
      if (tooManyAttempts(ip)) {
        logger.warn("auth", `محاولات دخول كثيرة من ${ip}`);
        return res.status(429).json({ error: "محاولات كثيرة. انتظر 15 دقيقة." });
      }
      if (!verifyPassword(req.body?.password, config)) {
        db.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)").run(ip, now());
        logger.warn("auth", `محاولة دخول فاشلة من ${ip}`);
        return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
      }
      db.prepare("DELETE FROM login_attempts WHERE ip = ?").run(ip);
      const token = crypto.randomBytes(32).toString("base64url");
      const ttl = config.sessionTtlHours * 3600;
      db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?,?,?)").run(sha(token), now(), new Date(Date.now() + ttl * 1000).toISOString());
      res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(ttl)}`);
      logger.info("auth", "تسجيل دخول ناجح");
      res.json({ ok: true });
    },
    logout(req, res) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
      res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieAttrs(0)}`);
      res.json({ ok: true });
    },
    isAuthenticated(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (!token) return false;
      const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(sha(token));
      if (!row) return false;
      if (row.expires_at < now()) { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token)); return false; }
      return true;
    },
    /** middleware: يحمي /api (عدا الدخول والصحة) ويفرض ترويسة مضادة لـ CSRF على الطلبات المعدِّلة */
    middleware() {
      return (req, res, next) => {
        if (!this.isAuthenticated(req)) return res.status(401).json({ error: "غير مصرح. سجّل الدخول." });
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "agent-ui") {
          return res.status(403).json({ error: "طلب مرفوض (ترويسة الحماية مفقودة)." });
        }
        next();
      };
    },
  };
}
