// سلة (Salla Merchant API v2) — قراءة فقط. التوثيق: https://docs.salla.dev
import { requestJson } from "./http.js";

const money = (m) => (m && typeof m === "object" ? `${m.amount} ${m.currency ?? ""}`.trim() : m ?? null);
const sallaDate = (d) => (d && typeof d === "object" ? d.date?.slice(0, 19) : d ?? null);

function slimOrder(o) {
  return {
    id: o.id,
    reference_id: o.reference_id,
    date: sallaDate(o.date),
    status: o.status?.customized?.name || o.status?.name,
    status_slug: o.status?.slug,
    total: money(o.total),
    payment_method: o.payment_method,
    source: o.source,
    items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity })),
    // تقليل البيانات الشخصية: الاسم والمدينة فقط، بلا جوال أو بريد
    customer: o.customer ? { name: o.customer.full_name, city: o.customer.city } : null,
  };
}

function slimProduct(p) {
  return {
    id: p.id, name: p.name, sku: p.sku, status: p.status, type: p.type,
    price: money(p.price), sale_price: money(p.sale_price), cost_price: money(p.cost_price),
    quantity: p.unlimited_quantity ? "غير محدود" : p.quantity,
    sold_quantity: p.sold_quantity, is_available: p.is_available, views: p.views,
    rating: p.rating?.rate ?? null, url: p.url || p.urls?.customer,
  };
}

export function sallaIntegration(env) {
  const token = env.SALLA_ACCESS_TOKEN;
  const base = (env.SALLA_API_BASE || "https://api.salla.dev/admin/v2").replace(/\/$/, "");
  const call = (path, params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
    return requestJson(`${base}${path}${qs.size ? "?" + qs : ""}`, { headers: { Authorization: `Bearer ${token}` }, service: "سلة" });
  };
  return {
    id: "salla",
    name: "متجر سلة (قراءة فقط)",
    configured: Boolean(token),
    detail: token
      ? "موصول بـ SALLA_ACCESS_TOKEN. قراءة الطلبات والمنتجات ومعلومات المتجر فقط؛ لا تعديل."
      : "غير موصول. ضع SALLA_ACCESS_TOKEN (رمز تطبيق من Salla Partners بصلاحيات orders.read و products.read و store info)",
    async test() {
      const r = await call("/store/info");
      return `المتجر: ${r?.data?.name ?? "؟"} (${r?.data?.domain ?? ""})`;
    },
    tools: {
      salla_store_info: {
        description: "معلومات متجر سلة (الاسم، الخطة، العملة، النطاق).",
        input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: async () => {
          const d = (await call("/store/info")).data || {};
          return { id: d.id, name: d.name, plan: d.plan, currency: d.currency, domain: d.domain, status: d.status };
        },
      },
      salla_orders_list: {
        description:
          "قائمة طلبات متجر سلة (30 طلبًا كحد أقصى لكل صفحة). استخدم from_date/to_date (YYYY-MM-DD) لتقليل البيانات، واطلب الصفحات بالتسلسل. البيانات الشخصية مختصرة (الاسم والمدينة).",
        input_schema: {
          type: "object",
          properties: {
            from_date: { type: "string", description: "من تاريخ YYYY-MM-DD" },
            to_date: { type: "string", description: "إلى تاريخ YYYY-MM-DD" },
            status: { type: "string", description: "رقم/معرّف حالة الطلب في سلة (اختياري)" },
            keyword: { type: "string", description: "بحث نصي" },
            page: { type: "integer", description: "رقم الصفحة (يبدأ من 1)" },
          },
          required: [],
          additionalProperties: false,
        },
        run: async (i) => {
          const r = await call("/orders", { ...i, per_page: 30 });
          return { orders: (r.data || []).map(slimOrder), pagination: { total: r.pagination?.total, page: r.pagination?.currentPage, total_pages: r.pagination?.totalPages } };
        },
      },
      salla_order_get: {
        description: "تفاصيل طلب واحد من سلة بالمعرّف id.",
        input_schema: { type: "object", properties: { id: { type: "integer", description: "معرّف الطلب" } }, required: ["id"], additionalProperties: false },
        run: async ({ id }) => {
          const o = (await call(`/orders/${encodeURIComponent(id)}`)).data || {};
          return {
            ...slimOrder(o),
            amounts: o.amounts ? { sub_total: money(o.amounts.sub_total), shipping: money(o.amounts.shipping_cost), discount: money(o.amounts.discounts?.[0]?.discount ?? null), total: money(o.amounts.total) } : undefined,
            shipping_company: o.shipping?.company ?? undefined,
          };
        },
      },
      salla_products_list: {
        description: "قائمة منتجات سلة مع السعر والكمية والمبيعات (sold_quantity). مفيدة لتحليل الأكثر مبيعًا والمخزون المنخفض.",
        input_schema: {
          type: "object",
          properties: {
            keyword: { type: "string", description: "بحث بالاسم أو SKU" },
            status: { type: "string", description: "sale أو out أو hidden (اختياري)" },
            page: { type: "integer", description: "رقم الصفحة" },
          },
          required: [],
          additionalProperties: false,
        },
        run: async (i) => {
          const r = await call("/products", { ...i, per_page: 50 });
          return { products: (r.data || []).map(slimProduct), pagination: { total: r.pagination?.total, page: r.pagination?.currentPage, total_pages: r.pagination?.totalPages } };
        },
      },
    },
  };
}
