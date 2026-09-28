// إرسال البريد عبر SMTP (nodemailer). كل إرسال يمر إلزاميًا عبر بوابة الموافقة.
import nodemailer from "nodemailer";
import { IntegrationError } from "./http.js";

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function emailIntegration(env, { transportFactory } = {}) {
  const configured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
  let transport = null;
  const getTransport = () => {
    transport ??= (transportFactory || nodemailer.createTransport)({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: ["1", "true", "yes"].includes(String(env.SMTP_SECURE || "").toLowerCase()),
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    return transport;
  };
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,;،\s]+/)).map((s) => s.trim()).filter(Boolean);

  return {
    id: "email",
    name: "البريد الإلكتروني (SMTP)",
    configured,
    detail: configured
      ? `موصول (${env.SMTP_HOST}) — المرسِل ${env.SMTP_FROM}. كل رسالة تتطلب موافقتك قبل الإرسال.`
      : "غير موصول. ضع SMTP_HOST و SMTP_PORT و SMTP_USER و SMTP_PASS و SMTP_FROM (لـ Gmail استخدم App Password). كل إرسال سيتطلب موافقتك",
    async test() {
      await getTransport().verify();
      return "تم التحقق من اتصال SMTP وبيانات الدخول";
    },
    tools: {
      email_send: {
        description:
          "إرسال بريد إلكتروني لأشخاص آخرين. لا يُرسل فورًا: يُنشئ طلب موافقة يراجعه المستخدم (المستلمون والموضوع والنص كاملًا) قبل الإرسال. اكتب النص كاملًا ونهائيًا.",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "array", items: { type: "string" }, description: "المستلمون (حتى 10)" },
            cc: { type: "array", items: { type: "string" }, description: "نسخة (اختياري)" },
            subject: { type: "string", description: "الموضوع" },
            body: { type: "string", description: "نص الرسالة (نص عادي)" },
          },
          required: ["to", "subject", "body"],
          additionalProperties: false,
        },
        approval: true,
        validate: (i) => {
          const to = list(i.to), cc = list(i.cc);
          if (!to.length) return "لا يوجد مستلم";
          if (to.length + cc.length > 10) return "الحد 10 مستلمين";
          const bad = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
          if (bad.length) return `عناوين غير صالحة: ${bad.join(", ")}`;
          if (!String(i.subject || "").trim() || !String(i.body || "").trim()) return "الموضوع والنص مطلوبان";
          if (String(i.body).length > 50_000) return "النص طويل جدًا";
          return null;
        },
        summary: (i) => `إرسال بريد إلى ${list(i.to).join("، ")}${list(i.cc).length ? ` (نسخة: ${list(i.cc).join("، ")})` : ""} — الموضوع: «${i.subject}»`,
        run: async (i) => {
          try {
            const info = await getTransport().sendMail({
              from: env.SMTP_FROM, to: list(i.to).join(", "), cc: list(i.cc).join(", ") || undefined,
              subject: i.subject, text: i.body,
            });
            return { sent: true, message_id: info.messageId, accepted: info.accepted, rejected: info.rejected };
          } catch (e) {
            throw new IntegrationError(`فشل الإرسال عبر SMTP: ${e.message}`, 502);
          }
        },
      },
    },
  };
}
