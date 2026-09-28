import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../server/config.js";
import { createApp } from "../server/app.js";

export const PASSWORD = "test-password-123";

/** عميل Claude وهمي: script دالة (params, callIndex) => message أو Promise */
export function fakeClient(script) {
  const calls = [];
  const makeStream = (params, opts = {}) => {
    calls.push(params);
    const handlers = {};
    const idx = calls.length - 1;
    const final = (async () => {
      const msg = await script(params, idx, opts.signal);
      for (const b of msg.content || []) if (b.type === "text") handlers.text?.(b.text);
      return { model: params.model, usage: { input_tokens: 100, output_tokens: 50 }, ...msg };
    })();
    return { on(ev, cb) { handlers[ev] = cb; return this; }, finalMessage: () => final };
  };
  return { calls, messages: { stream: makeStream }, beta: { messages: { stream: makeStream } } };
}

export async function startServer({ client = null, env = {}, withKey = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  const config = buildConfig({
    APP_PASSWORD: PASSWORD, DATA_DIR: dataDir, CLAUDE_SERVER_FALLBACKS: "false",
    ANTHROPIC_API_KEY: withKey ? "sk-ant-test-0000000000000000" : "", ...env,
  });
  const ctx = createApp({ config, client });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const req = async (method, p, body, headers = {}) => {
    const h = { "X-Requested-With": "agent-ui", ...(cookie ? { Cookie: cookie } : {}), ...headers };
    let b = body;
    if (body && !(body instanceof FormData)) { h["Content-Type"] = "application/json"; b = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body: b });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE أو نص */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async () => {
    const res = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    cookie = res.headers.get("set-cookie").split(";")[0];
    return res.status;
  };
  const close = async () => {
    ctx.scheduler.stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { ...ctx, config, base, req, login, close, setCookie: (c) => { cookie = c; } };
}

/** يحلل استجابة SSE إلى مصفوفة أحداث */
export const sseEvents = (text) => text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));

export const toolUse = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
export const say = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
