// واجهة المستخدم — JavaScript بلا إطار عمل. كل البيانات من /api؛ لا بيانات تجريبية.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = window.escapeHtml;
  const md = window.renderMarkdown;

  const L = {
    priority: { urgent: "عاجلة", high: "عالية", medium: "متوسطة", low: "منخفضة" },
    status: { todo: "للتنفيذ", in_progress: "قيد التنفيذ", blocked: "متوقفة", done: "منجزة", cancelled: "ملغاة" },
    project: { active: "نشط", paused: "متوقف مؤقتًا", done: "مكتمل", archived: "مؤرشف" },
    category: { preference: "تفضيل", project: "مشروع", decision: "قرار", fact: "معلومة", contact: "جهة/عميل", other: "أخرى" },
    certainty: { confirmed: "مؤكدة", inferred: "استنتاج" },
    run: { running: "جارٍ", completed: "مكتمل", stopped: "أُوقف", failed: "فشل", limit_reached: "بلغ الحد", missed: "فائت", skipped: "متخطى" },
    approval: { pending: "بانتظار الموافقة", approved: "نُفّذ", rejected: "مرفوض", failed: "فشل التنفيذ" },
    level: { info: "معلومة", warn: "تحذير", error: "خطأ" },
  };
  const toolNames = {
    memory_list: "قراءة الذاكرة", memory_save: "حفظ في الذاكرة", memory_update: "تعديل الذاكرة", memory_delete: "طلب حذف من الذاكرة",
    project_list: "قراءة المشاريع", project_create: "إنشاء مشروع", project_update: "تعديل مشروع",
    task_list: "قراءة المهام", task_create: "إنشاء مهمة", task_update: "تحديث مهمة", task_delete: "طلب حذف مهمة",
    file_list: "قراءة الملفات", file_read: "قراءة ملف", document_create: "إنشاء مستند",
    schedule_list: "قراءة المجدولة", schedule_create: "إنشاء مهمة مجدولة", schedule_update: "تعديل مهمة مجدولة", schedule_delete: "طلب حذف مهمة مجدولة",
    integrations_status: "فحص التكاملات", web_search: "بحث ويب",
  };
  let tz; // المنطقة الزمنية المضبوطة على الخادم (TZ_NAME) لعرض موحّد للمواعيد
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("ar-SA-u-ca-gregory-nu-latn", { dateStyle: "medium", timeStyle: "short", ...(tz ? { timeZone: tz } : {}) }) : "—");
  const fmtUsd = (n) => `$${Number(n || 0).toFixed(4)}`;
  const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;

  function toast(msg, isErr = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), isErr ? 6000 : 3000);
  }

  async function api(path, opts = {}) {
    const headers = { "X-Requested-With": "agent-ui", ...(opts.headers || {}) };
    let body = opts.body;
    if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
    const res = await fetch(path, { ...opts, headers, body, credentials: "same-origin" });
    if (res.status === 401 && !path.startsWith("/api/login")) { showLogin(); throw new Error("انتهت الجلسة. سجّل الدخول."); }
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (!res.ok) throw Object.assign(new Error(data?.error || `خطأ ${res.status}`), { status: res.status, data });
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ——— الدخول
  function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); $("#password").focus(); }
  function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginError").textContent = "";
    try {
      await api("/api/login", { method: "POST", body: { password: $("#password").value } });
      $("#password").value = "";
      showApp(); boot();
    } catch (err) { $("#loginError").textContent = err.message; }
  });
  $("#logoutBtn").addEventListener("click", guard(async () => { await api("/api/logout", { method: "POST" }); showLogin(); }));

  // ——— التنقل
  let currentView = "chat";
  function go(view) {
    currentView = view;
    $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${view}`));
    $("#nav").classList.remove("open");
    ({ chat: loadConversations, tasks: loadTasks, memory: loadMemory, schedules: loadSchedules, files: loadFiles, approvals: loadApprovals, logs: loadLogs, settings: loadSettings })[view]?.();
  }
  $$("#nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
  $("#menuBtn").addEventListener("click", () => $("#nav").classList.toggle("open"));

  // ——— الحالة
  let status = null;
  async function loadStatus() {
    status = await api("/api/status");
    tz = status.timezone;
    const b = [];
    const claude = status.integrations.find((i) => i.id === "claude");
    b.push(`<span class="badge ${claude.connected ? "ok" : "off"}">${claude.connected ? "Claude موصول" : "Claude غير موصول"}</span>`);
    b.push(`<span class="badge ${status.webSearch ? "ok" : "off"}">${status.webSearch ? "البحث مفعّل" : "البحث غير مفعّل"}</span>`);
    const sch = status.integrations.find((i) => i.id === "scheduler");
    b.push(`<span class="badge ${sch.connected ? "ok" : "off"}">${sch.connected ? "المجدول يعمل" : "المجدول متوقف"}</span>`);
    b.push(`<span class="badge" title="التكلفة التقديرية آخر 24 ساعة">${fmtUsd(status.spentLast24hUsd)} / $${status.limits.dailyCostLimitUsd}</span>`);
    $("#statusBadges").innerHTML = b.join("");
    const c = $("#approvalCount");
    c.textContent = status.pendingApprovals;
    c.classList.toggle("hidden", !status.pendingApprovals);
    const n = $("#chatNotice");
    if (!claude.connected) { n.textContent = "Claude API غير موصول: أضف ANTHROPIC_API_KEY إلى ملف .env ثم أعد تشغيل الخادم. بقية الأقسام تعمل."; n.className = "notice err"; }
    else n.className = "notice hidden";
  }

  // ——— المحادثة
  let convId = null;
  let activeRunId = null;
  let attachments = []; // {id, name}

  async function loadConversations() {
    const list = await api("/api/conversations" + ($("#showScheduled").checked ? "" : "?source=chat"));
    $("#convList").innerHTML = list.map((c) => `
      <li class="${c.id === convId ? "active" : ""}" data-id="${c.id}">
        <button class="title" title="${esc(c.title)}">${c.source === "schedule" ? "" : ""}${esc(c.title)}</button>
        <button class="icon-btn del" title="حذف المحادثة">🗑</button>
      </li>`).join("") || `<li class="muted small">لا توجد محادثات بعد</li>`;
    $$("#convList li[data-id]").forEach((li) => {
      const cid = Number(li.dataset.id);
      $(".title", li).addEventListener("click", () => openConversation(cid));
      $(".del", li).addEventListener("click", guard(async () => {
        if (!confirm("حذف هذه المحادثة نهائيًا؟ لا يمكن التراجع.")) return;
        await api(`/api/conversations/${cid}`, { method: "DELETE" });
        if (cid === convId) newConversation();
        loadConversations();
      }));
    });
    if (convId === null && !$("#messages").children.length) renderEmpty();
  }
  $("#showScheduled").addEventListener("change", guard(loadConversations));

  function renderEmpty() {
    $("#messages").innerHTML = `<div class="empty">
      <h2>كيف أساعدك اليوم؟</h2>
      <p class="small">أمثلة: «رتّب مهامي لهذا الأسبوع حسب الأولوية» · «اكتب 5 إعلانات قصيرة لمنتج …» · «حلّل ملف المبيعات المرفق وأعطني أهم 3 ملاحظات» · «جدول تقريرًا أسبوعيًا عن المنتجات الرائجة»</p>
    </div>`;
  }

  function newConversation() {
    convId = null; activeRunId = null;
    $("#messages").innerHTML = "";
    renderEmpty();
    $$("#convList li").forEach((li) => li.classList.remove("active"));
    $("#chatInput").focus();
  }
  $("#newConv").addEventListener("click", newConversation);

  const openConversation = guard(async (cid) => {
    const c = await api(`/api/conversations/${cid}`);
    convId = c.id;
    const box = $("#messages");
    box.innerHTML = "";
    for (const m of c.messages) box.appendChild(renderMessage(m));
    if (!c.messages.length) renderEmpty();
    box.scrollTop = box.scrollHeight;
    $$("#convList li").forEach((li) => li.classList.toggle("active", Number(li.dataset.id) === cid));
    setRunning(c.activeRun ? c.activeRun.runId : null, c.activeRun ? "مهمة قيد التنفيذ (بدأت في جلسة أخرى)…" : "");
  });

  function renderSources(sources) {
    if (!sources?.length) return "";
    return `<div class="sources"><strong>المصادر:</strong><ol>${sources.map((s) =>
      `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>${s.page_age ? ` <span class="muted">(${esc(s.page_age)})</span>` : ""}</li>`).join("")}</ol></div>`;
  }

  function renderMessage(m) {
    const el = document.createElement("div");
    el.className = `msg ${m.role}`;
    if (m.role === "user") {
      el.textContent = m.text || "";
      if (m.attachments?.length) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.innerHTML = m.attachments.map((a) => `<span class="chip">📎 ${esc(a)}</span>`).join("");
        el.appendChild(meta);
      }
    } else {
      const tools = (m.tools || []).map((t) => `<span class="chip">${esc(toolNames[t] || t)}</span>`).join("");
      el.innerHTML = `<div class="md">${md(m.text || "")}</div>${renderSources(m.sources)}${tools ? `<div class="meta">${tools}</div>` : ""}`;
    }
    return el;
  }

  function setRunning(runId, info = "جارٍ التنفيذ…") {
    activeRunId = runId;
    $("#runBar").classList.toggle("hidden", !runId);
    $("#runInfo").textContent = info;
    $("#sendBtn").disabled = Boolean(runId);
  }

  $("#stopBtn").addEventListener("click", guard(async () => {
    if (!activeRunId) return;
    $("#runInfo").textContent = "جارٍ الإيقاف…";
    await api(`/api/runs/${activeRunId}/stop`, { method: "POST" });
  }));

  // المرفقات
  function renderAttachments() {
    $("#attachList").innerHTML = attachments.map((a, i) => `<span class="chip">📎 ${esc(a.name)} <button data-i="${i}" title="إزالة">✕</button></span>`).join("");
    $$("#attachList button").forEach((b) => b.addEventListener("click", () => { attachments.splice(Number(b.dataset.i), 1); renderAttachments(); }));
  }
  async function uploadFiles(fileList) {
    const fd = new FormData();
    for (const f of fileList) fd.append("files", f);
    const res = await fetch("/api/files", { method: "POST", body: fd, headers: { "X-Requested-With": "agent-ui" }, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new Error("انتهت الجلسة"); }
    for (const e of data.errors || []) toast(`${e.name}: ${e.error}`, true);
    if (!res.ok && !data.files?.length) throw new Error(data.error || data.errors?.[0]?.error || "فشل الرفع");
    return data.files || [];
  }
  $("#fileInput").addEventListener("change", guard(async (e) => {
    const saved = await uploadFiles(e.target.files);
    attachments.push(...saved.map((f) => ({ id: f.id, name: f.name })));
    renderAttachments();
    e.target.value = "";
  }));

  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chatForm").requestSubmit(); }
  });

  $("#chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#chatInput").value.trim();
    if ((!text && !attachments.length) || activeRunId) return;
    const box = $("#messages");
    if (box.querySelector(".empty")) box.innerHTML = "";
    box.appendChild(renderMessage({ role: "user", text, attachments: attachments.map((a) => a.name) }));
    const bubble = renderMessage({ role: "assistant", text: "" });
    box.appendChild(bubble);
    const mdEl = $(".md", bubble);
    const meta = document.createElement("div"); meta.className = "meta"; bubble.appendChild(meta);
    const srcEl = document.createElement("div"); bubble.insertBefore(srcEl, meta);
    mdEl.innerHTML = `<span class="muted">…</span>`;
    box.scrollTop = box.scrollHeight;

    const payload = { conversationId: convId, message: text, fileIds: attachments.map((a) => a.id) };
    $("#chatInput").value = "";
    attachments = []; renderAttachments();
    setRunning(-1, "جارٍ الإرسال…");

    let acc = "";
    let sources = [];
    const addChip = (label, cls = "") => { const s = document.createElement("span"); s.className = `chip ${cls}`; s.textContent = label; meta.appendChild(s); return s; };
    const handle = (ev) => {
      switch (ev.type) {
        case "conversation":
          if (convId !== ev.conversationId) { convId = ev.conversationId; loadConversations(); }
          setRunning(ev.runId);
          break;
        case "step": $("#runInfo").textContent = `جارٍ التنفيذ… الخطوة ${ev.step} من ${ev.maxSteps} كحد أقصى`; break;
        case "text":
          acc += ev.delta; mdEl.innerHTML = md(acc);
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
          break;
        case "tool":
          if (ev.status === "running") addChip(toolNames[ev.name] || ev.name);
          else if (ev.status === "error") addChip(`فشل ${toolNames[ev.name] || ev.name}: ${ev.result || ""}`, "err");
          else if (ev.status === "pending_approval") addChip(`${ev.result} — راجع الموافقات`, "pending");
          break;
        case "search": addChip(`بحث: ${ev.query || ""}`); break;
        case "sources":
          for (const s of ev.items) if (!sources.some((x) => x.url === s.url)) sources.push(s);
          srcEl.innerHTML = renderSources(sources);
          break;
        case "file": {
          const a = document.createElement("a");
          a.href = ev.file.url; a.className = "chip"; a.textContent = `⬇ ${ev.file.name}`;
          meta.appendChild(a);
          break;
        }
        case "approval": loadStatus().catch(() => {}); break;
        case "usage": $("#runInfo").textContent = `الخطوة ${ev.steps} · التكلفة التقديرية ${fmtUsd(ev.cost)}`; break;
        case "done": {
          if (!acc) mdEl.innerHTML = "";
          if (ev.status !== "completed" || ev.error) {
            const n = document.createElement("div");
            n.className = `notice ${ev.status === "failed" ? "err" : "warn"}`;
            n.textContent = `${L.run[ev.status] || ev.status}${ev.error ? ": " + ev.error : ""}`;
            bubble.appendChild(n);
          }
          const c = document.createElement("span"); c.className = "chip"; c.textContent = `${ev.steps || 0} خطوة · ${fmtUsd(ev.cost)}`; meta.appendChild(c);
          break;
        }
      }
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Requested-With": "agent-ui" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) showLogin();
        if (data.conversationId && !convId) { convId = data.conversationId; loadConversations(); }
        throw new Error(data.error || `خطأ ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) { try { handle(JSON.parse(line.slice(6))); } catch (err) { console.error(err); } }
        }
      }
    } catch (err) {
      mdEl.innerHTML = "";
      const n = document.createElement("div"); n.className = "notice err"; n.textContent = err.message; bubble.appendChild(n);
    } finally {
      setRunning(null);
      loadStatus().catch(() => {});
    }
  });

  // ——— المهام والمشاريع
  let projects = [];
  async function loadTasks() {
    projects = await api("/api/projects");
    const opts = `<option value="">بلا مشروع</option>` + projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    $$(".project-select").forEach((s) => { const v = s.value; s.innerHTML = opts; s.value = v; });
    $("#projectList").innerHTML = projects.map((p) => `
      <li data-id="${p.id}"><div class="body"><strong>${esc(p.name)}</strong> ${pill(p.status === "active" ? "confirmed" : "", L.project[p.status])}
        <div class="muted small">${p.done_count}/${p.task_count} مهام منجزة${p.description ? " · " + esc(p.description) : ""}</div></div>
        <div class="row"><select class="pstatus">${Object.entries(L.project).map(([k, v]) => `<option value="${k}" ${k === p.status ? "selected" : ""}>${v}</option>`).join("")}</select>
        <button class="btn small pdel">حذف</button></div></li>`).join("") || `<li class="muted small">لا توجد مشاريع</li>`;
    $$("#projectList li[data-id]").forEach((li) => {
      const pid = li.dataset.id;
      $(".pstatus", li).addEventListener("change", guard(async (e) => { await api(`/api/projects/${pid}`, { method: "PATCH", body: { status: e.target.value } }); loadTasks(); }));
      $(".pdel", li).addEventListener("click", guard(async () => {
        if (!confirm("حذف المشروع نهائيًا؟ ستبقى مهامه بلا مشروع.")) return;
        await api(`/api/projects/${pid}`, { method: "DELETE" }); loadTasks();
      }));
    });

    const f = $("#taskFilter").value;
    const q = f === "all" ? "?include_closed=true" : f ? `?status=${f}` : "";
    const [list, st] = await Promise.all([api("/api/tasks" + q), api("/api/status")]);
    const s = st.tasks;
    $("#taskSummary").innerHTML = `${pill("", `مفتوحة: ${s.open}`)} ${pill("", `قيد التنفيذ: ${s.in_progress}`)} ${pill(s.blocked ? "warn" : "", `متوقفة: ${s.blocked}`)} ${pill(s.overdue ? "overdue" : "", `متأخرة: ${s.overdue}`)} ${pill("done", `منجزة: ${s.done}`)}`;
    const nowIso = new Date().toISOString();
    $("#taskRows").innerHTML = list.map((t) => {
      const overdue = t.due_at && t.due_at < nowIso && !["done", "cancelled"].includes(t.status);
      return `<tr data-id="${t.id}">
        <td><strong>${esc(t.title)}</strong>${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ""}${t.notes ? `<div class="small">📝 ${esc(t.notes)}</div>` : ""}</td>
        <td><select class="tprio">${Object.entries(L.priority).map(([k, v]) => `<option value="${k}" ${k === t.priority ? "selected" : ""}>${v}</option>`).join("")}</select></td>
        <td><select class="tstatus">${Object.entries(L.status).map(([k, v]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${v}</option>`).join("")}</select></td>
        <td>${t.due_at ? `${overdue ? pill("overdue", "متأخرة") + " " : ""}${fmtDate(t.due_at)}` : "—"}</td>
        <td>${esc(t.project_name || "—")}</td>
        <td><button class="btn small tdel">حذف</button></td></tr>`;
    }).join("") || `<tr><td colspan="6" class="muted">لا توجد مهام</td></tr>`;
    $$("#taskRows tr[data-id]").forEach((tr) => {
      const tid = tr.dataset.id;
      $(".tprio", tr).addEventListener("change", guard(async (e) => { await api(`/api/tasks/${tid}`, { method: "PATCH", body: { priority: e.target.value } }); loadTasks(); }));
      $(".tstatus", tr).addEventListener("change", guard(async (e) => { await api(`/api/tasks/${tid}`, { method: "PATCH", body: { status: e.target.value } }); loadTasks(); }));
      $(".tdel", tr).addEventListener("click", guard(async () => {
        if (!confirm("حذف المهمة نهائيًا؟ (للإغلاق دون حذف اختر الحالة: ملغاة)")) return;
        await api(`/api/tasks/${tid}`, { method: "DELETE" }); loadTasks();
      }));
    });
  }
  $("#taskFilter").addEventListener("change", guard(loadTasks));
  $("#taskForm").addEventListener("submit", guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const body = { title: fd.title, description: fd.description, priority: fd.priority, due_at: fd.due_at ? new Date(fd.due_at).toISOString() : null, project_id: fd.project_id ? Number(fd.project_id) : null };
    await api("/api/tasks", { method: "POST", body });
    e.target.reset(); toast("أُضيفت المهمة"); loadTasks();
  }));
  $("#projectForm").addEventListener("submit", guard(async (e) => {
    e.preventDefault();
    await api("/api/projects", { method: "POST", body: { name: new FormData(e.target).get("name") } });
    e.target.reset(); loadTasks();
  }));

  // ——— الذاكرة
  async function loadMemory() {
    const p = new URLSearchParams();
    if ($("#memoryFilter").value) p.set("certainty", $("#memoryFilter").value);
    if ($("#memorySearch").value.trim()) p.set("q", $("#memorySearch").value.trim());
    const list = await api("/api/memory?" + p);
    $("#memoryList").innerHTML = list.map((m) => `
      <li data-id="${m.id}"><div class="body">
        <div class="row">${pill("", L.category[m.category])} ${pill(m.certainty, L.certainty[m.certainty])} <span class="muted small">${m.source === "agent" ? "أضافها الوكيل" : "أضفتها أنت"} · ${fmtDate(m.updated_at)}</span></div>
        <div class="content">${esc(m.content)}</div></div>
        <div class="row">${m.certainty === "inferred" ? `<button class="btn small mconfirm">تأكيد</button>` : ""}<button class="btn small medit">تعديل</button><button class="btn small mdel">حذف</button></div></li>`).join("")
      || `<li class="muted small">الذاكرة فارغة</li>`;
    $$("#memoryList li[data-id]").forEach((li) => {
      const mid = li.dataset.id;
      $(".mconfirm", li)?.addEventListener("click", guard(async () => { await api(`/api/memory/${mid}`, { method: "PATCH", body: { certainty: "confirmed" } }); loadMemory(); }));
      $(".medit", li).addEventListener("click", guard(async () => {
        const cur = $(".content", li).textContent;
        const next = prompt("تعديل المحتوى:", cur);
        if (next === null || next.trim() === cur) return;
        await api(`/api/memory/${mid}`, { method: "PATCH", body: { content: next } }); loadMemory();
      }));
      $(".mdel", li).addEventListener("click", guard(async () => {
        if (!confirm("حذف هذا العنصر من الذاكرة نهائيًا؟")) return;
        await api(`/api/memory/${mid}`, { method: "DELETE" }); loadMemory();
      }));
    });
  }
  $("#memoryFilter").addEventListener("change", guard(loadMemory));
  let memT; $("#memorySearch").addEventListener("input", () => { clearTimeout(memT); memT = setTimeout(guard(loadMemory), 300); });
  $("#memoryForm").addEventListener("submit", guard(async (e) => {
    e.preventDefault();
    await api("/api/memory", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset(); toast("حُفظت في الذاكرة"); loadMemory();
  }));

  // ——— المجدولة
  async function loadSchedules() {
    const [data, runs] = await Promise.all([api("/api/schedules"), api("/api/schedules/runs")]);
    const st = $("#schedulerState");
    st.className = `notice ${data.scheduler.running ? "" : "warn"}`;
    st.textContent = data.scheduler.running
      ? `المجدول يعمل (المنطقة الزمنية: ${data.scheduler.timezone}). ينفّذ المهام فقط ما دام الخادم يعمل؛ أي موعد يفوت أثناء توقف الخادم يُسجَّل "فائت" ولا يُنفَّذ بأثر رجعي. كل تشغيل يستهلك تكلفة API ضمن الحدود المضبوطة.`
      : "المجدول متوقف — المهام المجدولة لن تعمل. تحقق من SCHEDULER_ENABLED وأعد تشغيل الخادم.";
    $("#scheduleList").innerHTML = data.items.map((s) => `
      <li data-id="${s.id}"><div class="body">
        <strong>${esc(s.name)}</strong> <bdi class="ltr">${esc(s.cron)}</bdi> ${s.enabled ? pill("confirmed", "مفعّلة") : pill("warn", "موقوفة")} ${s.last_status ? pill(s.last_status, "آخر تشغيل: " + (L.run[s.last_status] || s.last_status)) : ""}
        <div class="muted small">التالي: ${s.enabled ? fmtDate(s.next_run_at) : "—"} · آخر تشغيل: ${fmtDate(s.last_run_at)}</div>
        <div class="small">${esc(s.prompt)}</div></div>
        <div class="row"><button class="btn small srun">تشغيل الآن</button><button class="btn small stoggle">${s.enabled ? "إيقاف" : "تفعيل"}</button><button class="btn small sdel">حذف</button></div></li>`).join("")
      || `<li class="muted small">لا توجد مهام مجدولة</li>`;
    $$("#scheduleList li[data-id]").forEach((li) => {
      const sid = li.dataset.id;
      const s = data.items.find((x) => String(x.id) === sid);
      $(".srun", li).addEventListener("click", guard(async () => { await api(`/api/schedules/${sid}/run`, { method: "POST" }); toast("بدأ التشغيل — النتيجة تظهر في سجل التنفيذ"); setTimeout(guard(loadSchedules), 1500); }));
      $(".stoggle", li).addEventListener("click", guard(async () => { await api(`/api/schedules/${sid}`, { method: "PATCH", body: { enabled: !s.enabled } }); loadSchedules(); }));
      $(".sdel", li).addEventListener("click", guard(async () => { if (!confirm("حذف المهمة المجدولة نهائيًا؟")) return; await api(`/api/schedules/${sid}`, { method: "DELETE" }); loadSchedules(); }));
    });
    $("#scheduleRuns").innerHTML = runs.map((r) => `<tr>
      <td>${esc(r.schedule_name || "#" + r.schedule_id)}</td><td>${pill(r.status, L.run[r.status] || r.status)}</td><td>${fmtDate(r.started_at)}</td>
      <td>${r.error ? `<div class="small" style="color:var(--danger)">${esc(r.error)}</div>` : ""}${r.summary ? `<details><summary class="small">عرض الملخص</summary><div class="md small">${md(r.summary)}</div></details>` : ""}
      ${r.conversation_id ? `<button class="btn small" data-conv="${r.conversation_id}">فتح المحادثة</button>` : ""}</td></tr>`).join("")
      || `<tr><td colspan="4" class="muted">لا توجد تشغيلات بعد</td></tr>`;
    $$("#scheduleRuns [data-conv]").forEach((b) => b.addEventListener("click", () => { $("#showScheduled").checked = true; go("chat"); openConversation(Number(b.dataset.conv)); }));
  }
  $("#cronPreset").addEventListener("change", (e) => { if (e.target.value) $("#scheduleForm [name=cron]").value = e.target.value; e.target.value = ""; });
  $("#scheduleForm").addEventListener("submit", guard(async (e) => {
    e.preventDefault();
    await api("/api/schedules", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset(); toast("أُنشئت المهمة المجدولة"); loadSchedules();
  }));

  // ——— الملفات
  async function loadFiles() {
    const [outs, ups] = await Promise.all([api("/api/files?kind=output"), api("/api/files?kind=upload")]);
    const item = (f, canView) => `<li data-id="${f.id}"><div class="body"><strong>${esc(f.name)}</strong><div class="muted small">${(f.size / 1024).toFixed(1)} KB · ${fmtDate(f.created_at)}</div></div>
      <div class="row">${canView ? `<a class="btn small" href="/api/files/${f.id}/download?inline=1" target="_blank" rel="noopener">عرض</a>` : ""}<a class="btn small" href="/api/files/${f.id}/download">تنزيل</a><button class="btn small fdel">حذف</button></div></li>`;
    $("#outputList").innerHTML = outs.map((f) => item(f, true)).join("") || `<li class="muted small">لم تُنشأ مخرجات بعد — اطلب من الوكيل إعداد تقرير.</li>`;
    $("#uploadList").innerHTML = ups.map((f) => item(f, false)).join("") || `<li class="muted small">لا توجد ملفات مرفوعة</li>`;
    $$("#outputList li[data-id], #uploadList li[data-id]").forEach((li) => $(".fdel", li).addEventListener("click", guard(async () => {
      if (!confirm("حذف الملف نهائيًا؟")) return;
      await api(`/api/files/${li.dataset.id}`, { method: "DELETE" }); loadFiles();
    })));
  }
  $("#filesUpload").addEventListener("change", guard(async (e) => {
    const saved = await uploadFiles(e.target.files);
    $("#uploadMsg").textContent = saved.length ? `رُفع ${saved.length} ملف. يمكنك إرفاقها في المحادثة أو ذكر رقمها للوكيل.` : "";
    e.target.value = ""; loadFiles();
  }));

  // ——— الموافقات
  async function loadApprovals() {
    const list = await api("/api/approvals");
    const pending = list.filter((p) => p.status === "pending");
    $("#pendingList").innerHTML = pending.map((p) => `<li data-id="${p.id}"><div class="body"><strong>#${p.id}</strong> ${esc(p.summary)}<div class="muted small">${fmtDate(p.created_at)} · الأداة: ${esc(p.tool)}</div></div>
      <div class="row"><button class="btn small primary approve">موافقة وتنفيذ</button><button class="btn small reject">رفض</button></div></li>`).join("")
      || `<li class="muted small">لا توجد طلبات معلّقة</li>`;
    $("#decidedList").innerHTML = list.filter((p) => p.status !== "pending").slice(0, 50).map((p) => `<li><div class="body">${pill(p.status, L.approval[p.status])} ${esc(p.summary)}<div class="muted small">${fmtDate(p.decided_at)}</div></div></li>`).join("")
      || `<li class="muted small">لا يوجد</li>`;
    $$("#pendingList li[data-id]").forEach((li) => {
      $(".approve", li).addEventListener("click", guard(async () => { await api(`/api/approvals/${li.dataset.id}/approve`, { method: "POST" }); toast("نُفّذ الإجراء"); loadApprovals(); loadStatus(); }));
      $(".reject", li).addEventListener("click", guard(async () => { await api(`/api/approvals/${li.dataset.id}/reject`, { method: "POST" }); loadApprovals(); loadStatus(); }));
    });
  }

  // ——— السجل
  async function loadLogs() {
    const lvl = $("#logLevel").value;
    const [logs, runs] = await Promise.all([api("/api/logs?limit=300" + (lvl ? `&level=${lvl}` : "")), api("/api/runs")]);
    $("#logRows").innerHTML = logs.map((l) => `<tr><td class="small">${fmtDate(l.created_at)}</td><td>${pill(l.level, L.level[l.level])}</td><td class="small">${esc(l.type)}</td>
      <td>${esc(l.message)}${l.data_json ? `<details><summary class="small muted">تفاصيل</summary><pre class="small" dir="ltr" style="white-space:pre-wrap">${esc(l.data_json)}</pre></details>` : ""}</td><td>${l.run_id ?? "—"}</td></tr>`).join("")
      || `<tr><td colspan="5" class="muted">لا توجد سجلات</td></tr>`;
    $("#runRows").innerHTML = runs.map((r) => `<tr><td>${r.id}</td><td>${r.source === "schedule" ? "مجدول" : "محادثة"}</td><td>${pill(r.status, L.run[r.status])}</td><td>${r.steps}</td>
      <td>${fmtUsd(r.cost_usd)}${r.web_searches ? ` <span class="muted small">(${r.web_searches} بحث)</span>` : ""}</td><td class="small">${fmtDate(r.started_at)}</td><td class="small">${esc(r.error || "")}</td></tr>`).join("")
      || `<tr><td colspan="7" class="muted">لا توجد تشغيلات</td></tr>`;
  }
  $("#logLevel").addEventListener("change", guard(loadLogs));
  $("#refreshLogs").addEventListener("click", guard(loadLogs));

  // ——— الإعدادات
  async function loadSettings() {
    await loadStatus();
    const f = $("#limitsForm");
    for (const [k, v] of Object.entries(status.limits)) f.elements[k].value = v;
    $("#spendInfo").textContent = `التكلفة التقديرية آخر 24 ساعة: ${fmtUsd(status.spentLast24hUsd)}. النموذج: ${status.model}. الأرقام تقديرية من عدد التوكنات، والفاتورة الرسمية في Claude Console.`;
    $("#integrationList").innerHTML = status.integrations.map((i) => `<li><div class="body"><strong>${esc(i.name)}</strong> ${i.connected ? pill("confirmed", "موصول") : pill("warn", "غير موصول")}<div class="muted small">${esc(i.detail)}</div></div></li>`).join("");
  }
  $("#limitsForm").addEventListener("submit", guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
    await api("/api/settings/limits", { method: "PUT", body });
    $("#limitsMsg").textContent = "حُفظت الحدود ✓"; loadStatus();
  }));

  // ——— الإقلاع
  function boot() {
    loadStatus().catch((e) => toast(e.message, true));
    go(currentView);
    clearInterval(boot._t);
    boot._t = setInterval(() => { if (!document.hidden) loadStatus().catch(() => {}); }, 30000);
  }
  api("/api/me").then((me) => {
    if (!me.authConfigured) { showLogin(); $("#loginError").textContent = "لم تُضبط كلمة مرور على الخادم (APP_PASSWORD)."; return; }
    if (me.authenticated) { showApp(); boot(); } else showLogin();
  }).catch(() => showLogin());
})();
