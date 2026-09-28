// إشعارات Telegram لصاحب الحساب فقط (chat_id ثابت في الإعدادات).
// لا يستطيع الوكيل الإرسال لأي شخص آخر عبر هذه القناة، ولذلك لا تحتاج موافقة لكل إشعار.
import { requestJson } from "./http.js";

const MAX = 3900; // حد Telegram 4096 حرفًا

export function telegramNotifier(env) {
  let logger = null;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const base = (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
  const configured = Boolean(token && chatId);
  const appUrl = (env.PUBLIC_URL || "").replace(/\/$/, "");

  async function send(text) {
    if (!configured) return false;
    try {
      await requestJson(`${base}/bot${token}/sendMessage`, {
        method: "POST",
        body: { chat_id: chatId, text: text.length > MAX ? text.slice(0, MAX) + "\n…(مختصر — التفاصيل في التطبيق)" : text, disable_web_page_preview: true },
        service: "Telegram",
      });
      return true;
    } catch (e) {
      // فشل الإشعار لا يُفشل المهمة، لكنه يُسجَّل بوضوح
      logger?.warn("notify", `فشل إرسال إشعار Telegram: ${e.message.replaceAll(token, "[REDACTED]")}`);
      return false;
    }
  }

  const statusAr = { completed: "✅ اكتملت", failed: "❌ فشلت", stopped: "⏹ أُوقفت", limit_reached: "⚠️ بلغت الحد", missed: "⏰ فات موعدها" };
  return {
    id: "telegram",
    name: "إشعارات Telegram (لك فقط)",
    configured,
    detail: configured
      ? "مفعّلة: تصلك نتائج المهام المجدولة وطلبات الموافقة الجديدة. القناة ترسل إلى محادثتك فقط."
      : "غير موصولة. أنشئ بوتًا عبر @BotFather وضع TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID (رقم محادثتك مع البوت)",
    tools: {},
    attachLogger(l) { logger = l; },
    async test() {
      if (!(await send("🔔 اختبار: إشعارات مساعد عبدالعزيز تعمل."))) throw new Error("فشل الإرسال — راجع السجل");
      return "أُرسلت رسالة اختبار إلى محادثتك";
    },
    send,
    scheduleResult(schedule, result) {
      const lines = [
        `${statusAr[result.status] || result.status} — مهمة مجدولة: ${schedule.name}`,
        result.error ? `السبب: ${result.error}` : "",
        result.text ? `\n${result.text}` : "",
        result.cost !== undefined ? `\nالتكلفة التقديرية: $${Number(result.cost).toFixed(4)}` : "",
        appUrl && result.conversation_id ? `فتح: ${appUrl}/#conv-${result.conversation_id}` : "",
      ];
      return send(lines.filter(Boolean).join("\n"));
    },
    approval(pending, source) {
      return send(`🛡 طلب موافقة جديد #${pending.id}${source === "schedule" ? " (من مهمة مجدولة)" : ""}:\n${pending.summary}${appUrl ? `\n\nراجِعه: ${appUrl}/#approvals` : "\n\nراجِعه من صفحة الموافقات في التطبيق."}`);
    },
    missed(schedule, when) {
      return send(`⏰ فات موعد المهمة المجدولة «${schedule.name}» (${when}) لأن الخادم كان متوقفًا. لم تُنفَّذ.`);
    },
  };
}
