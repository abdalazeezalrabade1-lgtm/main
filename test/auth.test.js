import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, PASSWORD } from "./helpers.js";
import { hashPassword, verifyPassword } from "../server/auth.js";

test("المسارات المحمية ترفض الطلب دون جلسة، والدخول الصحيح يفتحها", async () => {
  const s = await startServer();
  try {
    assert.equal((await s.req("GET", "/api/status")).status, 401);
    assert.equal((await s.req("GET", "/api/memory")).status, 401);
    assert.equal((await s.req("GET", "/api/health")).status, 200);
    const bad = await fetch(s.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
    assert.equal(bad.status, 401);
    assert.equal(await s.login(), 200);
    assert.equal((await s.req("GET", "/api/status")).status, 200);
    // الطلبات المعدِّلة تتطلب ترويسة الحماية
    const noHeader = await s.req("POST", "/api/memory", { category: "fact", content: "x" }, { "X-Requested-With": "" });
    assert.equal(noHeader.status, 403);
    // تسجيل الخروج يبطل الجلسة
    await s.req("POST", "/api/logout");
    assert.equal((await s.req("GET", "/api/status")).status, 401);
  } finally { await s.close(); }
});

test("تقييد محاولات الدخول بعد 5 محاولات فاشلة", async () => {
  const s = await startServer();
  try {
    const attempt = (pw) => fetch(s.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    for (let i = 0; i < 5; i++) assert.equal((await attempt("nope")).status, 401);
    assert.equal((await attempt(PASSWORD)).status, 429, "حتى كلمة المرور الصحيحة تُرفض أثناء الحظر المؤقت");
  } finally { await s.close(); }
});

test("تجزئة كلمة المرور scrypt", () => {
  const h = hashPassword("very-strong-pass");
  assert.ok(verifyPassword("very-strong-pass", { appPasswordHash: h }));
  assert.ok(!verifyPassword("wrong", { appPasswordHash: h }));
  assert.ok(!verifyPassword("", { appPassword: "" }));
});

test("سطر hash-password يُقرأ حرفيًا من .env (علامات اقتباس تحمي $)", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { loadDotEnv } = await import("../server/config.js");
  const line = execFileSync(process.execPath, ["server/cli/hash-password.js", "كلمة-مرور-قوية-123"], { encoding: "utf8" }).trim();
  assert.match(line, /^APP_PASSWORD_HASH='scrypt\$[0-9a-f]+\$[0-9a-f]+'$/);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "env-")), ".env");
  fs.writeFileSync(f, line + "\n");
  const before = process.env.APP_PASSWORD_HASH;
  delete process.env.APP_PASSWORD_HASH;
  loadDotEnv(f);
  const hash = process.env.APP_PASSWORD_HASH;
  if (before === undefined) delete process.env.APP_PASSWORD_HASH; else process.env.APP_PASSWORD_HASH = before;
  assert.ok(verifyPassword("كلمة-مرور-قوية-123", { appPasswordHash: hash }));
});
