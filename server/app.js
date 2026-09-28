// تجميع الخادم: الخدمات + الوكيل + المسارات. createApp قابلة للاختبار بعميل Claude وهمي.
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { openDb, now } from "./db.js";
import { makeAuth, authConfigured } from "./auth.js";
import { makeLogger } from "./services/logs.js";
import { makeSettings } from "./services/settings.js";
import { makeMemory } from "./services/memory.js";
import { makeTasks } from "./services/tasks.js";
import { makeFiles } from "./services/files.js";
import { makeConversations } from "./services/conversations.js";
import { makeApprovals } from "./services/approvals.js";
import { makeScheduler } from "./services/scheduler.js";
import { integrationsStatus } from "./services/integrations.js";
import { buildTools } from "./agent/tools.js";
import { createAgent, extractSources } from "./agent/agent.js";

const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("معرّف غير صالح"), { status: 400 });
  return n;
};

/** تحويل رسائل Messages API إلى عناصر عرض (دون بيانات base64 أو تفكير داخلي) */
function renderMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "user") {
      if (content.every((b) => b.type === "tool_result")) continue; // نتائج أدوات داخلية
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const attachments = content.filter((b) => b.type === "document" || b.type === "image").map((b) => b.title || (b.type === "image" ? "صورة" : "مستند"));
      out.push({ id: m.id, role: "user", text, attachments, created_at: m.created_at });
    } else {
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolsUsed = content.filter((b) => b.type === "tool_use" || b.type === "server_tool_use").map((b) => (b.name === "web_search" ? `بحث: ${b.input?.query ?? ""}` : b.name));
      const sources = extractSources(content);
      const last = out[out.length - 1];
      // دمج خطوات نفس التشغيل في فقاعة واحدة
      if (last && last.role === "assistant" && last.run_id === m.run_id) {
        if (text) last.text += (last.text ? "\n\n" : "") + text;
        last.tools.push(...toolsUsed);
        for (const s of sources) if (!last.sources.some((x) => x.url === s.url)) last.sources.push(s);
      } else {
        out.push({ id: m.id, role: "assistant", run_id: m.run_id, text, tools: toolsUsed, sources, created_at: m.created_at });
      }
    }
  }
  return out;
}

export function createApp({ config, client, db: providedDb } = {}) {
  const db = providedDb || openDb(config.dbPath);
  const logger = makeLogger(db);
  const settings = makeSettings(db, config.limits);
  const memory = makeMemory(db);
  const tasks = makeTasks(db);
  const files = makeFiles(db, config);
  const conversations = makeConversations(db);
  const approvals = makeApprovals(db);
  const scheduler = makeScheduler(db, { timezone: config.timezone, enabled: config.schedulerEnabled, logger });
  const services = { memory, tasks, files, conversations, approvals, scheduler, settings };
  const tools = buildTools({ services, config });

  if (client === undefined && config.hasApiKey) client = new Anthropic();
  const agent = createAgent({ db, config, services, tools, logger, client: client || null });

  // تشغيل المهام المجدولة عبر الوكيل مع سجل تنفيذ
  scheduler.setRunner(async (s) => {
    if (!agent.ready) {
      const msg = "Claude API غير مهيأ (ANTHROPIC_API_KEY مفقود) — لم يُنفَّذ التشغيل";
      db.prepare("INSERT INTO schedule_runs (schedule_id, status, error, started_at, finished_at) VALUES (?, 'failed', ?, ?, ?)").run(s.id, msg, now(), now());
      logger.error("scheduler", `${msg} (#${s.id})`);
      return { status: "failed", error: msg };
    }
    const conv = conversations.create(`⏱ ${s.name} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "schedule");
    const srId = Number(db.prepare("INSERT INTO schedule_runs (schedule_id, conversation_id, status, started_at) VALUES (?,?, 'running', ?)").run(s.id, conv.id, now()).lastInsertRowid);
    try {
      const r = await agent.run({ conversationId: conv.id, userContent: [{ type: "text", text: s.prompt }], source: "schedule" });
      db.prepare("UPDATE schedule_runs SET run_id=?, status=?, summary=?, error=?, finished_at=? WHERE id=?")
        .run(r.runId, r.status, (r.text || "").slice(0, 4000), r.error, now(), srId);
      return { schedule_run_id: srId, conversation_id: conv.id, ...r };
    } catch (e) {
      db.prepare("UPDATE schedule_runs SET status='failed', error=?, finished_at=? WHERE id=?").run(e.message, now(), srId);
      logger.error("scheduler", `فشل التشغيل المجدول #${s.id}: ${e.message}`);
      return { schedule_run_id: srId, conversation_id: conv.id, status: "failed", error: e.message };
    }
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(config.root, "public")));

  const auth = makeAuth(db, config, logger);
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.post("/api/login", (req, res) => auth.login(req, res));
  app.post("/api/logout", (req, res) => auth.logout(req, res));
  app.get("/api/me", (req, res) => res.json({ authenticated: auth.isAuthenticated(req), authConfigured: authConfigured(config) }));

  const api = express.Router();
  api.use(auth.middleware());

  // ——— الحالة العامة
  api.get("/status", (req, res) => {
    res.json({
      model: config.model,
      webSearch: config.webSearchEnabled,
      limits: settings.limits(),
      spentLast24hUsd: agent.spentLast24h(),
      integrations: integrationsStatus(config, scheduler),
      activeRuns: agent.activeRuns(),
      tasks: tasks.summary(),
      pendingApprovals: approvals.list("pending").length,
      timezone: config.timezone,
    });
  });
  api.get("/settings/limits", (req, res) => res.json(settings.limits()));
  api.put("/settings/limits", (req, res) => {
    const l = settings.updateLimits(req.body);
    logger.info("settings", "تحديث الحدود", l);
    res.json(l);
  });

  // ——— المحادثات
  api.get("/conversations", (req, res) => res.json(conversations.list(req.query.source)));
  api.post("/conversations", (req, res) => res.status(201).json(conversations.create(req.body?.title)));
  api.get("/conversations/:id", (req, res) => {
    const c = conversations.get(id(req));
    if (!c) return res.status(404).json({ error: "المحادثة غير موجودة" });
    res.json({ ...c, messages: renderMessages(conversations.messages(c.id)), activeRun: agent.activeRuns().find((r) => r.conversationId === c.id) || null });
  });
  api.patch("/conversations/:id", (req, res) => res.json(conversations.rename(id(req), req.body?.title || "محادثة")));
  api.delete("/conversations/:id", (req, res) => res.json(conversations.remove(id(req))));

  // ——— المحادثة مع الوكيل (بث SSE)
  api.post("/chat", async (req, res) => {
    const { message, fileIds = [] } = req.body || {};
    let { conversationId } = req.body || {};
    if ((!message || !String(message).trim()) && !fileIds.length) return res.status(400).json({ error: "الرسالة فارغة" });
    if (!Array.isArray(fileIds) || fileIds.length > 10) return res.status(400).json({ error: "حتى 10 ملفات لكل رسالة" });

    let content;
    try {
      content = fileIds.map((fid) => files.toContentBlock(Number(fid)));
      const names = fileIds.map((fid) => { const f = files.get(Number(fid)); return `#${f.id} ${f.name}`; });
      const text = [String(message || "").trim(), names.length ? `(المرفقات: ${names.join("، ")})` : ""].filter(Boolean).join("\n\n");
      content.push({ type: "text", text });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    if (conversationId) {
      if (!conversations.get(Number(conversationId))) return res.status(404).json({ error: "المحادثة غير موجودة" });
      conversationId = Number(conversationId);
    } else {
      conversationId = conversations.create(String(message || "ملف").trim().slice(0, 60) || "محادثة جديدة").id;
    }

    let sse = false;
    const send = (ev) => { if (sse && !res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    try {
      await agent.run({
        conversationId,
        userContent: content,
        source: "chat",
        onStart: (runId) => {
          sse = true;
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          send({ type: "conversation", conversationId, runId });
        },
        onEvent: send,
      });
    } catch (e) {
      if (!sse) return res.status(e.status || 500).json({ error: e.message, conversationId });
      send({ type: "done", status: "failed", error: e.message });
    }
    if (!res.writableEnded) res.end();
  });

  api.post("/runs/:id/stop", (req, res) => {
    const ok = agent.stop(id(req));
    res.status(ok ? 200 : 404).json(ok ? { stopping: true } : { error: "لا توجد مهمة نشطة بهذا الرقم" });
  });
  api.get("/runs", (req, res) => res.json(db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 100").all()));

  // ——— الذاكرة
  api.get("/memory", (req, res) => res.json(memory.list(req.query)));
  api.post("/memory", (req, res) => {
    const m = memory.create({ ...req.body, source: "user", certainty: req.body?.certainty || "confirmed" });
    logger.info("memory", `أضاف المستخدم عنصر ذاكرة #${m.id}`);
    res.status(201).json(m);
  });
  api.patch("/memory/:id", (req, res) => res.json(memory.update(id(req), req.body || {})));
  api.delete("/memory/:id", (req, res) => { const r = memory.remove(id(req)); logger.info("memory", `حذف المستخدم عنصر ذاكرة #${r.deleted}`); res.json(r); });

  // ——— المشاريع والمهام
  api.get("/projects", (req, res) => res.json(tasks.listProjects()));
  api.post("/projects", (req, res) => res.status(201).json(tasks.createProject(req.body || {})));
  api.patch("/projects/:id", (req, res) => res.json(tasks.updateProject(id(req), req.body || {})));
  api.delete("/projects/:id", (req, res) => res.json(tasks.removeProject(id(req))));
  api.get("/tasks", (req, res) => res.json(tasks.listTasks(req.query)));
  api.post("/tasks", (req, res) => res.status(201).json(tasks.createTask(req.body || {})));
  api.patch("/tasks/:id", (req, res) => res.json(tasks.updateTask(id(req), req.body || {})));
  api.delete("/tasks/:id", (req, res) => res.json(tasks.removeTask(id(req))));

  // ——— الملفات
  const tmpDir = path.join(config.uploadsDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({ dest: tmpDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });
  api.post("/files", (req, res) => {
    upload.array("files", 10)(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? `حجم الملف يتجاوز ${config.maxUploadMb} MB` : err.message;
        for (const f of req.files || []) fs.rmSync(f.path, { force: true });
        return res.status(413).json({ error: msg });
      }
      const saved = [], errors = [];
      for (const f of req.files || []) {
        try { saved.push(files.registerUpload({ originalname: f.originalname, storedPath: f.path, size: f.size })); }
        catch (e) { errors.push({ name: f.originalname, error: e.message }); }
      }
      if (saved.length) logger.info("files", `رفع ${saved.length} ملف`, saved.map((f) => f.name));
      res.status(saved.length ? 201 : 415).json({ files: saved.map(({ stored_name, ...f }) => f), errors });
    });
  });
  api.get("/files", (req, res) => res.json(files.list(req.query.kind).map(({ stored_name, ...f }) => f)));
  api.get("/files/:id/download", (req, res) => {
    const f = files.get(id(req));
    if (!f) return res.status(404).json({ error: "الملف غير موجود" });
    const inline = req.query.inline === "1" && f.kind === "output";
    res.setHeader("Content-Type", `${f.mime}; charset=utf-8`);
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    // المستندات المعروضة داخل المتصفح لا تُشغَّل سكربتاتها
    if (inline) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    fs.createReadStream(files.diskPath(f)).pipe(res);
  });
  api.delete("/files/:id", (req, res) => res.json(files.remove(id(req))));

  // ——— الموافقات
  api.get("/approvals", (req, res) => res.json(approvals.list(req.query.status)));
  api.post("/approvals/:id/approve", async (req, res) => {
    const p = approvals.get(id(req));
    if (!p) return res.status(404).json({ error: "الطلب غير موجود" });
    if (p.status !== "pending") return res.status(409).json({ error: "تم البت في هذا الطلب مسبقًا" });
    try {
      const result = await tools.execute(p.tool, JSON.parse(p.input_json), { runId: p.run_id });
      logger.info("approval", `وافق المستخدم ونُفّذ: ${p.summary}`, result, p.run_id);
      res.json(approvals.decide(p.id, "approved", result));
    } catch (e) {
      logger.error("approval", `فشل تنفيذ إجراء موافق عليه: ${e.message}`, undefined, p.run_id);
      res.status(422).json({ ...approvals.decide(p.id, "failed", { error: e.message }), error: e.message });
    }
  });
  api.post("/approvals/:id/reject", (req, res) => {
    const p = approvals.decide(id(req), "rejected");
    logger.info("approval", `رفض المستخدم: ${p.summary}`, undefined, p.run_id);
    res.json(p);
  });

  // ——— المهام المجدولة
  api.get("/schedules", (req, res) => res.json({ scheduler: { running: scheduler.isRunning, enabled: scheduler.enabled, timezone: config.timezone }, items: scheduler.list() }));
  api.post("/schedules", (req, res) => res.status(201).json(scheduler.create(req.body || {})));
  api.patch("/schedules/:id", (req, res) => res.json(scheduler.update(id(req), req.body || {})));
  api.delete("/schedules/:id", (req, res) => res.json(scheduler.remove(id(req))));
  api.get("/schedules/runs", (req, res) => res.json(scheduler.runs(null, 100)));
  api.get("/schedules/:id/runs", (req, res) => res.json(scheduler.runs(id(req))));
  api.post("/schedules/:id/run", async (req, res) => {
    const s = scheduler.get(id(req));
    if (!s) return res.status(404).json({ error: "المهمة المجدولة غير موجودة" });
    // يبدأ في الخلفية ويُرجع فورًا؛ النتيجة تظهر في سجل التشغيل
    scheduler.runNow(s.id).catch((e) => logger.error("scheduler", e.message));
    res.status(202).json({ started: true });
  });

  // ——— السجلات
  api.get("/logs", (req, res) => res.json(logger.list({ runId: req.query.run_id ? Number(req.query.run_id) : undefined, level: req.query.level, limit: req.query.limit })));

  app.use("/api", api);
  app.use("/api", (req, res) => res.status(404).json({ error: "مسار غير موجود" }));

  // معالج أخطاء موحّد — لا يكشف تفاصيل داخلية
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
    if (status >= 500) logger.error("http", `${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: status >= 500 ? "خطأ داخلي في الخادم — راجع السجلات" : err.message });
  });

  return { app, db, services, agent, scheduler, logger, tools };
}
