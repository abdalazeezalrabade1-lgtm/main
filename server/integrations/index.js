// سجل التكاملات الخارجية. كل تكامل يُفعَّل فقط عند وجود بياناته في البيئة، وأدواته لا تُعرض للنموذج غير ذلك.
import { sallaIntegration } from "./salla.js";
import { shopifyIntegration } from "./shopify.js";
import { emailIntegration } from "./email.js";

export function loadIntegrations(env = process.env, opts = {}) {
  return [sallaIntegration(env), shopifyIntegration(env), emailIntegration(env, opts.email)];
}
