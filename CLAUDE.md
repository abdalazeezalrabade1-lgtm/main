# CLAUDE.md

وكيل شخصي عربي (Node.js 22 + Express 5 + node:sqlite + @anthropic-ai/sdk). الشرح الكامل في README.md.

## أوامر
- `npm test` — كل الاختبارات (node:test). شغّلها قبل أي commit.
- `npm start` / `npm run dev` — يتطلب `.env` فيه `APP_PASSWORD` (و`ANTHROPIC_API_KEY` للمحادثة).

## قواعد التطوير
- ESM فقط، JavaScript بلا خطوة بناء، والواجهة بلا إطار عمل (`public/`).
- نصوص الواجهة والرسائل للمستخدم بالعربية.
- أدوات الوكيل الداخلية في `server/agent/tools.js`، والتكاملات الخارجية في `server/integrations/` (تُفعَّل فقط عند وجود بياناتها). الأدوات التي ترسل أو تنشر أو تحذف نهائيًا أو تعدّل بيانات خارجية يجب أن تحمل `approval: true`.
- لا تعرض تكاملًا كـ«موصول» في `server/services/integrations.js` إلا إذا كان يعمل فعلًا.
- سجل المحادثة (`messages`) append-only بصيغة Messages API — لا تعدّل رسائل سابقة (يكسر thinking blocks والتخزين المؤقت).
- لا تكتب أسرارًا في السجلات؛ استخدم `logger` الذي يمرّ عبر `redact`.
- الاختبارات تستخدم `fakeClient` في `test/helpers.js`؛ لا تستدعِ الـ API الحقيقي في الاختبارات.
