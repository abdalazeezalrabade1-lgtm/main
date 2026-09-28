// الاستخدام: npm run hash-password -- "كلمة-مرور-قوية"
import { hashPassword } from "../auth.js";
const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error("أدخل كلمة مرور لا تقل عن 10 أحرف: npm run hash-password -- \"...\"");
  process.exit(1);
}
console.log(`APP_PASSWORD_HASH=${hashPassword(pw)}`);
