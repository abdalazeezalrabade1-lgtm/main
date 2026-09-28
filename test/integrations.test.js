import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { startServer, fakeClient, sseEvents, toolUse, say } from "./helpers.js";
import { loadIntegrations } from "../server/integrations/index.js";
import { officeToText } from "../server/services/files.js";

async function mock(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, data] = handler(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => new Promise((r) => srv.close(r)) };
}

test("Excel و Word: استخراج النص العربي", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("المبيعات");
  ws.addRow(["المنتج", "الكمية", "ملاحظة"]);
  ws.addRow(["سماعة", 120, "عرض, خاص"]);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  const t = await officeToText(xlsx, "xlsx");
  assert.match(t, /ورقة: المبيعات/);
  assert.match(t, /سماعة,120,"عرض, خاص"/);

  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>خطة التسويق للربع الرابع</w:t></w:r></w:p></w:body></w:document>`);
  const docx = await zip.generateAsync({ type: "nodebuffer" });
  assert.match(await officeToText(docx, "docx"), /خطة التسويق للربع الرابع/);

  // عبر الخادم: رفع xlsx ثم إرفاقه في المحادثة
  const client = fakeClient(() => say("تم التحليل"));
  const s = await startServer({ client });
  try {
    await s.login();
    const fd = new FormData();
    fd.append("files", new Blob([xlsx]), "مبيعات.xlsx");
    fd.append("files", new Blob([docx]), "خطة.docx");
    const up = await s.req("POST", "/api/files", fd);
    assert.equal(up.status, 201);
    assert.equal(up.json.files.length, 2);
    await s.req("POST", "/api/chat", { message: "حلّل", fileIds: up.json.files.map((f) => f.id) });
    const content = client.calls[0].messages[0].content;
    assert.match(content[0].source.data, /سماعة/);
    assert.match(content[1].source.data, /للربع الرابع/);
    // ملف xlsx تالف
    const bad = new FormData();
    bad.append("files", new Blob(["not a zip"]), "تالف.xlsx");
    const badId = (await s.req("POST", "/api/files", bad)).json.files[0].id;
    const r = await s.req("POST", "/api/chat", { message: "x", fileIds: [badId] });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /تعذّرت قراءة/);
  } finally { await s.close(); }
});

test("التكاملات غير المهيأة لا تظهر أدواتها للنموذج وتظهر «غير موصول»", async () => {
  const client = fakeClient(() => say("ok"));
  const s = await startServer({ client });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "x" });
    const names = client.calls[0].tools.map((t) => t.name);
    assert.ok(!names.some((n) => /^(salla|shopify|email)_/.test(n)));
    assert.match(client.calls[0].system[1].text, /متجر سلة \(قراءة فقط\): غير موصول/);
    const st = (await s.req("GET", "/api/status")).json.integrations;
    for (const id of ["salla", "shopify", "email"]) assert.equal(st.find((i) => i.id === id).connected, false);
    assert.equal((await s.req("POST", "/api/integrations/salla/test")).status, 400);
  } finally { await s.close(); }
});

test("سلة: قراءة الطلبات عبر API (خادم محاكٍ) مع تقليل البيانات الشخصية، واختبار الاتصال، وخطأ 401", async () => {
  let authOk = true;
  const api = await mock((req) => {
    if (!authOk) return [401, { status: 401, success: false, error: { code: "Unauthorized", message: "Unauthorized" } }];
    if (req.url.startsWith("/store/info")) return [200, { data: { id: 1, name: "متجر العطور", domain: "perfume.sa", currency: "SAR" } }];
    if (req.url.startsWith("/orders")) return [200, {
      data: [{ id: 11, reference_id: 275, total: { amount: 16.39, currency: "SAR" }, date: { date: "2026-09-02 18:08:47.000000" },
        status: { name: "قيد التنفيذ", slug: "in_progress" }, payment_method: "cod", items: [{ name: "عطر", quantity: 2 }],
        customer: { full_name: "محمد", city: "الرياض", mobile: 555, email: "a@b.c" } }],
      pagination: { total: 1, currentPage: 1, totalPages: 1 },
    }];
    return [404, {}];
  });
  const integrations = loadIntegrations({ SALLA_ACCESS_TOKEN: "salla-token-xyz", SALLA_API_BASE: api.url });
  const client = fakeClient((p, i) => (i === 0 ? toolUse("s1", "salla_orders_list", { from_date: "2026-09-01" }) : say("لديك طلب واحد")));
  const s = await startServer({ client, integrations });
  try {
    await s.login();
    const ev = sseEvents((await s.req("POST", "/api/chat", { message: "طلبات سبتمبر" })).text);
    assert.equal(ev.find((e) => e.type === "done").status, "completed");
    assert.ok(client.calls[0].tools.some((t) => t.name === "salla_orders_list"));
    assert.ok(!client.calls[0].tools.some((t) => t.name === "shopify_orders_list"));
    const req0 = api.requests[0];
    assert.equal(req0.headers.authorization, "Bearer salla-token-xyz");
    assert.match(req0.url, /from_date=2026-09-01/);
    assert.match(req0.url, /per_page=30/);
    const result = JSON.parse(client.calls[1].messages.at(-1).content[0].content);
    assert.deepEqual(result.orders[0].customer, { name: "محمد", city: "الرياض" });
    assert.equal(result.orders[0].total, "16.39 SAR");
    assert.equal(result.orders[0].status, "قيد التنفيذ");
    const t = await s.req("POST", "/api/integrations/salla/test");
    assert.equal(t.status, 200);
    assert.match(t.json.message, /متجر العطور/);
    authOk = false;
    const t2 = await s.req("POST", "/api/integrations/salla/test");
    assert.equal(t2.status, 502);
    assert.match(t2.json.error, /غير صالح أو منتهي/);
    const logs = JSON.stringify((await s.req("GET", "/api/logs")).json);
    assert.ok(!logs.includes("salla-token-xyz"), "الرمز لا يظهر في السجلات");
  } finally { await s.close(); await api.close(); }
});

test("Shopify: client credentials ثم GraphQL، مع تخزين الرمز مؤقتًا", async () => {
  const api = await mock((req, body) => {
    if (req.url === "/admin/oauth/access_token") {
      const p = new URLSearchParams(body);
      return p.get("client_secret") === "sec" ? [200, { access_token: "shpat_tmp", scope: "read_orders", expires_in: 86399 }] : [400, { error: "invalid_client" }];
    }
    if (req.url === "/admin/api/2026-07/graphql.json") {
      if (req.headers["x-shopify-access-token"] !== "shpat_tmp") return [401, { errors: "Invalid API key" }];
      const q = JSON.parse(body).query;
      if (q.includes("shop {")) return [200, { data: { shop: { name: "Aziz Store", currencyCode: "SAR", myshopifyDomain: "aziz.myshopify.com" } } }];
      return [200, { data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        name: "#1001", createdAt: "2026-09-20T10:00:00Z", displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", cancelledAt: null,
        totalPriceSet: { shopMoney: { amount: "250.0", currencyCode: "SAR" } }, shippingAddress: { city: "جدة", countryCode: "SA" },
        lineItems: { nodes: [{ title: "ساعة", quantity: 1 }] } }] } } }];
    }
    return [404, {}];
  });
  const integrations = loadIntegrations({ SHOPIFY_SHOP: "aziz.myshopify.com", SHOPIFY_CLIENT_ID: "cid", SHOPIFY_CLIENT_SECRET: "sec", SHOPIFY_BASE_URL: api.url });
  const shopify = integrations.find((i) => i.id === "shopify");
  assert.ok(shopify.configured);
  assert.match(await shopify.test(), /Aziz Store/);
  const r = await shopify.tools.shopify_orders_list.run({ query: "created_at:>=2026-09-01", first: 999 });
  assert.equal(r.orders[0].total, "250.0 SAR");
  assert.equal(r.orders[0].city, "جدة");
  const gqlReq = api.requests.filter((x) => x.url.includes("graphql")).at(-1);
  assert.equal(JSON.parse(gqlReq.body).variables.first, 50, "الحد الأقصى 50");
  assert.equal(api.requests.filter((x) => x.url.includes("oauth")).length, 1, "الرمز يُطلب مرة واحدة ويُعاد استخدامه");
  const bad = loadIntegrations({ SHOPIFY_SHOP: "x", SHOPIFY_CLIENT_ID: "cid", SHOPIFY_CLIENT_SECRET: "wrong", SHOPIFY_BASE_URL: api.url }).find((i) => i.id === "shopify");
  await assert.rejects(bad.test(), /Shopify/);
  await api.close();
});

test("البريد: الإرسال لا يتم إلا بعد الموافقة، والعناوين الخاطئة تُرفض قبل إنشاء الطلب", async () => {
  const sent = [];
  const transportFactory = () => ({ sendMail: async (m) => { sent.push(m); return { messageId: "<id1>", accepted: [m.to], rejected: [] }; }, verify: async () => true });
  const env = { SMTP_HOST: "smtp.test", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "Aziz <a@test.sa>" };
  const integrations = loadIntegrations(env, { email: { transportFactory } });
  const client = fakeClient((p, i) => [
    toolUse("e0", "email_send", { to: ["not-an-email"], subject: "x", body: "y" }),
    toolUse("e1", "email_send", { to: ["client@example.com"], subject: "عرض الجملة", body: "السلام عليكم،\nمرفق عرض الأسعار." }),
    say("الرسالة بانتظار موافقتك"),
  ][i]);
  const s = await startServer({ client, integrations });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "أرسل العرض للعميل" });
    const bad = client.calls[1].messages.at(-1).content[0];
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /غير صالحة/);
    const pending = (await s.req("GET", "/api/approvals?status=pending")).json;
    assert.equal(pending.length, 1, "طلب واحد فقط للعنوان الصحيح");
    assert.equal(sent.length, 0, "لم يُرسل شيء قبل الموافقة");
    assert.match(pending[0].summary, /client@example.com/);
    const ok = await s.req("POST", `/api/approvals/${pending[0].id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, "Aziz <a@test.sa>");
    assert.equal(sent[0].to, "client@example.com");
    assert.equal(sent[0].subject, "عرض الجملة");
    assert.equal(JSON.parse(ok.json.result_json).sent, true);
    assert.equal((await s.req("POST", "/api/integrations/email/test")).json.ok, true);
  } finally { await s.close(); }
});

test("رفض طلب البريد لا يرسل شيئًا", async () => {
  const sent = [];
  const integrations = loadIntegrations({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "a@b.sa" }, { email: { transportFactory: () => ({ sendMail: async (m) => { sent.push(m); return {}; } }) } });
  const client = fakeClient((p, i) => (i === 0 ? toolUse("e1", "email_send", { to: ["x@y.com"], subject: "s", body: "b" }) : say("ok")));
  const s = await startServer({ client, integrations });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "أرسل" });
    const p = (await s.req("GET", "/api/approvals?status=pending")).json[0];
    assert.equal((await s.req("POST", `/api/approvals/${p.id}/reject`)).json.status, "rejected");
    assert.equal(sent.length, 0);
    assert.equal((await s.req("POST", `/api/approvals/${p.id}/approve`)).status, 409);
  } finally { await s.close(); }
});

test("ضغط السياق (اختياري) يضيف beta و context_management، والمحادثة الطويلة تُنبَّه عند تعطيله", async () => {
  const client = fakeClient(() => say("ok"));
  let betaParams;
  const orig = client.beta.messages.stream;
  client.beta.messages.stream = (p, o) => { betaParams = p; return orig(p, o); };
  const s = await startServer({ client, env: { CLAUDE_COMPACTION: "true" } });
  try {
    await s.login();
    await s.req("POST", "/api/chat", { message: "x" });
    assert.deepEqual(betaParams.betas, ["compact-2026-01-12"]);
    assert.deepEqual(betaParams.context_management, { edits: [{ type: "compact_20260112" }] });
  } finally { await s.close(); }

  const s2 = await startServer({ client: fakeClient(() => say("ok")) });
  try {
    await s2.login();
    const conv = s2.services.conversations.create("طويلة");
    s2.services.conversations.addMessage(conv.id, "user", [{ type: "text", text: "أ".repeat(510_000) }]);
    s2.services.conversations.addMessage(conv.id, "assistant", [{ type: "text", text: "ok" }]);
    const ev = sseEvents((await s2.req("POST", "/api/chat", { conversationId: conv.id, message: "تابع" })).text);
    assert.ok(ev.some((e) => e.type === "notice" && /طويلة جدًا/.test(e.message)));
  } finally { await s2.close(); }
});
