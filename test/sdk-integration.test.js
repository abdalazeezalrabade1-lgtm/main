// يختبر المسار الحقيقي عبر @anthropic-ai/sdk ضد خادم محلي يحاكي Messages API (بث SSE) — دون مفتاح حقيقي.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { startServer, sseEvents } from "./helpers.js";

function sseMessage(res, content, stopReason) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const w = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  w("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1 } } });
  content.forEach((b, index) => {
    if (b.type === "text") {
      w("content_block_start", { index, content_block: { type: "text", text: "" } });
      w("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      w("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      w("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    w("content_block_stop", { index });
  });
  w("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 200 } });
  w("message_stop", {});
  res.end();
}

async function mockApi(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { const r = { headers: req.headers, body: JSON.parse(body || "{}") }; requests.push(r); handler(r, res, requests.length - 1); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

test("SDK حقيقي: بث، استدعاء أداة، fallbacks عبر beta header", async () => {
  const api = await mockApi((r, res, i) => {
    if (i === 0) sseMessage(res, [{ type: "tool_use", id: "toolu_1", name: "project_create", input: { name: "متجر العطور" } }], "tool_use");
    else sseMessage(res, [{ type: "text", text: "أنشأت المشروع." }], "end_turn");
  });
  const client = new Anthropic({ apiKey: "sk-ant-test-dummy-key-000000", baseURL: api.url, maxRetries: 0 });
  const s = await startServer({ client, env: { CLAUDE_SERVER_FALLBACKS: "true" } });
  try {
    await s.login();
    const ev = sseEvents((await s.req("POST", "/api/chat", { message: "أنشئ مشروع متجر العطور" })).text);
    assert.equal(ev.find((e) => e.type === "done").status, "completed");
    assert.equal(s.services.tasks.listProjects()[0].name, "متجر العطور");
    assert.equal(api.requests.length, 2);
    const first = api.requests[0];
    assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(first.body.fallbacks, "default");
    assert.equal(first.body.stream, true);
    assert.equal(first.body.model, "claude-opus-5");
    assert.deepEqual(first.body.output_config, { effort: "high" });
    assert.equal(api.requests[1].body.messages.at(-1).content[0].type, "tool_result");
    assert.ok((await s.req("GET", "/api/runs")).json[0].cost_usd > 0);
  } finally { await s.close(); await api.close(); }
});

test("SDK حقيقي: الإيقاف يقطع الاتصال الجاري", async () => {
  const api = await mockApi((r, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
    // لا ننهي الاستجابة — نحاكي توليدًا طويلًا
  });
  const client = new Anthropic({ apiKey: "sk-ant-test-dummy-key-000000", baseURL: api.url, maxRetries: 0 });
  const s = await startServer({ client });
  try {
    await s.login();
    const chat = s.req("POST", "/api/chat", { message: "طويل" });
    let active;
    for (let i = 0; i < 100 && !(active = s.agent.activeRuns()[0]); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    await s.req("POST", `/api/runs/${active.runId}/stop`);
    const done = sseEvents((await chat).text).find((e) => e.type === "done");
    assert.equal(done.status, "stopped");
  } finally { await s.close(); await api.close(); }
});

test("SDK حقيقي: مفتاح غير صالح يعطي رسالة واضحة", async () => {
  const api = await mockApi((r, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  });
  const client = new Anthropic({ apiKey: "sk-ant-test-dummy-key-000000", baseURL: api.url, maxRetries: 0 });
  const s = await startServer({ client });
  try {
    await s.login();
    const done = sseEvents((await s.req("POST", "/api/chat", { message: "x" })).text).find((e) => e.type === "done");
    assert.equal(done.status, "failed");
    assert.match(done.error, /مفتاح Claude API غير صالح/);
  } finally { await s.close(); await api.close(); }
});
