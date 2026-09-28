// حدود التشغيل: القيم الافتراضية من البيئة، ويمكن تعديلها من الواجهة (تُحفظ في قاعدة البيانات).
export function makeSettings(db, defaults) {
  const get = db.prepare("SELECT value FROM settings WHERE key = ?");
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const BOUNDS = {
    maxSteps: [1, 50],
    maxCostPerRunUsd: [0.01, 20],
    dailyCostLimitUsd: [0.05, 200],
  };
  return {
    limits() {
      const out = {};
      for (const k of Object.keys(BOUNDS)) {
        const row = get.get(`limits.${k}`);
        out[k] = row ? Number(row.value) : defaults[k];
      }
      return out;
    },
    updateLimits(patch) {
      const errors = [];
      for (const [k, v] of Object.entries(patch || {})) {
        if (!BOUNDS[k]) { errors.push(`حقل غير معروف: ${k}`); continue; }
        const n = Number(v);
        const [lo, hi] = BOUNDS[k];
        if (!Number.isFinite(n) || n < lo || n > hi) { errors.push(`${k} يجب أن يكون بين ${lo} و ${hi}`); continue; }
        set.run(`limits.${k}`, String(k === "maxSteps" ? Math.round(n) : n));
      }
      if (errors.length) throw Object.assign(new Error(errors.join("؛ ")), { status: 400 });
      return this.limits();
    },
  };
}
