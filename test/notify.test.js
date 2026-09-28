import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, fakeClient, toolUse, say } from "./helpers.js";
import { loadIntegrations } from "../server/integrations/index.js";

async function telegramMock({ fail = false } = {}) {
  const messages = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      messages.push({ url: req.url, ...JSON.parse(body || "{}") });
      res.writeHead(fail ? 401 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fail ? { ok: false, description: "Unauthorized" } : { ok: true, result: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, messages, close: () => new Promise((r) => srv.close(r)) };
}

test("التشغيل المجدول: يُرسل النتيجة إلى Telegram، ولا يملك أدوات تعديل الجدولة", async () => {
  const tg = await telegramMock();
  const integrations = loadIntegrations({ TELEGRAM_BOT_TOKEN: "123:ABCsecret", TELEGRAM_CHAT_ID: "999", TELEGRAM_API_BASE: tg.url, PUBLIC_URL: "https://agent.example.sa" });
  const client = fakeClient((p, i) => (i === 0 ? toolUse("x", "schedule_create", { name: "a", cron: "0 9 * * *", prompt: "b" }) : say("ملخص: 3 منتجات رائجة")));
  const s = await startServer({ client, integrations });
  try {
    await s.login();
    const sch = (await s.req("POST", "/api/schedules", { name: "رصد", cron: "0 9 * * 0", prompt: "ارصد" })).json;
    const r = await s.scheduler.runNow(sch.id);
    assert.equal(r.status, "completed");
    const names = client.calls[0].tools.map((t) => t.name);
    assert.ok(!names.includes("schedule_create") && !names.includes("schedule_delete"));
    assert.ok(names.includes("schedule_list"));
    const tr = client.calls[1].messages.at(-1).content[0];
    assert.equal(tr.is_error, true, "حتى لو طلبها النموذج تُرفض");
    assert.equal(s.scheduler.list().length, 1, "لم تُنشأ مهمة جديدة");
    assert.equal(tg.messages.length, 1);
    assert.equal(tg.messages[0].chat_id, "999");
    assert.match(tg.messages[0].url, /\/bot123:ABCsecret\/sendMessage/);
    assert.match(tg.messages[0].text, /اكتملت — مهمة مجدولة: رصد/);
    assert.match(tg.messages[0].text, /3 منتجات رائجة/);
    assert.match(tg.messages[0].text, /https:\/\/agent\.example\.sa\/#conv-\d+/);
  } finally { await s.close(); await tg.close(); }
});

test("المحادثة المباشرة ما زالت تملك أدوات الجدولة", async () => {
  const client = fakeClient(() => say("ok"));
  const s = await startServer({ client });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "x" });
    assert.ok(client.calls[0].tools.some((t) => t.name === "schedule_create"));
  } finally { await s.close(); }
});

test("طلب الموافقة والمواعيد الفائتة تُرسل إشعارًا، وفشل Telegram لا يُفشل المهمة ولا يكشف الرمز", async () => {
  const tg = await telegramMock();
  const integrations = loadIntegrations({ TELEGRAM_BOT_TOKEN: "123:ABCsecret", TELEGRAM_CHAT_ID: "999", TELEGRAM_API_BASE: tg.url });
  const client = fakeClient((p, i) => (i === 0 ? toolUse("d", "memory_delete", { id: 1 }) : say("بانتظار الموافقة")));
  const s = await startServer({ client, integrations });
  try {
    await s.login();
    await s.req("POST", "/api/memory", { category: "fact", content: "قديمة" });
    await s.req("POST", "/api/chat", { message: "احذف 1" });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(tg.messages.at(-1).text, /طلب موافقة جديد #1/);
    const sch = (await s.req("POST", "/api/schedules", { name: "أسبوعي", cron: "0 9 * * 0", prompt: "p" })).json;
    s.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", sch.id);
    s.scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.match(tg.messages.at(-1).text, /فات موعد المهمة المجدولة «أسبوعي»/);
  } finally { await s.close(); await tg.close(); }

  const bad = await telegramMock({ fail: true });
  const integ2 = loadIntegrations({ TELEGRAM_BOT_TOKEN: "123:ABCsecret", TELEGRAM_CHAT_ID: "999", TELEGRAM_API_BASE: bad.url });
  const s2 = await startServer({ client: fakeClient(() => say("done")), integrations: integ2 });
  try {
    await s2.login();
    const sch = (await s2.req("POST", "/api/schedules", { name: "x", cron: "0 9 * * 0", prompt: "p" })).json;
    assert.equal((await s2.scheduler.runNow(sch.id)).status, "completed");
    const logs = (await s2.req("GET", "/api/logs?level=warn")).json;
    const n = logs.find((l) => l.type === "notify");
    assert.ok(n, "الفشل مسجَّل");
    assert.ok(!JSON.stringify(logs).includes("ABCsecret"), "الرمز غير مكشوف");
    const t = await s2.req("POST", "/api/integrations/telegram/test");
    assert.equal(t.status, 502);
  } finally { await s2.close(); await bad.close(); }
});
