// Shopify Admin GraphQL — قراءة فقط.
// المصادقة: SHOPIFY_ACCESS_TOKEN مباشرة، أو SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (client credentials، رمز صالح 24 ساعة).
import { requestJson, IntegrationError } from "./http.js";

export function shopifyIntegration(env) {
  const shop = (env.SHOPIFY_SHOP || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const version = env.SHOPIFY_API_VERSION || "2026-07";
  const staticToken = env.SHOPIFY_ACCESS_TOKEN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  const configured = Boolean(shop && (staticToken || (clientId && clientSecret)));
  const origin = env.SHOPIFY_BASE_URL || `https://${shop}`; // يُستبدل في الاختبارات فقط
  let cached = null; // { token, expiresAt }

  async function token() {
    if (staticToken) return staticToken;
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString();
    const r = await requestJson(`${origin}/admin/oauth/access_token`, {
      method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, service: "Shopify",
    });
    if (!r?.access_token) throw new IntegrationError("Shopify: لم يُرجع رمز وصول", 502);
    cached = { token: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 86_400) * 1000 };
    return cached.token;
  }

  async function gql(query, variables = {}) {
    const r = await requestJson(`${origin}/admin/api/${version}/graphql.json`, {
      method: "POST", body: { query, variables }, headers: { "X-Shopify-Access-Token": await token() }, service: "Shopify",
    });
    if (r?.errors?.length) throw new IntegrationError(`Shopify: ${r.errors.map((e) => e.message).join("؛ ").slice(0, 300)}`, 400);
    return r.data;
  }
  const money = (m) => (m ? `${m.amount} ${m.currencyCode}` : null);

  return {
    id: "shopify",
    name: "متجر Shopify (قراءة فقط)",
    configured,
    detail: configured
      ? `موصول بالمتجر ${shop} (API ${version}). قراءة الطلبات والمنتجات فقط؛ لا تعديل.`
      : "غير موصول. ضع SHOPIFY_SHOP مع SHOPIFY_ACCESS_TOKEN، أو SHOPIFY_CLIENT_ID و SHOPIFY_CLIENT_SECRET (تطبيق من Dev Dashboard بصلاحيات read_orders و read_products)",
    async test() {
      const d = await gql("{ shop { name currencyCode myshopifyDomain } }");
      return `المتجر: ${d.shop.name} (${d.shop.myshopifyDomain}، ${d.shop.currencyCode})`;
    },
    tools: {
      shopify_orders_list: {
        description:
          "طلبات Shopify الأحدث أولًا (حتى 50). query بصيغة بحث Shopify مثل \"created_at:>=2026-09-01 financial_status:paid\". الطلبات الأقدم من 60 يومًا تتطلب صلاحية read_all_orders.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "عبارة بحث Shopify (اختياري)" },
            first: { type: "integer", description: "العدد (1-50، افتراضي 25)" },
            after: { type: "string", description: "مؤشر الصفحة التالية (end_cursor)" },
          },
          required: [],
          additionalProperties: false,
        },
        run: async ({ query, first = 25, after }) => {
          const d = await gql(
            `query($first:Int!,$query:String,$after:String){ orders(first:$first, query:$query, after:$after, sortKey:CREATED_AT, reverse:true){
              pageInfo{ hasNextPage endCursor }
              nodes{ name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
                totalPriceSet{ shopMoney{ amount currencyCode } }
                shippingAddress{ city countryCode }
                lineItems(first:20){ nodes{ title quantity } } } } }`,
            { first: Math.min(Math.max(Number(first) || 25, 1), 50), query: query || null, after: after || null },
          );
          return {
            orders: d.orders.nodes.map((o) => ({
              name: o.name, created_at: o.createdAt, financial: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus,
              cancelled: Boolean(o.cancelledAt), total: money(o.totalPriceSet?.shopMoney), city: o.shippingAddress?.city ?? null,
              items: o.lineItems.nodes.map((l) => ({ title: l.title, quantity: l.quantity })),
            })),
            has_next_page: d.orders.pageInfo.hasNextPage, end_cursor: d.orders.pageInfo.endCursor,
          };
        },
      },
      shopify_products_list: {
        description: "منتجات Shopify مع الحالة والمخزون الكلي ونطاق السعر. query مثل \"status:active inventory_total:<5\".",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "عبارة بحث Shopify (اختياري)" },
            first: { type: "integer", description: "العدد (1-50)" },
            after: { type: "string", description: "مؤشر الصفحة التالية" },
          },
          required: [],
          additionalProperties: false,
        },
        run: async ({ query, first = 25, after }) => {
          const d = await gql(
            `query($first:Int!,$query:String,$after:String){ products(first:$first, query:$query, after:$after){
              pageInfo{ hasNextPage endCursor }
              nodes{ title handle status totalInventory productType vendor
                priceRangeV2{ minVariantPrice{ amount currencyCode } maxVariantPrice{ amount currencyCode } } } } }`,
            { first: Math.min(Math.max(Number(first) || 25, 1), 50), query: query || null, after: after || null },
          );
          return {
            products: d.products.nodes.map((p) => ({
              title: p.title, handle: p.handle, status: p.status, inventory: p.totalInventory, type: p.productType, vendor: p.vendor,
              price_min: money(p.priceRangeV2?.minVariantPrice), price_max: money(p.priceRangeV2?.maxVariantPrice),
            })),
            has_next_page: d.products.pageInfo.hasNextPage, end_cursor: d.products.pageInfo.endCursor,
          };
        },
      },
    },
  };
}
