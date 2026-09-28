// حالة التكاملات. ما لم يُربط فعليًا يظهر "غير موصول" — لا أزرار شكلية ولا بيانات تجريبية.
export function integrationsStatus(config, scheduler) {
  return [
    {
      id: "claude", name: "Claude API", connected: config.hasApiKey,
      detail: config.hasApiKey ? `النموذج: ${config.model}` : "ضع ANTHROPIC_API_KEY في ملف .env ثم أعد التشغيل",
    },
    {
      id: "web_search", name: "البحث عبر الإنترنت (Anthropic web search)", connected: config.hasApiKey && config.webSearchEnabled,
      detail: !config.webSearchEnabled
        ? "معطّل. فعّله بـ WEB_SEARCH_ENABLED=true بعد تفعيل Web Search لمؤسستك في Claude Console (تكلفة إضافية لكل بحث)"
        : config.hasApiKey ? `مفعّل — حتى ${config.webSearchMaxUses} عمليات بحث لكل طلب` : "يحتاج مفتاح Claude API",
    },
    {
      id: "scheduler", name: "المجدول الداخلي", connected: scheduler.isRunning,
      detail: scheduler.isRunning
        ? "يعمل داخل عملية الخادم. يتوقف بتوقف الخادم، والمواعيد الفائتة تُسجَّل ولا تُنفَّذ بأثر رجعي"
        : "متوقف — المهام المجدولة لن تعمل",
    },
    { id: "files", name: "تحليل الملفات", connected: config.hasApiKey, detail: "PDF، صور، TXT/MD/CSV/JSON/HTML. ملفات Excel/Word غير مدعومة مباشرة بعد (صدّرها CSV/PDF)" },
    { id: "email", name: "البريد الإلكتروني", connected: false, detail: "غير موصول. يتطلب إضافة أداة إرسال (SMTP/Gmail API) مع بوابة موافقة" },
    { id: "calendar", name: "التقويم (Google Calendar)", connected: false, detail: "غير موصول. المواعيد تُدار حاليًا داخل نظام المهام" },
    { id: "store", name: "المتجر (سلة / Shopify)", connected: false, detail: "غير موصول. يتطلب مفتاح API للمتجر وأداة قراءة؛ أي تعديل على المتجر سيحتاج موافقتك" },
    { id: "messaging", name: "واتساب / Slack", connected: false, detail: "غير موصول. أي إرسال للآخرين سيمرّ عبر بوابة الموافقة" },
  ];
}
