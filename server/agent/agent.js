// حلقة الوكيل: Claude Messages API + tool use، مع حدود للخطوات والتكلفة، وإيقاف، وسجل إجراءات.
import Anthropic from "@anthropic-ai/sdk";
import { now } from "../db.js";
import { costOfUsage } from "../services/pricing.js";
import { STATIC_SYSTEM, dynamicSystem } from "./prompt.js";

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function friendlyApiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "مفتاح Claude API غير صالح أو منتهي (401). تحقق من ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.PermissionDeniedError) return "لا توجد صلاحية لهذا الطلب (403). قد تكون ميزة مثل البحث غير مفعّلة لمؤسستك في Console.";
  if (e instanceof Anthropic.NotFoundError) return "النموذج أو المورد غير موجود (404). تحقق من CLAUDE_MODEL.";
  if (e instanceof Anthropic.RateLimitError) return "تم تجاوز حد الطلبات لدى Anthropic (429). حاول بعد قليل.";
  if (e instanceof Anthropic.BadRequestError) return `طلب غير صالح (400): ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "تعذّر الاتصال بـ Claude API (شبكة/مهلة).";
  if (e instanceof Anthropic.APIError) return `خطأ من Claude API (${e.status ?? "?"}): ${e.message}`;
  return e?.message || String(e);
}

/** يستخرج المصادر من نتائج web_search والاستشهادات */
export function extractSources(content) {
  const out = new Map();
  for (const b of content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result" && r.url) out.set(r.url, { title: r.title, url: r.url, page_age: r.page_age ?? null });
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.url && !out.has(c.url)) out.set(c.url, { title: c.title, url: c.url, page_age: null });
    }
  }
  return [...out.values()];
}

export function createAgent({ db, config, services, tools, logger, client, integrations = [], notify = null }) {
  const { conversations, approvals, memory, settings } = services;
  const active = new Map(); // runId -> { controller, conversationId }

  const runRow = (id) => db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  const spentLast24h = () =>
    db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM runs WHERE started_at >= ?").get(new Date(Date.now() - 86_400_000).toISOString()).c;

  function streamRequest(params, signal) {
    const betas = [];
    const extra = {};
    if (config.serverFallbacks) { betas.push("server-side-fallback-2026-07-01"); extra.fallbacks = "default"; }
    if (config.compaction) { betas.push("compact-2026-01-12"); extra.context_management = { edits: [{ type: "compact_20260112" }] }; }
    if (betas.length) return client.beta.messages.stream({ ...params, ...extra, betas }, { signal });
    return client.messages.stream(params, { signal });
  }

  // التشغيلات المجدولة لا تستطيع إنشاء أو تعديل أو حذف مهام مجدولة (منع التكاثر الذاتي والتكلفة غير المتوقعة)
  const SCHEDULE_BLOCKED = new Set(["schedule_create", "schedule_update", "schedule_delete"]);
  const toolsFor = (source) => (source === "schedule" ? tools.definitions.filter((t) => !SCHEDULE_BLOCKED.has(t.name)) : tools.definitions);
  const allowed = (source, name) => tools.has(name) && !(source === "schedule" && SCHEDULE_BLOCKED.has(name));

  const LARGE_HISTORY_CHARS = 500_000; // ≈ 150 ألف توكن تقريبًا

  /**
   * يشغّل الوكيل على رسالة مستخدم. يعيد { runId, status, text, error }.
   * onEvent يستقبل أحداثًا للواجهة (SSE).
   */
  async function run({ conversationId, userContent, source = "chat", onEvent = () => {}, onStart }) {
    if (!client) throw httpError(503, "Claude API غير مهيأ: ضع ANTHROPIC_API_KEY في ملف .env ثم أعد تشغيل الخادم.");
    for (const r of active.values()) if (r.conversationId === conversationId) throw httpError(409, "هناك مهمة قيد التنفيذ في هذه المحادثة. أوقفها أو انتظر انتهاءها.");

    const limits = settings.limits();
    const spent = spentLast24h();
    if (spent >= limits.dailyCostLimitUsd) {
      throw httpError(429, `تم بلوغ حد التكلفة اليومي (${limits.dailyCostLimitUsd}$؛ المستهلك آخر 24 ساعة ≈ ${spent.toFixed(3)}$). عدّل الحد من الإعدادات.`);
    }

    const startedAt = now();
    const runId = Number(db.prepare("INSERT INTO runs (conversation_id, source, status, started_at) VALUES (?,?, 'running', ?)").run(conversationId, source, startedAt).lastInsertRowid);
    const controller = new AbortController();
    active.set(runId, { controller, conversationId });
    const emit = (ev) => { try { onEvent({ runId, ...ev }); } catch { /* الواجهة قد تكون أغلقت الاتصال */ } };
    onStart?.(runId);
    emit({ type: "run", status: "running" });

    conversations.addMessage(conversationId, "user", userContent, runId);
    logger.info("run", `بدء تشغيل (${source}) للمحادثة #${conversationId}`, { limits }, runId);

    const totals = { steps: 0, input: 0, output: 0, searches: 0, cost: 0 };
    if (!config.compaction) {
      const size = JSON.stringify(conversations.history(conversationId)).length;
      if (size > LARGE_HISTORY_CHARS) {
        const note = "هذه المحادثة طويلة جدًا: كل رسالة تعيد إرسال السجل كاملًا فترتفع التكلفة وقد تتجاوز حد السياق. ابدأ محادثة جديدة (الذاكرة الدائمة تنتقل تلقائيًا)، أو فعّل CLAUDE_COMPACTION=true.";
        logger.warn("context", note, { chars: size }, runId);
        emit({ type: "notice", message: note });
      }
    }
    const saveTotals = (status, error = null, finished = false) =>
      db.prepare("UPDATE runs SET status=?, steps=?, input_tokens=?, output_tokens=?, web_searches=?, cost_usd=?, error=?, finished_at=? WHERE id=?")
        .run(status, totals.steps, totals.input, totals.output, totals.searches, totals.cost, error, finished ? now() : null, runId);

    let finalText = "";
    let status = "completed";
    let errorMsg = null;

    try {
      while (true) {
        if (controller.signal.aborted) { status = "stopped"; break; }
        if (totals.steps >= limits.maxSteps) {
          status = "limit_reached"; errorMsg = `بلغ الحد الأقصى لخطوات التنفيذ (${limits.maxSteps}).`; break;
        }
        if (totals.cost >= limits.maxCostPerRunUsd) {
          status = "limit_reached"; errorMsg = `بلغ حد التكلفة لهذه المهمة (${limits.maxCostPerRunUsd}$).`; break;
        }
        if (spent + totals.cost >= limits.dailyCostLimitUsd) {
          status = "limit_reached"; errorMsg = `بلغ حد التكلفة اليومي (${limits.dailyCostLimitUsd}$).`; break;
        }

        totals.steps++;
        emit({ type: "step", step: totals.steps, maxSteps: limits.maxSteps });

        const params = {
          model: config.model,
          max_tokens: config.maxTokens,
          thinking: { type: "adaptive" },
          output_config: { effort: config.effort },
          system: [
            { type: "text", text: STATIC_SYSTEM, cache_control: { type: "ephemeral" } },
            { type: "text", text: dynamicSystem({ config, memoryBlock: memory.promptBlock(), source, integrations }) },
          ],
          tools: toolsFor(source),
          messages: conversations.history(conversationId),
        };

        let message;
        try {
          const stream = streamRequest(params, controller.signal);
          stream.on("text", (delta) => emit({ type: "text", delta }));
          message = await stream.finalMessage();
        } catch (e) {
          if (controller.signal.aborted) { status = "stopped"; break; }
          throw e;
        }

        const stepCost = costOfUsage(message.usage, message.model || config.model, config.priceOverride);
        totals.input += (message.usage?.input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0) + (message.usage?.cache_creation_input_tokens || 0);
        totals.output += message.usage?.output_tokens || 0;
        totals.searches += message.usage?.server_tool_use?.web_search_requests || 0;
        totals.cost += stepCost;
        saveTotals("running");
        emit({ type: "usage", steps: totals.steps, cost: totals.cost, input_tokens: totals.input, output_tokens: totals.output });

        for (const b of message.content) {
          if (b.type === "server_tool_use" && b.name === "web_search") {
            emit({ type: "search", query: b.input?.query });
            logger.info("web_search", `بحث: ${b.input?.query ?? ""}`, undefined, runId);
          }
          if (b.type === "web_search_tool_result" && !Array.isArray(b.content)) {
            logger.warn("web_search", `فشل البحث: ${b.content?.error_code ?? "unknown"}`, undefined, runId);
            emit({ type: "tool", name: "web_search", status: "error", result: b.content?.error_code });
          }
        }
        const sources = extractSources(message.content);
        if (sources.length) emit({ type: "sources", items: sources });

        if (message.stop_reason === "refusal") {
          status = "failed";
          errorMsg = "رفض النموذج إكمال هذا الطلب لأسباب تتعلق بسياسات الأمان.";
          logger.warn("refusal", errorMsg, message.stop_details ?? undefined, runId);
          break; // لا نحفظ المحتوى الجزئي
        }

        const toolUses = message.content.filter((b) => b.type === "tool_use");
        if (message.stop_reason === "max_tokens" && toolUses.length) {
          status = "failed"; errorMsg = "انقطع الرد عند حد التوكنات أثناء استدعاء أداة. ارفع CLAUDE_MAX_TOKENS أو قسّم الطلب."; break;
        }

        conversations.addMessage(conversationId, "assistant", message.content, runId);
        const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text) finalText += (finalText ? "\n\n" : "") + text;

        if (message.stop_reason === "pause_turn") continue;
        if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
          if (message.stop_reason === "max_tokens") { errorMsg = "انقطع الرد عند حد التوكنات (CLAUDE_MAX_TOKENS)."; }
          break;
        }

        // تنفيذ الأدوات — كل النتائج في رسالة user واحدة
        const results = [];
        for (const tu of toolUses) {
          if (controller.signal.aborted) {
            results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: "أوقف المستخدم المهمة قبل تنفيذ هذه الأداة." });
            continue;
          }
          emit({ type: "tool", name: tu.name, input: tu.input, status: "running" });
          try {
            if (!allowed(source, tu.name)) throw new Error(`أداة غير متاحة في هذا السياق: ${tu.name}`);
            if (tools.needsApproval(tu.name)) {
              const invalid = tools.validate(tu.name, tu.input);
              if (invalid) throw new Error(invalid);
              const summary = tools.summarize(tu.name, tu.input);
              const p = approvals.create({ runId, tool: tu.name, input: tu.input, summary });
              logger.info("approval_requested", summary, { pending_id: p.id }, runId);
              emit({ type: "approval", pending: p });
              notify?.approval(p, source);
              emit({ type: "tool", name: tu.name, status: "pending_approval", result: `طلب موافقة #${p.id}` });
              results.push({
                type: "tool_result", tool_use_id: tu.id,
                content: JSON.stringify({ status: "pending_approval", pending_action_id: p.id, note: "لم يُنفَّذ. ينتظر موافقة المستخدم في لوحة الموافقات." }),
              });
              continue;
            }
            const out = await tools.execute(tu.name, tu.input, { runId, conversationId, emit });
            const json = JSON.stringify(out ?? { ok: true });
            logger.info("tool", `${tu.name}`, { input: tu.input, output: json.slice(0, 1500) }, runId);
            emit({ type: "tool", name: tu.name, status: "done" });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: json.slice(0, 100_000) });
          } catch (e) {
            logger.warn("tool_error", `${tu.name}: ${e.message}`, { input: tu.input }, runId);
            emit({ type: "tool", name: tu.name, status: "error", result: e.message });
            results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `خطأ: ${e.message}` });
          }
        }
        conversations.addMessage(conversationId, "user", results, runId);
      }
    } catch (e) {
      status = "failed";
      errorMsg = friendlyApiError(e);
      logger.error("run_failed", errorMsg, undefined, runId);
    } finally {
      active.delete(runId);
    }

    if (status === "stopped") errorMsg = "أُوقفت المهمة بطلب المستخدم.";
    saveTotals(status, errorMsg, true);
    logger[status === "completed" ? "info" : "warn"]("run_end", `انتهى التشغيل: ${status}${errorMsg ? " — " + errorMsg : ""}`, { cost_usd: totals.cost, steps: totals.steps }, runId);
    emit({ type: "done", status, error: errorMsg, cost: totals.cost, steps: totals.steps });
    return { runId, status, text: finalText, error: errorMsg, cost: totals.cost, steps: totals.steps };
  }

  return {
    ready: Boolean(client),
    run,
    stop(runId) {
      const r = active.get(Number(runId));
      if (!r) return false;
      r.controller.abort();
      logger.info("run_stop", "طلب المستخدم إيقاف المهمة", undefined, Number(runId));
      return true;
    },
    activeRuns: () => [...active.entries()].map(([id, r]) => ({ runId: id, conversationId: r.conversationId })),
    runRow,
    spentLast24h,
  };
}
