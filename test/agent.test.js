import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, fakeClient, sseEvents, toolUse, say } from "./helpers.js";

test("المسار الكامل: رسالة ← أداة إنشاء مهمة ← رد نهائي، مع بث SSE وحفظ السجل", async () => {
  const client = fakeClient((params, i) =>
    i === 0 ? toolUse("tu1", "task_create", { title: "متابعة عميل الجملة", priority: "high" }) : say("أنشأت المهمة ✓"));
  const s = await startServer({ client });
  try {
    await s.login();
    const r = await s.req("POST", "/api/chat", { message: "أضف مهمة متابعة عميل الجملة" });
    assert.equal(r.status, 200);
    const ev = sseEvents(r.text);
    const done = ev.find((e) => e.type === "done");
    assert.equal(done.status, "completed");
    assert.ok(ev.some((e) => e.type === "tool" && e.name === "task_create" && e.status === "done"));
    assert.ok(ev.some((e) => e.type === "text" && e.delta.includes("أنشأت")));
    const tasks = (await s.req("GET", "/api/tasks")).json;
    assert.equal(tasks[0].title, "متابعة عميل الجملة");
    // الطلب الثاني يحمل نتيجة الأداة، والتعليمات والأدوات مضبوطة
    const second = client.calls[1];
    assert.equal(second.messages.at(-1).content[0].type, "tool_result");
    assert.equal(second.system[0].cache_control.type, "ephemeral");
    assert.ok(second.tools.some((t) => t.name === "memory_save"));
    assert.ok(!second.tools.some((t) => t.name === "web_search"), "البحث غير مُعرّف ما لم يُفعَّل");
    assert.match(second.system[1].text, /البحث عبر الإنترنت: غير متاح/);
    // عرض المحادثة
    const convId = ev.find((e) => e.type === "conversation").conversationId;
    const conv = (await s.req("GET", `/api/conversations/${convId}`)).json;
    assert.equal(conv.messages.length, 2, "رسالة المستخدم + فقاعة رد واحدة مدمجة");
    assert.deepEqual(conv.messages[1].tools, ["task_create"]);
    const run = (await s.req("GET", "/api/runs")).json[0];
    assert.equal(run.steps, 2);
    assert.ok(run.cost_usd > 0);
  } finally { await s.close(); }
});

test("حد الخطوات يوقف الحلقة", async () => {
  const client = fakeClient((p, i) => toolUse(`t${i}`, "task_list", {}));
  const s = await startServer({ client, env: { MAX_STEPS_PER_RUN: "3" } });
  try {
    await s.login();
    const done = sseEvents((await s.req("POST", "/api/chat", { message: "حلقة" })).text).find((e) => e.type === "done");
    assert.equal(done.status, "limit_reached");
    assert.match(done.error, /خطوات/);
    assert.equal(client.calls.length, 3);
    // السجل يبقى صالحًا: كل tool_use يتبعه tool_result
    const hist = s.services.conversations.history(1);
    assert.equal(hist.at(-1).content[0].type, "tool_result");
  } finally { await s.close(); }
});

test("حد التكلفة لكل مهمة", async () => {
  const client = fakeClient((p, i) => ({ ...toolUse(`t${i}`, "task_list", {}), usage: { input_tokens: 200_000, output_tokens: 20_000 } }));
  const s = await startServer({ client, env: { MAX_COST_PER_RUN_USD: "0.5" } });
  try {
    await s.login();
    const done = sseEvents((await s.req("POST", "/api/chat", { message: "مكلف" })).text).find((e) => e.type === "done");
    assert.equal(done.status, "limit_reached");
    assert.match(done.error, /التكلفة/);
    assert.equal(client.calls.length, 1);
  } finally { await s.close(); }
});

test("الحد اليومي يمنع بدء مهمة جديدة", async () => {
  const client = fakeClient(() => ({ ...say("ok"), usage: { input_tokens: 400_000, output_tokens: 0 } }));
  const s = await startServer({ client, env: { DAILY_COST_LIMIT_USD: "1" } });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "1" });
    const r = await s.req("POST", "/api/chat", { message: "2" });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /اليومي/);
  } finally { await s.close(); }
});

test("زر الإيقاف يلغي الطلب الجاري ولا يحفظ ردًا جزئيًا", async () => {
  const client = fakeClient((p, i, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const s = await startServer({ client });
  try {
    await s.login();
    const chat = s.req("POST", "/api/chat", { message: "مهمة طويلة" });
    let active;
    for (let i = 0; i < 50 && !(active = s.agent.activeRuns()[0]); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(active, "المهمة نشطة");
    assert.equal((await s.req("POST", `/api/runs/${active.runId}/stop`)).status, 200);
    const done = sseEvents((await chat).text).find((e) => e.type === "done");
    assert.equal(done.status, "stopped");
    assert.equal(s.services.conversations.history(active.conversationId).length, 1, "رسالة المستخدم فقط");
    assert.equal((await s.req("POST", `/api/runs/${active.runId}/stop`)).status, 404);
  } finally { await s.close(); }
});

test("الحذف يتطلب موافقة: يُنشأ طلب ولا يُحذف حتى الموافقة", async () => {
  const client = fakeClient((p, i) => (i === 0 ? toolUse("d1", "memory_delete", { id: 1, reason: "قديمة" }) : say("أرسلت طلب الحذف للموافقة")));
  const s = await startServer({ client });
  try {
    await s.login();
    await s.req("POST", "/api/memory", { category: "fact", content: "معلومة قديمة" });
    const ev = sseEvents((await s.req("POST", "/api/chat", { message: "احذف المعلومة 1" })).text);
    assert.ok(ev.some((e) => e.type === "approval"));
    assert.equal((await s.req("GET", "/api/memory")).json.length, 1, "لم تُحذف بعد");
    const toolResult = JSON.parse(client.calls[1].messages.at(-1).content[0].content);
    assert.equal(toolResult.status, "pending_approval");
    const pending = (await s.req("GET", "/api/approvals?status=pending")).json;
    assert.equal(pending.length, 1);
    assert.match(pending[0].summary, /معلومة قديمة/);
    assert.equal((await s.req("POST", `/api/approvals/${pending[0].id}/approve`)).status, 200);
    assert.equal((await s.req("GET", "/api/memory")).json.length, 0);
    assert.equal((await s.req("POST", `/api/approvals/${pending[0].id}/approve`)).status, 409, "لا تنفيذ مزدوج");
  } finally { await s.close(); }
});

test("أخطاء الأدوات تُعاد للنموذج كـ is_error ولا توقف الحلقة", async () => {
  const client = fakeClient((p, i) => (i === 0 ? toolUse("m1", "memory_save", { category: "fact", content: "password: abc12345", certainty: "confirmed" }) : say("لم أحفظ السر")));
  const s = await startServer({ client });
  try {
    await s.login();
    const ev = sseEvents((await s.req("POST", "/api/chat", { message: "احفظ كلمة المرور" })).text);
    assert.equal(ev.find((e) => e.type === "done").status, "completed");
    const tr = client.calls[1].messages.at(-1).content[0];
    assert.equal(tr.is_error, true);
    assert.match(tr.content, /رُفض الحفظ/);
    assert.equal((await s.req("GET", "/api/memory")).json.length, 0);
    const logs = (await s.req("GET", "/api/logs")).json;
    assert.ok(logs.some((l) => l.type === "tool_error"));
    assert.ok(!JSON.stringify(logs).includes("sk-ant-test-0000000000000000"), "لا يظهر المفتاح في السجلات");
  } finally { await s.close(); }
});

test("فشل Claude API يُسجَّل ويُبلَّغ دون ادعاء النجاح", async () => {
  const client = fakeClient(() => { throw new Error("connect ECONNREFUSED"); });
  const s = await startServer({ client });
  try {
    await s.login();
    const done = sseEvents((await s.req("POST", "/api/chat", { message: "مرحبا" })).text).find((e) => e.type === "done");
    assert.equal(done.status, "failed");
    assert.match(done.error, /ECONNREFUSED/);
    assert.ok((await s.req("GET", "/api/logs?level=error")).json.some((l) => l.type === "run_failed"));
  } finally { await s.close(); }
});

test("الرفض (refusal) لا يُحفظ كرد", async () => {
  const client = fakeClient(() => ({ stop_reason: "refusal", content: [{ type: "text", text: "partial" }] }));
  const s = await startServer({ client });
  try {
    await s.login();
    const done = sseEvents((await s.req("POST", "/api/chat", { message: "x" })).text).find((e) => e.type === "done");
    assert.equal(done.status, "failed");
    assert.equal(s.services.conversations.history(1).length, 1);
  } finally { await s.close(); }
});

test("بدون مفتاح API: المحادثة ترجع 503 وبقية الأقسام تعمل", async () => {
  const s = await startServer({ withKey: false });
  try {
    await s.login();
    const r = await s.req("POST", "/api/chat", { message: "مرحبا" });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /ANTHROPIC_API_KEY/);
    const st = (await s.req("GET", "/api/status")).json;
    assert.equal(st.integrations.find((i) => i.id === "claude").connected, false);
    assert.equal(st.integrations.find((i) => i.id === "email").connected, false);
    assert.equal((await s.req("POST", "/api/tasks", { title: "تعمل بلا مفتاح" })).status, 201);
  } finally { await s.close(); }
});

test("البحث عبر الإنترنت: تعريف الأداة واستخراج المصادر وتواريخها", async () => {
  const client = fakeClient(() => ({
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } },
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "منتجات رائجة السعودية" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://example.com/a", title: "تقرير", page_age: "2 days ago", encrypted_content: "x" }] },
      { type: "text", text: "النتيجة", citations: [{ type: "web_search_result_location", url: "https://example.com/a", title: "تقرير", cited_text: "..." }] },
    ],
  }));
  const s = await startServer({ client, env: { WEB_SEARCH_ENABLED: "true" } });
  try {
    await s.login();
    const ev = sseEvents((await s.req("POST", "/api/chat", { message: "ابحث" })).text);
    assert.ok(client.calls[0].tools.some((t) => t.type === "web_search_20260209"));
    assert.match(client.calls[0].system[1].text, /متاح \(web_search\)/);
    assert.ok(ev.some((e) => e.type === "search" && e.query.includes("رائجة")));
    const src = ev.find((e) => e.type === "sources").items;
    assert.deepEqual(src, [{ title: "تقرير", url: "https://example.com/a", page_age: "2 days ago" }]);
    const run = (await s.req("GET", "/api/runs")).json[0];
    assert.equal(run.web_searches, 1);
    const conv = (await s.req("GET", "/api/conversations/1")).json;
    assert.equal(conv.messages[1].sources[0].page_age, "2 days ago");
  } finally { await s.close(); }
});

test("المرفقات تُمرَّر للنموذج كمستندات، وأداة إنشاء المستند تُنتج ملفًا للتنزيل", async () => {
  const client = fakeClient((p, i) =>
    i === 0 ? toolUse("doc", "document_create", { title: "تقرير المبيعات", format: "html", content: "<h1>ملخص</h1><p>سماعة: 120</p>" }) : say("جاهز"));
  const s = await startServer({ client });
  try {
    await s.login();
    const fd = new FormData();
    fd.append("files", new Blob(["المنتج,المبيعات\nسماعة,120\n"]), "مبيعات.csv");
    const up = (await s.req("POST", "/api/files", fd)).json.files[0];
    const ev = sseEvents((await s.req("POST", "/api/chat", { message: "حلّل الملف", fileIds: [up.id] })).text);
    const first = client.calls[0].messages[0].content;
    assert.equal(first[0].type, "document");
    assert.match(first[0].source.data, /سماعة/);
    assert.match(first[1].text, /مبيعات\.csv/);
    const file = ev.find((e) => e.type === "file").file;
    const dl = await s.req("GET", file.url);
    assert.equal(dl.status, 200);
    assert.match(dl.text, /dir="rtl"/);
    assert.match(dl.headers.get("content-disposition"), /attachment/);
    const inline = await s.req("GET", file.url + "?inline=1");
    assert.match(inline.headers.get("content-security-policy"), /sandbox/);
    assert.equal((await s.req("POST", "/api/chat", { message: "x", fileIds: [999] })).status, 404);
  } finally { await s.close(); }
});

test("لا يمكن تشغيل مهمتين في نفس المحادثة", async () => {
  let release;
  const client = fakeClient((p, i) => (i === 0 ? new Promise((r) => { release = () => r(say("تم")); }) : say("ok")));
  const s = await startServer({ client });
  try {
    await s.login();
    const first = s.req("POST", "/api/chat", { message: "أولى" });
    for (let i = 0; i < 50 && !s.agent.activeRuns().length; i++) await new Promise((r) => setTimeout(r, 20));
    const second = await s.req("POST", "/api/chat", { conversationId: s.agent.activeRuns()[0].conversationId, message: "ثانية" });
    assert.equal(second.status, 409);
    release();
    await first;
  } finally { await s.close(); }
});

test("المهام المجدولة: تشغيل فعلي مع سجل تنفيذ، وتسجيل المواعيد الفائتة", async () => {
  const client = fakeClient(() => say("تقرير: لا يمكن البحث لأن الأداة غير مفعلة"));
  const s = await startServer({ client });
  try {
    await s.login();
    const sch = (await s.req("POST", "/api/schedules", { name: "رصد الرائج", cron: "0 9 * * 0", prompt: "ارصد المنتجات الرائجة" })).json;
    const r = await s.scheduler.runNow(sch.id);
    assert.equal(r.status, "completed");
    assert.match(client.calls[0].system[1].text, /تشغيل مجدول تلقائي/);
    let runs = (await s.req("GET", `/api/schedules/${sch.id}/runs`)).json;
    assert.equal(runs[0].status, "completed");
    assert.match(runs[0].summary, /تقرير/);
    // محاكاة توقف الخادم وفوات الموعد
    s.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", sch.id);
    s.scheduler.start();
    runs = (await s.req("GET", `/api/schedules/${sch.id}/runs`)).json;
    assert.equal(runs[0].status, "missed");
    assert.ok(s.scheduler.isRunning);
    assert.ok(s.scheduler.get(sch.id).next_run_at > new Date().toISOString());
  } finally { await s.close(); }
});

test("fallbacks: عند التفعيل يُستخدم مسار beta مع fallbacks=default", async () => {
  const client = fakeClient(() => say("ok"));
  let betaParams;
  const orig = client.beta.messages.stream;
  client.beta.messages.stream = (p, o) => { betaParams = p; return orig(p, o); };
  const s = await startServer({ client, env: { CLAUDE_SERVER_FALLBACKS: "true" } });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "x" });
    assert.equal(betaParams.fallbacks, "default");
    assert.deepEqual(betaParams.betas, ["server-side-fallback-2026-07-01"]);
    assert.deepEqual(betaParams.thinking, { type: "adaptive" });
  } finally { await s.close(); }
});

test("تشغيل مجدول بلا مفتاح API يُسجَّل فاشلًا بوضوح ولا يدّعي التنفيذ", async () => {
  const s = await startServer({ withKey: false });
  try {
    await s.login();
    const sch = (await s.req("POST", "/api/schedules", { name: "x", cron: "0 9 * * 0", prompt: "y" })).json;
    const r = await s.scheduler.runNow(sch.id);
    assert.equal(r.status, "failed");
    const runs = (await s.req("GET", `/api/schedules/${sch.id}/runs`)).json;
    assert.equal(runs[0].status, "failed");
    assert.match(runs[0].error, /ANTHROPIC_API_KEY/);
    assert.equal((await s.req("GET", "/api/conversations")).json.length, 0);
  } finally { await s.close(); }
});
