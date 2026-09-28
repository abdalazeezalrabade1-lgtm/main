import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";
import { detectSecrets, redact } from "../server/services/secrets.js";
import { validateCron } from "../server/services/scheduler.js";
import { costOfUsage } from "../server/services/pricing.js";

test("كشف الأسرار", () => {
  assert.ok(detectSecrets("my key is sk-ant-api03-abcdefghijklmnop").length);
  assert.ok(detectSecrets("كلمة المرور: Abc12345").length);
  assert.ok(detectSecrets("password=hunter2").length);
  assert.ok(detectSecrets("بطاقتي 4111 1111 1111 1111").length);
  assert.deepEqual(detectSecrets("أفضّل التقارير المختصرة بجداول"), []);
  assert.deepEqual(detectSecrets("مبيعات الربع الثالث 1250000 ريال"), []);
  assert.ok(!redact("token sk-ant-api03-abcdefghijklmnop end").includes("abcdefghijklmnop"));
});

test("الذاكرة: إضافة وتعديل وحذف ورفض الأسرار وتمييز المؤكد", async () => {
  const s = await startServer();
  try {
    await s.login();
    const a = await s.req("POST", "/api/memory", { category: "preference", content: "أفضّل الردود المختصرة" });
    assert.equal(a.status, 201);
    assert.equal(a.json.certainty, "confirmed");
    const secret = await s.req("POST", "/api/memory", { category: "fact", content: "كلمة السر للمتجر: Qw12345!" });
    assert.equal(secret.status, 422);
    const b = await s.req("POST", "/api/memory", { category: "project", content: "يبدو أنه يركز على الإلكترونيات", certainty: "inferred" });
    const block = s.services.memory.promptBlock();
    assert.ok(block.indexOf("أفضّل الردود") < block.indexOf("استنتاجات"));
    assert.ok(block.indexOf("الإلكترونيات") > block.indexOf("استنتاجات"));
    const upd = await s.req("PATCH", `/api/memory/${b.json.id}`, { certainty: "confirmed" });
    assert.equal(upd.json.certainty, "confirmed");
    const updSecret = await s.req("PATCH", `/api/memory/${b.json.id}`, { content: "api_key=sk-ant-xxxxxxxxxxxxxxxxxxxx" });
    assert.equal(updSecret.status, 422);
    assert.equal((await s.req("DELETE", `/api/memory/${a.json.id}`)).status, 200);
    assert.equal((await s.req("DELETE", `/api/memory/${a.json.id}`)).status, 404);
    assert.equal((await s.req("GET", "/api/memory")).json.length, 1);
  } finally { await s.close(); }
});

test("المهام والمشاريع: إنشاء وتحديث الحالة والتحقق من المدخلات", async () => {
  const s = await startServer();
  try {
    await s.login();
    const p = await s.req("POST", "/api/projects", { name: "حملة الجمعة البيضاء" });
    assert.equal(p.status, 201);
    const t = await s.req("POST", "/api/tasks", { title: "تجهيز العروض", priority: "urgent", due_at: "2020-01-01T09:00:00+03:00", project_id: p.json.id });
    assert.equal(t.status, 201);
    assert.equal(t.json.project_name, "حملة الجمعة البيضاء");
    assert.equal((await s.req("POST", "/api/tasks", { title: "" })).status, 400);
    assert.equal((await s.req("POST", "/api/tasks", { title: "x", priority: "super" })).status, 400);
    assert.equal((await s.req("POST", "/api/tasks", { title: "x", project_id: 999 })).status, 400);
    assert.equal((await s.req("POST", "/api/tasks", { title: "x", due_at: "not a date" })).status, 400);
    const st = await s.req("GET", "/api/status");
    assert.equal(st.json.tasks.overdue, 1);
    const done = await s.req("PATCH", `/api/tasks/${t.json.id}`, { status: "done" });
    assert.ok(done.json.completed_at);
    assert.equal((await s.req("GET", "/api/tasks")).json.length, 0, "المنجزة لا تظهر افتراضيًا");
    assert.equal((await s.req("GET", "/api/tasks?include_closed=true")).json.length, 1);
    assert.equal((await s.req("GET", "/api/tasks/abc")).status, 404);
    assert.equal((await s.req("PATCH", "/api/tasks/abc", {})).status, 400);
  } finally { await s.close(); }
});

test("الملفات: رفض الأنواع غير المدعومة وقبول النصوص بأسماء عربية", async () => {
  const s = await startServer();
  try {
    await s.login();
    const fd = new FormData();
    fd.append("files", new Blob(["MZ..."]), "virus.exe");
    const bad = await s.req("POST", "/api/files", fd);
    assert.equal(bad.status, 415);
    const fd2 = new FormData();
    fd2.append("files", new Blob(["المنتج,المبيعات\nسماعة,120\n"], { type: "text/csv" }), "مبيعات.csv");
    const ok = await s.req("POST", "/api/files", fd2);
    assert.equal(ok.status, 201);
    assert.equal(ok.json.files[0].name, "مبيعات.csv");
    assert.equal(ok.json.files[0].stored_name, undefined, "لا يُكشف اسم التخزين الداخلي");
    const dl = await fetch(`${s.base}/api/files/${ok.json.files[0].id}/download`);
    assert.equal(dl.status, 401, "التنزيل يتطلب جلسة");
  } finally { await s.close(); }
});

test("الجدولة: التحقق من cron والحد الأدنى للفاصل", async () => {
  assert.throws(() => validateCron("bad", "Asia/Riyadh"), /5 حقول/);
  assert.throws(() => validateCron("* * * * *", "Asia/Riyadh"), /15 دقيقة/);
  assert.ok(validateCron("0 9 * * 0", "Asia/Riyadh"));
  const s = await startServer();
  try {
    await s.login();
    assert.equal((await s.req("POST", "/api/schedules", { name: "x", cron: "*/5 * * * *", prompt: "y" })).status, 400);
    const ok = await s.req("POST", "/api/schedules", { name: "رصد", cron: "0 9 * * 0", prompt: "ابحث" });
    assert.equal(ok.status, 201);
    assert.ok(ok.json.next_run_at);
  } finally { await s.close(); }
});

test("الحدود: التحقق من القيم", async () => {
  const s = await startServer();
  try {
    await s.login();
    assert.equal((await s.req("PUT", "/api/settings/limits", { maxSteps: 0 })).status, 400);
    assert.equal((await s.req("PUT", "/api/settings/limits", { maxSteps: 5, dailyCostLimitUsd: 2 })).json.maxSteps, 5);
  } finally { await s.close(); }
});

test("حساب التكلفة", () => {
  const c = costOfUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000, server_tool_use: { web_search_requests: 10 } }, "claude-opus-5");
  assert.equal(Number(c.toFixed(2)), 30.1);
  assert.ok(costOfUsage({ input_tokens: 1e6 }, "unknown-model") >= 10, "النموذج المجهول يُسعَّر بتحفّظ");
});
