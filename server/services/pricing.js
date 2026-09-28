// أسعار Claude API الرسمية ($ لكل مليون توكن). الأرقام تقديرية للتحكم في الحدود وليست فاتورة.
const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const WEB_SEARCH_PER_REQUEST = 10 / 1000; // $10 لكل 1000 بحث

export function priceFor(model, override) {
  if (override) return { ...override, known: true };
  const p = PRICES[model];
  // نموذج غير معروف: نستخدم سعرًا مرتفعًا احتياطًا حتى لا تُتجاوز الحدود دون قصد
  return p ? { ...p, known: true } : { input: 10, output: 50, known: false };
}

/** تكلفة استجابة واحدة من usage */
export function costOfUsage(usage, model, override) {
  if (!usage) return 0;
  const p = priceFor(model, override);
  const inTok = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (
    (inTok * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + outTok * p.output) / 1e6 +
    searches * WEB_SEARCH_PER_REQUEST
  );
}
