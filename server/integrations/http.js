// طلب HTTP موحّد للتكاملات: مهلة، رسائل خطأ واضحة، ولا يُعاد نص الخطأ الخام الطويل.
export class IntegrationError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 20_000, service = "الخدمة" } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(body && typeof body === "string" ? {} : body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body && typeof body !== "string" ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new IntegrationError(`تعذّر الاتصال بـ ${service}: ${e.name === "TimeoutError" ? "انتهت المهلة" : e.message}`, 502);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ليس JSON */ }
  if (!res.ok) {
    const hint = {
      401: "المفتاح/الرمز غير صالح أو منتهي الصلاحية",
      403: "الصلاحيات (scopes) لا تسمح بهذا الطلب",
      404: "المورد غير موجود",
      429: "تجاوز حد الطلبات — حاول لاحقًا",
    }[res.status] || "خطأ من الخدمة";
    const detail = data?.error?.message || data?.error_description || data?.errors?.[0]?.message || (typeof data?.error === "string" ? data.error : "") || "";
    throw new IntegrationError(`${service}: ${hint} (${res.status})${detail ? " — " + String(detail).slice(0, 200) : ""}`, res.status);
  }
  return data;
}
