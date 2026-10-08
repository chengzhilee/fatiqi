/* 罚题器 前端逻辑（原生 JS，无框架）
 * 结构：连接服务 → 题库（类别/套卷/上传提取）→ 刷题（选题/抽题/倒计时）→ 结果
 */
"use strict";

/* ================= 小工具 ================= */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, type) {
  const box = $("#toast");
  const t = document.createElement("div");
  t.className = "toast-item" + (type ? " " + type : "");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), type === "err" ? 4200 : 2600);
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

function zoomImage(src) {
  const m = openModal(`
    <div class="modal-head">查看原图<button class="x">✕</button></div>
    <div class="modal-body" style="text-align:center;"><img src="${src}" style="max-width:100%;" alt="原图"></div>`);
  m.querySelector(".x").onclick = () => closeModal(m);
  m.querySelector(".modal-mask").addEventListener("click", () => closeModal(m));
}

/* 套卷里的切图地址 */
function qImgUrl(setId, name) {
  return `${API}/files/${encodeURIComponent(setId + "/" + name)}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================= 弹窗 ================= */
function openModal(innerHtml) {
  const layer = $("#modal-layer");
  layer.classList.remove("hidden");
  const stack = document.createElement("div");
  stack.className = "modal-stack";
  stack.innerHTML = `<div class="modal-mask"></div><div class="modal">${innerHtml}</div>`;
  layer.appendChild(stack);
  stack.querySelector(".modal-mask").addEventListener("click", () => closeModal(stack));
  return stack;
}
function closeModal(stack) {
  stack.remove();
  if (!$("#modal-layer").children.length) $("#modal-layer").classList.add("hidden");
}
function confirmModal(text, onOk, okLabel) {
  const m = openModal(`
    <div class="modal-head">确认操作<button class="x">✕</button></div>
    <div class="modal-body" style="line-height:1.8;">${esc(text)}</div>
    <div class="modal-foot">
      <button class="btn ghost" data-c>取消</button>
      <button class="btn danger" data-ok>${esc(okLabel || "确认")}</button>
    </div>`);
  m.querySelector(".x").onclick = () => closeModal(m);
  m.querySelector("[data-c]").onclick = () => closeModal(m);
  m.querySelector("[data-ok]").onclick = () => { closeModal(m); onOk(); };
}

/* ================= 连接本地服务 ================= */
const IS_FILE = location.protocol === "file:";
const PORTS = [];
for (let p = 8765; p <= 8775; p++) PORTS.push(p);
let API = "";

async function connect() {
  if (!IS_FILE) { setConn(true); return true; }
  const cached = +(localStorage.getItem("fatiqi_port") || 0);
  const ports = cached && PORTS.includes(cached)
    ? [cached, ...PORTS.filter(p => p !== cached)] : PORTS;
  let found = 0;
  try {
    const results = await Promise.all(ports.map(async p => {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/ping`,
          { cache: "no-store", signal: (AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined) });
        const j = await r.json();
        return j && j.app === "罚题器" ? p : 0;
      } catch (e) { return 0; }
    }));
    found = results.find(Boolean) || 0;
  } catch (e) { /* 忽略 */ }
  if (found) {
    API = `http://127.0.0.1:${found}`;
    localStorage.setItem("fatiqi_port", found);
    setConn(true);
    return true;
  }
  setConn(false);
  toast("连不上本地服务：请先双击「启动罚题器.bat」", "err");
  return false;
}
function setConn(on) {
  const c = $("#conn");
  c.classList.toggle("on", on);
  c.innerHTML = `<span class="dot"></span>` + (on ? "已连接本地服务" : "未连接服务（先双击启动 bat）");
}

async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || "GET" };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "Content-Type": "application/json" };
  }
  let res;
  try {
    res = await fetch(API + path, init);
  } catch (e) {
    setConn(false);
    throw new Error("连不上本地服务，请确认「启动罚题器.bat」正在运行");
  }
  setConn(true);
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok) throw new Error((data && data.error) || ("请求失败 " + res.status));
  return data;
}

/* ================= 全局状态 ================= */
const state = {
  cats: [],
  curCatId: null,
  sets: [],
  expandedSetId: null,
  practiceCatId: null,
  lastPractice: null,
};

/* ================= 题库：类别 ================= */
async function loadCats() {
  state.cats = await api("/api/categories");
  if (!state.cats.length) { renderCats(); renderSets(); return; }
  if (!state.cats.some(c => c.id === state.curCatId)) {
    const saved = localStorage.getItem("fatiqi_cat");
    state.curCatId = state.cats.some(c => c.id === saved) ? saved : state.cats[0].id;
  }
  renderCats();
  await loadSets();
}

function renderCats() {
  const box = $("#cat-list");
  box.innerHTML = "";
  for (const c of state.cats) {
    const d = document.createElement("div");
    d.className = "cat-item" + (c.id === state.curCatId ? " active" : "");
    d.innerHTML = `<span>${esc(c.name)}</span><span style="color:inherit;opacity:.65;font-size:12px;">${c.setCount}套</span><button class="del" title="删除类别">✕</button>`;
    d.addEventListener("click", e => {
      if (e.target.classList.contains("del")) return;
      state.curCatId = c.id;
      localStorage.setItem("fatiqi_cat", c.id);
      renderCats();
      loadSets();
    });
    d.querySelector(".del").addEventListener("click", () => {
      confirmModal(`删除类别「${c.name}」会连同它下面所有套卷、题目和上传的原卷附件一起删除，确定吗？`,
        async () => {
          await api("/api/categories/" + c.id, { method: "DELETE" });
          if (state.curCatId === c.id) state.curCatId = null;
          toast("已删除类别「" + c.name + "」");
          loadCats();
        }, "删除");
    });
    box.appendChild(d);
  }
}

$("#btn-add-cat").addEventListener("click", () => {
  const m = openModal(`
    <div class="modal-head">新建类别<button class="x">✕</button></div>
    <div class="modal-body">
      <div class="form-row"><label>类别名称</label><input id="m-cat-name" placeholder="例如：考研数学 / 六级英语"></div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-c>取消</button>
      <button class="btn" data-ok>创建</button>
    </div>`);
  m.querySelector(".x").onclick = () => closeModal(m);
  m.querySelector("[data-c]").onclick = () => closeModal(m);
  const input = m.querySelector("#m-cat-name");
  input.focus();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return toast("类别名称不能为空", "err");
    const cat = await api("/api/categories", { method: "POST", body: { name } });
    closeModal(m);
    toast("已创建类别「" + cat.name + "」", "ok");
    state.curCatId = cat.id;
    localStorage.setItem("fatiqi_cat", cat.id);
    loadCats();
  };
  m.querySelector("[data-ok]").onclick = submit;
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
});

/* ================= 题库：套卷 ================= */
async function loadSets() {
  if (!state.curCatId) { renderSets(); return; }
  try {
    state.sets = await api("/api/sets?categoryId=" + state.curCatId);
  } catch (e) { state.sets = []; toast(e.message, "err"); }
  renderSets();
}

function attachmentHtml(att) {
  if (!att) return `<span class="set-file none">无附件</span>`;
  const href = `${API}/files/${encodeURIComponent(att.stored)}`;
  const icon = att.kind === "pdf" ? "📄 PDF" : "📝 Word";
  return `<a class="set-file" href="${href}" target="_blank" title="点击打开原卷附件">${icon} 原卷 · ${esc(att.filename)}（${fmtSize(att.size)}）</a>`;
}

function renderSets() {
  const area = $("#sets-area");
  area.innerHTML = "";
  if (!state.curCatId) {
    area.innerHTML = `<div class="empty-hint">先在左侧选择或新建一个类别，再上传试卷。</div>`;
    return;
  }
  const cat = state.cats.find(c => c.id === state.curCatId);
  if (!state.sets.length) {
    area.innerHTML = `<div class="empty-hint">「${esc(cat ? cat.name : "")}」下还没有套卷，把试卷 PDF/Word 拖到上面上传吧。</div>`;
    return;
  }
  for (const s of state.sets) {
    const card = document.createElement("div");
    card.className = "set-card";
    card.dataset.id = s.id;
    card.innerHTML = `
      <div class="set-head">
        <span class="set-name">${esc(s.name)}</span>
        <span class="set-count">${s.questionCount} 题</span>
        ${attachmentHtml(s.attachment)}
        <div class="set-actions">
          <button class="btn ghost small" data-act="practice">刷这套</button>
          <button class="btn ghost small" data-act="toggle">管理题目</button>
          <button class="btn danger small" data-act="del">删除</button>
        </div>
      </div>
      <div class="q-list hidden"></div>`;
    card.querySelector('[data-act="practice"]').onclick = () => {
      switchTab("practice", () => {
        state.practiceCatId = s.categoryId;
        return refreshPractice().then(() => {
          $$('#p-sets input').forEach(cb => { cb.checked = cb.dataset.setId === s.id; });
          updatePoolInfo();
        });
      });
    };
    card.querySelector('[data-act="del"]').onclick = () => {
      confirmModal(`删除套卷「${s.name}」？题目和原卷附件都会被删除。`, async () => {
        await api("/api/sets/" + s.id, { method: "DELETE" });
        toast("已删除「" + s.name + "」");
        loadCats();
      }, "删除");
    };
    card.querySelector('[data-act="toggle"]').onclick = async () => {
      const list = card.querySelector(".q-list");
      if (!list.classList.contains("hidden")) {
        list.classList.add("hidden");
        state.expandedSetId = null;
        return;
      }
      $$(".q-list").forEach(x => x.classList.add("hidden"));
      list.classList.remove("hidden");
      state.expandedSetId = s.id;
      list.innerHTML = `<div class="empty-hint">加载中…</div>`;
      try {
        const full = await api("/api/sets/" + s.id);
        renderQList(list, full);
      } catch (e) { list.innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`; }
    };
    if (state.expandedSetId === s.id) card.querySelector('[data-act="toggle"]').click();
    area.appendChild(card);
  }
}

function renderQList(list, fullSet) {
  list.innerHTML = "";
  const qs = fullSet.questions || [];
  if (!qs.length) {
    list.innerHTML = `<div class="empty-hint">这套卷还没有题目（可能提取失败），点下面手动添加。</div>`;
  }
  qs.forEach((q, i) => {
    const row = document.createElement("div");
    row.className = "q-row";
    const thumb = q.stemImg
      ? `<img class="q-thumb" src="${qImgUrl(fullSet.id, q.stemImg)}" alt="题干切图">` : "";
    const stemText = q.stem ? esc(q.stem) : `<i style="color:var(--ink-2);">（原卷切图）</i>`;
    row.innerHTML = `
      <span class="no">${i + 1}</span>
      ${thumb}
      <span class="stem">${stemText}</span>
      ${q.ansImg ? `<span class="ans" style="color:var(--ok);">有答案截图</span>`
        : `<span class="ans ${q.answer ? "" : "empty"}">答：${q.answer ? esc(q.answer) : "（未录入）"}</span>`}`;
    row.onclick = () => editQuestion(fullSet, i);
    list.appendChild(row);
  });
  const add = document.createElement("button");
  add.className = "ghost";
  add.textContent = "＋ 手动添加题目";
  add.onclick = () => editQuestion(fullSet, -1);
  list.appendChild(add);
}

/* 层二·手动兜底：在原卷页面上点两下（上边缘、下边缘）重新裁切图 */
async function openRecrop(fullSet, q, which, onUpdate) {
  if (!fullSet.attachment) return toast("这套卷没有原卷附件，无法重切", "err");
  const m = openModal(`
    <div class="modal-head">✂️ 调整切图<button class="x">✕</button></div>
    <div class="modal-body">
      <div class="rv-note" data-tip>在原卷上<b>点第一下</b> = 本题开头 · <b>点第二下</b> = 本题结尾，然后选下面按钮。点错就点「重新点」。</div>
      <canvas class="recrop-cv" style="width:100%;cursor:crosshair;border:1px solid var(--line);border-radius:8px;"></canvas>
    </div>
    <div class="modal-foot" style="flex-wrap:wrap;">
      <button class="btn ghost small" data-prev>上一页</button>
      <button class="btn ghost small" data-next>下一页</button>
      <span class="p-label" data-pn style="min-width:0;"></span>
      <button class="btn ghost small" data-reset>重新点</button>
      <button class="btn small" data-stem disabled>设为题干图</button>
      <button class="btn small" data-ans disabled style="background:var(--ok);">设为答案图</button>
      <button class="btn small" data-split disabled>↪ 拆为新题</button>
    </div>`);
  m.querySelector(".x").onclick = () => closeModal(m);

  const tip = m.querySelector("[data-tip]");
  const pn = m.querySelector("[data-pn]");
  const cv = m.querySelector(".recrop-cv");
  const bStem = m.querySelector("[data-stem]");
  const bAns = m.querySelector("[data-ans]");
  const bSplit = m.querySelector("[data-split]");
  const state = {
    page: (which === "ans" ? q.ansPage : q.stemPage) || 1,
    clicks: [], doc: null, rendered: null,
  };

  const r = await fetch(API + "/files/" + encodeURIComponent(fullSet.attachment.stored));
  const buf = new Uint8Array(await r.arrayBuffer());
  state.doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  state.maxPage = state.doc.numPages;

  async function draw() {
    try {
      const page = await state.doc.getPage(state.page);
      const vp = page.getViewport({ scale: 2 });
      cv.width = vp.width;
      cv.height = vp.height;
      const cctx = cv.getContext("2d");
      await page.render({ canvasContext: cctx, viewport: vp }).promise;
      if (state.clicks.length >= 2) {
        const [a, b] = [...state.clicks].sort((x, y) => x - y);
        cctx.fillStyle = "rgba(240,101,58,.22)";
        cctx.fillRect(0, a, cv.width, b - a);
        cctx.fillStyle = "#f0653a";
        cctx.fillRect(0, a, cv.width, 3);
        cctx.fillRect(0, b - 3, cv.width, 3);
      }
      pn.textContent = `第 ${state.page} / ${state.maxPage} 页`;
    } catch (e) {
      tip.textContent = "渲染出错：" + e.message;
    }
    tip.innerHTML = state.clicks.length === 0
      ? `在原卷上<b>点第一下</b> = 本题开头`
      : state.clicks.length === 1
        ? `再<b>点第二下</b> = 本题结尾`
        : `选好了 → 点右侧按钮（橙色区即新切图范围）`;
    bStem.disabled = bAns.disabled = bSplit.disabled = state.clicks.length < 2;
  }

  cv.addEventListener("click", e => {
    const rect = cv.getBoundingClientRect();
    const y = Math.round((e.clientY - rect.top) * (cv.height / rect.height));
    if (state.clicks.length >= 2) state.clicks = [];
    state.clicks.push(y);
    draw();
  });
  m.querySelector("[data-reset]").onclick = () => { state.clicks = []; draw(); };
  m.querySelector("[data-prev]").onclick = () => {
    if (state.page > 1) { state.page--; state.clicks = []; draw(); }
  };
  m.querySelector("[data-next]").onclick = () => {
    if (state.page < state.maxPage) { state.page++; state.clicks = []; draw(); }
  };
  const applyBand = () => {
    const [a, b] = [...state.clicks].sort((x, y) => x - y);
    const c = document.createElement("canvas");
    c.width = cv.width; c.height = Math.max(8, b - a);
    c.getContext("2d").drawImage(cv, 0, a, cv.width, c.height, 0, 0, cv.width, c.height);
    return c.toDataURL("image/png");
  };
  bStem.onclick = () => { onUpdate({ data: applyBand(), page: state.page, action: "stem" }); closeModal(m); };
  bAns.onclick = () => { onUpdate({ data: applyBand(), page: state.page, action: "ans" }); closeModal(m); };
  bSplit.onclick = () => { onUpdate({ data: applyBand(), page: state.page, action: "split" }); closeModal(m); };
  await draw();
}

function editQuestion(fullSet, index) {
  const isNew = index < 0;
  const q = isNew ? { stem: "", answer: "" } : fullSet.questions[index];
  const canRecrop = !isNew && !!fullSet.attachment && (q.stemImg || q.ansImg);
  const stemImg = !isNew && (q.stemImg || q.stemImgData)
    ? `<div class="rv-q-head"><span class="no">原卷切图（点击放大）</span></div>
       <img class="rv-img" data-role="stemimg"
            src="${q.stemImgData || qImgUrl(fullSet.id, q.stemImg)}" alt="题干切图">` : "";
  const ansImg = !isNew && (q.ansImg || q.ansImgData)
    ? `<div class="rv-q-head"><span class="no" style="color:var(--ok);">答案切图（点击放大）</span></div>
       <img class="rv-img" data-role="ansimg"
            src="${q.ansImgData || qImgUrl(fullSet.id, q.ansImg)}" alt="答案切图">` : "";
  const m = openModal(`
    <div class="modal-head">${isNew ? "添加题目" : "编辑第 " + (index + 1) + " 题"}<button class="x">✕</button></div>
    <div class="modal-body">
      <div class="rv-note">套卷：${esc(fullSet.name)}${q.stemImg || q.ansImg ? " —— 本题带原卷切图，做题时以图为准，下方文字仅作备注。" : " —— 原卷以附件 PDF 为准。"}</div>
      <div class="rv-q">
        ${stemImg}
        <div class="rv-q-head"><span class="no">题干文字（备注）</span></div>
        <textarea class="stem" rows="5">${esc(q.stem)}</textarea>
        ${ansImg}
        <div class="rv-q-head"><span class="no" style="color:var(--ok);">答案文字（备注）</span></div>
        <textarea class="ans" rows="4" placeholder="可留空">${esc(q.answer)}</textarea>
      </div>
    </div>
    <div class="modal-foot" style="flex-wrap:wrap;">
      ${isNew ? "" : `<button class="btn danger" data-del style="margin-right:auto;">删除该题</button>`}
      ${canRecrop ? `<button class="btn ghost" data-recrop style="margin-right:auto;">✂️ 调整切图（点两下重裁）</button>` : ""}
      ${!isNew && index > 0 ? `<button class="btn ghost" data-merge>⬆️ 并入上一题</button>` : ""}
      <button class="btn ghost" data-c>取消</button>
      <button class="btn" data-ok>保存</button>
    </div>`);
  $$(".rv-img", m).forEach(img => img.onclick = () => zoomImage(img.src));
  m.querySelector(".x").onclick = () => closeModal(m);
  m.querySelector("[data-c]").onclick = () => closeModal(m);
  const recropBtn = m.querySelector("[data-recrop]");
  if (recropBtn) recropBtn.onclick = () => {
    openRecrop(fullSet, q, "stem", up => {
      if (up.action === "stem") {
        q.stemImgData = up.data;
        q.stemPage = up.page;
        const img = m.querySelector('[data-role="stemimg"]');
        if (img) img.src = up.data;
        toast("题干切图已更新，点「保存」生效", "ok");
      } else if (up.action === "ans") {
        q.ansImgData = up.data;
        q.ansPage = up.page;
        const img = m.querySelector('[data-role="ansimg"]');
        if (img) img.src = up.data;
        toast("答案切图已更新，点「保存」生效", "ok");
      } else if (up.action === "split") {
        confirmModal("把选中区域拆成一道新题（排在当前题后面）？", async () => {
          const questions = fullSet.questions.slice();
          questions.splice(index + 1, 0, {
            stem: "（拆分新题，请补题干备注）", answer: "",
            stemImgData: up.data, stemPage: up.page, source: "crop",
          });
          await api("/api/sets/" + fullSet.id, { method: "PUT", body: { questions } });
          closeModal(m);
          toast("已拆出新题", "ok");
          loadCats().then(refreshPractice);
        }, "拆分");
      }
    });
  };
  const mergeBtn = m.querySelector("[data-merge]");
  if (mergeBtn) mergeBtn.onclick = () => {
    confirmModal("把本题并入上一题？（两题的切图和文字会合并为一题）", async () => {
      const questions = fullSet.questions.slice();
      const cur = questions[index];
      const prev = questions[index - 1];
      prev.stem = (prev.stem ? prev.stem + "\n" : "") + cur.stem;
      prev.answer = (prev.answer ? prev.answer + "\n" : "") + cur.answer;
      if (!prev.stemImg && cur.stemImg) { prev.stemImg = cur.stemImg; prev.stemPage = cur.stemPage; }
      if (!prev.ansImg && cur.ansImg) { prev.ansImg = cur.ansImg; prev.ansPage = cur.ansPage; }
      questions.splice(index, 1);
      await api("/api/sets/" + fullSet.id, { method: "PUT", body: { questions } });
      closeModal(m);
      toast("已并入上一题", "ok");
      loadCats().then(refreshPractice);
    }, "并入");
  };
  m.querySelector("[data-ok]").onclick = async () => {
    const stem = m.querySelector(".stem").value.trim();
    const answer = m.querySelector(".ans").value.trim();
    if (!stem && !q.stemImg) return toast("题干不能为空", "err");
    const questions = fullSet.questions.slice();
    if (isNew) questions.push({ stem, answer, source: "manual" });
    else questions[index] = { ...questions[index], stem, answer };
    await api("/api/sets/" + fullSet.id, { method: "PUT", body: { questions } });
    closeModal(m);
    toast("已保存", "ok");
    loadCats().then(refreshPractice);
  };
  const delBtn = m.querySelector("[data-del]");
  if (delBtn) delBtn.onclick = () => {
    confirmModal("删除这道题？", async () => {
      const questions = fullSet.questions.slice();
      questions.splice(index, 1);
      await api("/api/sets/" + fullSet.id, { method: "PUT", body: { questions } });
      closeModal(m);
      toast("已删除该题", "ok");
      loadCats().then(refreshPractice);
    }, "删除");
  };
}

/* ================= 上传与自动提取 ================= */
const dz = $("#drop-zone");
const fileInput = $("#file-input");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", e => {
  e.preventDefault();
  dz.classList.remove("over");
  if (e.dataTransfer.files.length) processFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) processFiles([...fileInput.files]);
  fileInput.value = "";
});

async function processFiles(files) {
  for (const f of files) {
    try { await uploadOne(f); }
    catch (e) { toast(`「${f.name}」上传失败：${e.message}`, "err"); }
  }
}

function uploadModalHtml(filename) {
  const catOptions = state.cats.map(c =>
    `<option value="${c.id}" ${c.id === state.curCatId ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  return `
    <div class="modal-head">上传试卷<button class="x">✕</button></div>
    <div class="modal-body">
      <div class="form-row"><label>文件</label><span style="font-weight:600;">${esc(filename)}</span></div>
      <div class="form-row"><label>存入类别</label><select id="up-cat">${catOptions}</select></div>
      <div class="form-row"><label>套卷名称</label><input id="up-name" value="${esc(filename.replace(/\.(pdf|docx?|doc)$/i, ""))}"></div>
      <div id="up-status"></div>
      <div id="up-questions"></div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-c>取消</button>
      <button class="btn ghost hidden" id="up-addq">＋ 手动加一题</button>
      <button class="btn ghost hidden" id="up-ocr" title="把每页渲染成图片后用 Windows 自带离线 OCR 识别成文字，较慢">🔍 OCR 文字识别</button>
      <button class="btn ghost hidden" id="up-crop" title="题目区域直接裁成原图贴进题库：公式图形零损失，推荐公式多的卷子使用">✂️ 按原卷切图</button>
      <button class="btn" id="up-extract">① 提取题目</button>
      <button class="btn hidden" id="up-save">② 保存入库</button>
    </div>`;
}

async function uploadOne(file) {
  const ext = (file.name.match(/\.(pdf|docx?|doc)$/i) || [])[0];
  if (!ext) return toast("不支持的文件类型：" + file.name, "err");
  const m = openModal(uploadModalHtml(file.name));
  m.querySelector(".x").onclick = () => closeModal(m);
  m.querySelector("[data-c]").onclick = () => closeModal(m);
  const status = m.querySelector("#up-status");
  const qbox = m.querySelector("#up-questions");
  const btnExtract = m.querySelector("#up-extract");
  const btnOcr = m.querySelector("#up-ocr");
  const btnCrop = m.querySelector("#up-crop");
  const btnSave = m.querySelector("#up-save");
  const btnAdd = m.querySelector("#up-addq");
  let uploadMeta = null;
  let questions = [];

  const isPdf = /\.pdf$/i.test(file.name);
  if (isPdf) btnCrop.classList.remove("hidden");

  async function ensureUploaded() {
    if (uploadMeta) return uploadMeta;
    const fd = new FormData();
    fd.append("file", file, file.name);
    uploadMeta = await api("/api/upload", { method: "POST", body: fd });
    return uploadMeta;
  }

  btnCrop.addEventListener("click", async () => {
    btnCrop.disabled = true; btnOcr.disabled = true; btnExtract.disabled = true;
    status.innerHTML = `<div class="rv-note"><span class="spinner"></span>上传中…</div>`;
    try {
      await ensureUploaded();
      questions = await cropFromPdf(file, (p, n) => {
        status.innerHTML = `<div class="rv-note"><span class="spinner"></span>切图中：渲染并识别第 ${p} / ${n} 页…</div>`;
      });
      if (questions.length) {
        status.innerHTML = `<div class="rv-note">✂️ 切出 ${questions.length} 道题、其中 ${questions.filter(q => q.ansImgData).length} 道带答案截图。看一眼每张切图，切坏或多余的删掉（比如注意事项被切进来的），没问题就保存入库。</div>`;
      } else {
        status.innerHTML = `<div class="rv-note">⚠️ 没切出题目（版式可能太特殊）。可以试试「🔍 OCR 文字识别」，或只存附件后手动加题。</div>`;
      }
      renderReview();
      btnAdd.classList.remove("hidden");
      btnSave.classList.remove("hidden");
    } catch (e) {
      status.innerHTML = `<div class="rv-note" style="background:#fdeceb;border-color:#f3c2bd;color:var(--bad);">❌ 切图失败：${esc(e.message)}</div>`;
    } finally {
      btnCrop.disabled = false; btnOcr.disabled = false; btnExtract.disabled = false;
    }
  });

  btnOcr.addEventListener("click", async () => {
    btnOcr.disabled = true;
    btnExtract.disabled = true;
    status.innerHTML = `<div class="rv-note"><span class="spinner"></span>OCR 识别中：第 1 页…</div>`;
    try {
      const ocrLines = await ocrPdfLines(file, (p, n) => {
        status.innerHTML = `<div class="rv-note"><span class="spinner"></span>OCR 识别中：第 ${p} / ${n} 页…</div>`;
      });
      questions = parseExam(ocrLines);
      if (questions.length) {
        status.innerHTML = `<div class="rv-note">🔍 OCR 识别出 ${questions.length} 道题、其中 ${questions.filter(q => q.answer).length} 道带答案。公式和符号识别可能有误差，请重点校对，原卷以附件为准。</div>`;
      } else {
        status.innerHTML = `<div class="rv-note">⚠️ OCR 也没识别出题目（版式可能太特殊）。可以直接保存附件，之后在题库里手动加题。</div>`;
      }
      renderReview();
      btnAdd.classList.remove("hidden");
      btnSave.classList.remove("hidden");
    } catch (e) {
      status.innerHTML = `<div class="rv-note" style="background:#fdeceb;border-color:#f3c2bd;color:var(--bad);">❌ OCR 失败：${esc(e.message)}</div>`;
    } finally {
      btnOcr.disabled = false;
      btnExtract.disabled = false;
    }
  });

  btnAdd.onclick = () => {
    questions.push({ stem: "", answer: "", source: "manual" });
    renderReview();
  };

  function renderReview() {
    const name = m.querySelector("#up-name").value.trim() || file.name;
    qbox.innerHTML = questions.map((q, i) => {
      if (q.stemImgData) {
        // 切图题：展示题干/答案截图缩略图
        return `
      <div class="rv-q" data-i="${i}">
        <div class="rv-q-head"><span class="no">第 ${i + 1} 题（原卷切图）</span>
          <button class="del" title="删除该题">删除</button></div>
        <div class="rv-imgs">
          <div class="rv-img-box"><span class="tag-l">题干</span>
            <img class="rv-img" src="${q.stemImgData}" alt="题干切图"></div>
          ${q.ansImgData ? `<div class="rv-img-box"><span class="tag-l" style="color:var(--ok);">答案</span>
            <img class="rv-img" src="${q.ansImgData}" alt="答案切图"></div>` : ""}
        </div>
      </div>`;
      }
      return `
      <div class="rv-q" data-i="${i}">
        <div class="rv-q-head"><span class="no">第 ${i + 1} 题</span>
          <button class="del" title="删除该题">删除</button></div>
        <textarea class="stem" rows="${Math.max(3, Math.min(10, Math.ceil(q.stem.length / 55)))}">${esc(q.stem)}</textarea>
        <textarea class="ans" rows="${Math.max(2, Math.min(8, Math.ceil((q.answer || "").length / 55)))}"
          placeholder="答案（可留空，稍后可补）">${esc(q.answer)}</textarea>
      </div>`;
    }).join("");
    $$(".rv-q", qbox).forEach(row => {
      const i = +row.dataset.i;
      row.querySelector(".del").onclick = () => {
        questions.splice(i, 1);
        renderReview();
      };
      const stem = row.querySelector(".stem");
      if (stem) stem.addEventListener("input", e => { questions[i].stem = e.target.value; });
      const ans = row.querySelector(".ans");
      if (ans) ans.addEventListener("input", e => { questions[i].answer = e.target.value; });
      const img = row.querySelector(".rv-img");
      if (img) img.onclick = () => zoomImage(img.src);
    });
    if (!questions.length) {
      qbox.innerHTML = `<div class="empty-hint">没有识别出题目。仍可保存（附件会贴在套卷旁），之后在题库里手动添加题目。</div>`;
    }
  }

  btnExtract.onclick = async () => {
    const nameInput = m.querySelector("#up-name").value.trim();
    if (!nameInput) return toast("请填写套卷名称", "err");
    btnExtract.disabled = true;
    btnExtract.innerHTML = `<span class="spinner"></span>上传并提取中…`;
    status.innerHTML = "";
    try {
      // 1) 上传原件
      const fd = new FormData();
      fd.append("file", file, file.name);
      uploadMeta = await api("/api/upload", { method: "POST", body: fd });
      // 2) 客户端提取文本并拆题
      let lines = [];
      let warn = "";
      if (uploadMeta.kind === "pdf") {
        lines = await extractPdfLines(file);
        if (!lines.length) warn = "这个 PDF 没有提取到文字，可能是扫描件（纯图片）。";
      } else if (uploadMeta.kind === "docx") {
        lines = await extractDocxLines(file);
      } else {
        warn = "老版 .doc 格式无法自动提取，建议另存为 .docx 或 PDF 后重新上传；也可以直接保存附件后手动加题。";
      }
      questions = warn ? [] : parseExam(lines);
      const garbled = uploadMeta.kind === "pdf" && lines.length > 0 && garbageRatio(lines) > 0.12;
      const needOcr = uploadMeta.kind === "pdf" && (garbled || questions.length === 0);
      if (!warn && !questions.length) warn = "自动拆题没找到明显的题号。";
      if (garbled) {
        status.innerHTML = `<div class="rv-note">⚠️ 这份 PDF 的<b>文字层坏了</b>：提取出来的中文全是乱码（部分软件导出 PDF 的通病），所以拆不出题。点下方「🔍 用 OCR 识别」改用图片方式重新识别（每页几秒）；也可以只保存附件、之后手动加题。</div>`;
      } else if (warn) {
        status.innerHTML = `<div class="rv-note">⚠️ ${esc(warn)}${needOcr ? "可以点下方「🔍 用 OCR 识别」试试（扫描件也能认）。" : "可以直接点「保存入库」（附件会保留），或取消后换个格式再传。"}</div>`;
      } else {
        status.innerHTML = `<div class="rv-note">✅ 识别出 ${questions.length} 道题、其中 ${questions.filter(q => q.answer).length} 道带答案。题目文本来自自动识别，数学符号可能有出入 —— 请粗校一遍，原卷以附件为准。</div>`;
      }
      renderReview();
      btnAdd.classList.remove("hidden");
      btnSave.classList.remove("hidden");
      if (needOcr) btnOcr.classList.remove("hidden");
      btnExtract.classList.add("hidden");
    } catch (e) {
      status.innerHTML = `<div class="rv-note" style="background:#fdeceb;border-color:#f3c2bd;color:var(--bad);">❌ ${esc(e.message)}</div>`;
    } finally {
      btnExtract.disabled = false;
      btnExtract.textContent = "① 提取题目";
    }
  };

  btnSave.onclick = async () => {
    const name = m.querySelector("#up-name").value.trim();
    const catId = m.querySelector("#up-cat").value;
    if (!name) return toast("请填写套卷名称", "err");
    btnSave.disabled = true;
    btnSave.innerHTML = `<span class="spinner"></span>保存中…`;
    try {
      const saved = await api("/api/sets", {
        method: "POST",
        body: {
          categoryId: catId, name, uploadId: uploadMeta.uploadId,
          questions: questions.filter(q => q.stemImgData || (q.stem && q.stem.trim())),
        },
      });
      closeModal(m);
      toast(`已入库「${saved.name}」：${saved.questions.length} 道题`, "ok");
      state.curCatId = catId;
      localStorage.setItem("fatiqi_cat", catId);
      state.expandedSetId = saved.id;
      await loadCats();
    } catch (e) {
      toast(e.message, "err");
      btnSave.disabled = false;
      btnSave.textContent = "② 保存入库";
    }
  };
}

/* ---------- PDF 文本提取（pdf.js） ---------- */
async function setupPdfWorker() {  if (typeof pdfjsLib === "undefined") return;
  try {
    if (!IS_FILE) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = API + "/libs/pdf.worker.min.js";
      return;
    }
    const res = await fetch(API + "/libs/pdf.worker.min.js");
    const code = await res.text();
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url);
    } catch (e) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = url; // 退化为假 worker（主线程）
    }
  } catch (e) {
    console.warn("pdf worker 初始化失败，将用主线程模式", e);
  }
}

async function extractPdfLines(file) {
  if (typeof pdfjsLib === "undefined") throw new Error("pdf.js 没加载出来");
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map(); // y -> items
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      let key = null;
      for (const k of rows.keys()) { if (Math.abs(k - y) <= 2.5) { key = k; break; } }
      if (key === null) { key = y; rows.set(key, []); }
      rows.get(key).push(it);
    }
    for (const [y, arr] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
      const text = arr.sort((a, b) => a.transform[4] - b.transform[4])
        .map(i => i.str).join("").replace(/[ \t]+/g, " ").trim();
      if (text) lines.push(text);
    }
  }
  await doc.destroy();
  return lines;
}

/* ---------- Word 文本提取（mammoth，仅 .docx） ---------- */
async function extractDocxLines(file) {
  if (typeof mammoth === "undefined") throw new Error("mammoth.js 没加载出来");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/* ---------- 乱码检测：判断文字层是否损坏 ---------- */
function garbageRatio(lines) {
  let bad = 0, all = 0;
  const okExtra = "，。；：？！（）、．“”‘’—…·×÷±∫∑√π≠≤≥∞≈∈∫∑°′″~→←↑↓";
  for (const ch of lines.join("")) {
    const c = ch.codePointAt(0);
    all++;
    const ok = (c >= 0x20 && c <= 0x7e) ||          // ASCII
               (c >= 0x4e00 && c <= 0x9fff) ||      // 中文
               (c >= 0x3000 && c <= 0x303f) ||      // 中文标点
               (c >= 0xff00 && c <= 0xffef) ||      // 全角字符
               (c >= 0x2000 && c <= 0x206f) ||      // 通用标点
               okExtra.includes(ch);
    if (!ok) bad++;
  }
  return all ? bad / all : 0;
}

/* ---------- OCR 提取（pdf.js 渲染每页成图 → Windows 离线 OCR） ---------- */
async function ocrPdfLines(file, onProgress) {
  if (typeof pdfjsLib === "undefined") throw new Error("pdf.js 没加载出来");
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const lines = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
      const fd = new FormData();
      fd.append("image", blob, "page.png");
      const j = await api("/api/ocr", { method: "POST", body: fd });
      lines.push(...(j.lines || []).map(o => (o.t || "").trim()).filter(Boolean));
    }
  } finally {
    canvas.width = 0;
    await doc.destroy();
  }
  return lines;
}

/* ---------- 按原卷切图：OCR 只负责定位题号，题目本身裁原图 ----------
 * 返回 [{stem, answer, stemImgData, ansImgData}]（dataURL 图片 + OCR 文字备注） */
const RE_CROP_QNUM_S = /^(\d{1,2})\s*[.、．]\s*(?!\d)/;
const RE_CROP_QNUM_P = /^[（(]\s*(\d{1,2})\s*[)）]/;
const RE_CROP_SEC = /^[一二三四五六七八九十]+\s*[、．.，,]/;
const RE_CROP_SCORE = /[（(]\s*本题\s*\d+\s*分/;
const RE_CROP_ANSHEAD = /^(参考答案|试题参考答案|答案与评分标准|参考答案及评分标准|答案及评分标准|答案与解析|参考解答|试题解答|答案解析|解\s*答(?!题)|答案)/;
const RE_CROP_SOLHEAD = /^(解\s*[：:．.]|解法|证\s*[：:．.]|证明|答\s*[：:．.])/;
const RE_CROP_CHROME = /第\s*\d+\s*页|Page\s*\d+|届|竞赛|试卷|密封|准考证/;

function cropClassify(t, zone) {
  // “（本题N分）”两个区都算边界；裸的“一、”和丢字的“、解答题”只在题目区算
  // （答案解析里“一，方程化为”这类行会被误判）
  if (RE_CROP_SCORE.test(t)) return { kind: "section" };
  if (zone === "Q" && (RE_CROP_SEC.test(t) ||
      /^[、，]\s*(填空|选择|解答|判断|计算|证明|应用|简答)?题/.test(t))) {
    return { kind: "section" };
  }
  if (RE_CROP_ANSHEAD.test(t)) return { kind: "anshead" };
  if (RE_CROP_SOLHEAD.test(t)) return { kind: "solhead" };
  const m = RE_CROP_QNUM_S.exec(t) || RE_CROP_QNUM_P.exec(t);
  if (m) return { kind: "qnum", num: +m[1] };
  return null;
}

/* 卷面上的表格小字（得分/评阅人/题号…） */
function cropJunkLine(t) {
  return /^(得分|评阅人|题号|满分|姓名|立|注意)[\s:：.．0-9—一-九]*$/.test(t);
}

/* 大题标题剥掉“二、（本题14分）”和表格小字后，判断剩下的是不是题干正文 */
function cropStripHead(t) {
  let s = t.replace(/^[一二三四五六七八九十、．.，,\s]+/, "");
  s = s.replace(/[（(][^（）()]*?分[^（）()]*?[）)]/g, "");
  s = s.replace(/(得分|评阅人|题号|满分|姓名)/g, "");
  return s.replace(/^[、．.，,:\s]+/, "").trim();
}

function cropSplitColumns(lines, W) {
  const mid = W / 2;
  const left = [], right = [];
  let cross = 0;
  for (const l of lines) {
    if (l.x < mid - 10 && l.x + l.w > mid + 10) { cross++; continue; }
    (l.x + l.w / 2 < mid ? left : right).push(l);
  }
  if (left.length >= 3 && right.length >= 3 &&
      cross <= Math.max(2, lines.length * 0.08)) return [left, right];
  return [lines];
}

function cropChromeBands(chromeLines) {
  const bands = chromeLines.map(l => [l.y, l.y + l.h]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1] + 2) last[1] = Math.max(last[1], b[1]);
    else merged.push([b[0], b[1]]);
  }
  return merged;
}

/* OCR 常把“题号”和“题干”拆成两行且 y 互相交错（题号行略低于内容行）：
 * 裸题号行若与前面的内容行几乎同行，就把它们合并成一个逻辑行。
 * “I.”“l.”这类“1.”的误认也顺并成第 1 题。 */
function cropMergeRowLines(lines) {
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev) {
      const cc = cropClassify(l.t, "Q");
      const mis = /^[Iil]\s*[.、．]$/.test(l.t);
      const pc = cropClassify(prev.t, "Q");
      const bareMark = (cc && cc.kind === "qnum" && l.t.length <= 6) || mis;
      // 盒子（放宽 12px）有明显重叠就算同一行
      const overlap = Math.min(prev.y + prev.h, l.y + l.h) + 12 -
                      Math.max(prev.y, l.y);
      const sameRow = overlap > Math.min(prev.h, l.h) * 0.4;
      if (bareMark && sameRow && !pc && prev.t.length >= 3 && l.x <= prev.x + 4) {
        prev.t = (mis ? "1." : l.t) + prev.t;
        prev.x = Math.min(prev.x, l.x);
        const ny = Math.min(prev.y, l.y);
        const by = Math.max(prev.y + prev.h, l.y + l.h);
        prev.y = ny; prev.h = by - ny;
        prev.w = Math.max(prev.x + prev.w, l.x + l.w) - prev.x;
        continue;
      }
    }
    out.push({ ...l });
  }
  return out;
}

/* 像素级找左侧装订线（密封线竖排文字+折线）：
 * 从左往右走“墨块”，又窄、又几乎贯穿整个内容带的块是装订线家具；
 * 遇到正文块（宽块或覆盖率低的块）就停，返回最后一个家具块的右端。 */
function cropFindGutterX(cctx, W, top, bottom) {
  const h = bottom - top;
  if (h < 60) return 0;
  let img;
  try { img = cctx.getImageData(0, top, W, h); } catch (e) { return 0; }
  const d = img.data;
  const colInk = new Uint8Array(W);
  for (let y = 0; y < h; y += 2) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (d[row + x * 4] < 190) colInk[x] = 1;
    }
  }
  const rows = Math.ceil(h / 2);
  let x = 0, cut = 0;
  while (x < W) {
    while (x < W && !colInk[x]) x++;
    if (x >= W) break;
    const bx0 = x;
    while (x < W && colInk[x]) x++;
    const bx1 = x;
    if (bx1 - bx0 > W * 0.08) { cut = bx0; break; } // 宽块 = 正文
    let covered = 0;
    for (let y = 0; y < h; y += 2) {
      const row = y * W * 4;
      let any = false;
      for (let xx = bx0; xx < bx1 && !any; xx++) {
        if (d[row + xx * 4] < 190) any = true;
      }
      if (any) covered++;
    }
    if (covered / rows < 0.7) { cut = bx0; break; } // 不贯穿全页 = 正文
    cut = bx1; // 窄且贯穿全页 → 装订线，继续
  }
  return cut;
}

/* 把 y 吸附到附近整行空白带（dir=-1 只向上找 = 上边界；dir=+1 只向下找 = 下边界），
 * 保证不切半个字，也不会越过另一端 */
function cropSnapY(inkRows, y, dir, maxScan) {
  maxScan = maxScan || 40;
  if (!inkRows || y < 0 || y >= inkRows.length) return y;
  if (!inkRows[y]) return y; // 已在空白带上
  const step = dir >= 0 ? 1 : -1;
  for (let k = 1; k <= maxScan; k++) {
    const j = y + step * k;
    if (j < 0 || j >= inkRows.length) return y;
    if (!inkRows[j]) {
      let g = j;
      while (g + step >= 0 && g + step < inkRows.length && !inkRows[g + step]) g += step;
      return Math.round((j + g) / 2);
    }
  }
  return y;
}

/* 序号对齐拆段：段内某行是“期望的下一题号”（OCR 误认括号/文字层候选），
 * 说明这里少了一个边界——把这段切成两段。治“两题并进一张图”。 */
function cropFindCut(s, streams, pages) {
  if (s.num === null || !s.members || s.members.length < 2) return null;
  const xLim = s => {
    const st = streams[s];
    return st.x0 + (st.x1 - st.x0) * 0.4;
  };
  // 1) OCR 成员行的模糊题号（括号缺一半、认错等都算）
  for (let i = 1; i < s.members.length; i++) {
    const mb = s.members[i];
    const st = streams[mb.si];
    const mm = /^[\（(]\s*(\d{1,2})\s*[\）〕\]ｌ」]|^[\（(]\s*(\d{1,2})(?!\d)|^(\d{1,2})\s*[）〕\]ｌ」]/.exec(mb.t);
    const num = mm ? +(mm[1] || mm[2] || mm[3]) : NaN;
    if (num === s.num + 1 && mb.x <= xLim(mb.si)) {
      return { si: mb.si, y: cropSnapY(st.inkRows, mb.y - 3, -1), num, memberIdx: i };
    }
  }
  // 2) 文字层候选（OCR 整行漏掉时，数字 item 仍在）：
  //    必须贴着左缘，且那一行 OCR 完全没有盒子（真·漏检行）——
  //    否则公式里的独立数字（如 4T2 的 4）会被误当题号
  for (let i = 0; i <= s.members.length; i++) {
    const refM = s.members[Math.min(i, s.members.length - 1)];
    if (!refM) break;
    const st = streams[refM.si];
    for (const c of (pages[st.p].tlCands || [])) {
      if (c.num !== s.num + 1 || c.x > st.x0 + 90) continue;
      if (s.members.some(mb => c.y >= mb.y - 10 && c.y <= mb.y + mb.h + 10)) continue;
      const prevM = s.members[i - 1];
      const nextM = s.members[i];
      if ((!prevM || c.y > prevM.y + prevM.h + 4) &&
          (!nextM || c.y < nextM.y - 4)) {
        const si2 = streams.findIndex(t2 =>
          t2.p === st.p && c.y >= t2.top - 10 && c.y <= t2.bottom + 10);
        if (si2 < 0) continue;
        return { si: si2, y: c.y - 34, num: c.num, memberIdx: i };
      }
    }
  }
  return null;
}

function cropSplitSegAt(s, cut) {
  const i = cut.memberIdx;
  const mk = () => ({ kind: s.kind, num: s.num, text: "", frags: [], members: [] });
  const s1 = mk(), s2 = mk();
  s2.num = cut.num;
  s.members.forEach((mb, k) => {
    const tgt = k < i ? s1 : s2;
    if (tgt.text) tgt.text += "\n";
    tgt.text += mb.t;
    tgt.members.push(mb);
  });
  for (const f of s.frags) {
    if (f.si < cut.si || (f.si === cut.si && (f.y1 ?? Infinity) <= cut.y)) {
      s1.frags.push({ ...f });
    } else if (f.si > cut.si || (f.si === cut.si && f.y0 >= cut.y)) {
      s2.frags.push({ ...f });
    } else {
      s1.frags.push({ si: f.si, y0: f.y0, y1: cut.y });
      s2.frags.push({ si: f.si, y0: cut.y, y1: f.y1 });
    }
  }
  return [s1, s2];
}

function cropTrySplit(segs, streams, pages) {
  const out = [];
  for (let s of segs) {
    // 只拆题目段：答案段拆错了会丢配对，宁可答案图带一点相邻内容
    let guard = 0;
    while (s.kind === "question" && guard++ < 8) {
      const cut = cropFindCut(s, streams, pages);
      if (!cut) break;
      const [a, b] = cropSplitSegAt(s, cut);
      (window.__splitLog = window.__splitLog || []).push(
        `切 ${s.kind}#${s.num} @${cut.num} y=${Math.round(cut.y)} | 前: ${(a.text || "").slice(0, 20).replace(/\n/g, " ")} | 后: ${(b.text || "").slice(0, 20).replace(/\n/g, " ")}`);
      out.push(a);
      s = b;
    }
    out.push(s);
  }
  return out;
}

async function cropFromPdf(file, onProgress) {
  if (typeof pdfjsLib === "undefined") throw new Error("pdf.js 没加载出来");
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const scale = 2;
  const pages = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale });
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const dataUrl = canvas.toDataURL("image/png");
      const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
      const fd = new FormData();
      fd.append("image", blob, "page.png");
      const j = await api("/api/ocr", { method: "POST", body: fd });
      const lines = (j.lines || [])
        .map(o => ({ t: normalizeOcrLine(o.t || ""), x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0 }))
        .filter(o => o.t);
      let gutterX = 0;
      if (lines.length > 3) {
        const top = Math.min(...lines.map(l => l.y));
        const bottom = Math.max(...lines.map(l => l.y + l.h));
        gutterX = cropFindGutterX(ctx, canvas.width, Math.max(0, top - 10),
          Math.min(canvas.height, bottom + 10));
      }
      // 逐行墨水分布（用于把切图边界吸附到空白带上，避免切半个字）
      let inkRows = null;
      try {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data, Wc = canvas.width, Hc = canvas.height;
        inkRows = new Uint8Array(Hc);
        for (let y = 0; y < Hc; y++) {
          const row = y * Wc * 4;
          for (let x = 0; x < Wc; x += 2) {
            if (d[row + x * 4] < 190) { inkRows[y] = 1; break; }
          }
        }
      } catch (e) { /* 忽略 */ }
      // 文字层题号候选：文字层坏的卷子里数字往往是好的，
      // "独立的 1-2 位数字" item 就是疑似题号（OCR 整行漏检时的第二信源）
      let tlCands = [];
      try {
        const tc = await page.getTextContent();
        for (const it of tc.items) {
          const s2 = (it.str || "").trim();
          if (!/^\d{1,2}$/.test(s2)) continue;
          const mt = pdfjsLib.Util.transform(vp.transform, it.transform);
          if (mt[4] < vp.width * 0.45) tlCands.push({ num: +s2, x: mt[4], y: mt[5] });
        }
      } catch (e) { /* 忽略 */ }
      pages.push({ dataUrl, lines, W: canvas.width, H: canvas.height, gutterX, inkRows, tlCands });
    }
  } finally {
    canvas.width = 0;
    await doc.destroy();
  }

  // 每页 → 一个或两个"流"（单栏 / 左右双栏），剔除页眉页脚
  const streams = [];
  pages.forEach((pg, p) => {
    for (const col of cropSplitColumns(pg.lines, pg.W)) {
      const chrome = [], content = [];
      for (const l of col) {
        ((l.y < pg.H * 0.13 || l.y > pg.H * 0.87) && RE_CROP_CHROME.test(l.t)
          ? chrome : content).push(l);
      }
      if (content.length < 2) continue;
      content.sort((a, b) => a.y - b.y);
      const merged = cropMergeRowLines(content);
      // 左边界：忽略装订线（像素分析）和最左缘的零星杂行
      const xs = merged.map(l => l.x).filter(x => x >= pg.gutterX);
      const xsEff = xs.length ? xs : merged.map(l => l.x);
      const x0raw = Math.min(...xsEff);
      streams.push({
        p, lines: merged, inkRows: pg.inkRows,
        x0: Math.max(pg.gutterX, Math.max(0, x0raw - 6)),
        x1: Math.min(pg.W, Math.max(...merged.map(l => l.x + l.w)) + 16),
        top: Math.min(...merged.map(l => l.y)),
        bottom: Math.max(...merged.map(l => l.y + l.h)),
        bands: cropChromeBands(chrome),
      });
    }
  });

  // 按流顺序走一遍，切出题目/答案段
  const segs = [];
  let cur = null, zone = "Q", openFrag = null;
  const closeSeg = () => {
    if (!cur) return;
    if (openFrag) { // 全卷结束：下边界向下吸附到页尾空白
      openFrag.y1 = cropSnapY(streams[openFrag.si].inkRows,
        streams[openFrag.si].bottom, +1);
      openFrag = null;
    }
    segs.push(cur);
    cur = null;
  };
  for (let si = 0; si < streams.length; si++) {
    const st = streams[si];
    for (const l of st.lines) {
      if (cur && openFrag && openFrag.si !== si) {
        // 跨页/跨栏：上一片下边界向下吸附到页尾空白
        openFrag.y1 = cropSnapY(streams[openFrag.si].inkRows,
          streams[openFrag.si].bottom, +1);
        openFrag = null;
      }
      const t = l.t;
      let cls = cropClassify(t, zone);
      // 裸题号（“8．”后面还没内容）紧跟的“证明：…”是题干，不是解答开头
      if (cls && cls.kind === "solhead" && cur && cur.kind === "question" &&
          cur.text.replace(/\s/g, "").length <= 8) cls = null;
      if (cls) {
        if (cur && openFrag) {
          // 上边界吸附：本段下边界向上找到下一题号上方的空白带
          openFrag.y1 = openFrag.si === si
            ? cropSnapY(st.inkRows, Math.max(openFrag.y0, l.y - 3), -1)
            : cropSnapY(streams[openFrag.si].inkRows, streams[openFrag.si].bottom, +1);
          openFrag = null;
        }
        if (cls.kind === "section") {
          closeSeg();
          zone = "Q";
          const head = cropStripHead(t);
          if (head.length >= 5) {
            // “二、（本题14分）求微分方程…”：小节本身就是一道大题
            cur = { kind: "question", num: null, text: head, frags: [],
                    members: [{ t, x: l.x, y: l.y, h: l.h, si }] };
          }
          // 否则是纯容器标题（如“一、填空题（每小题5分）”），只切区不开题
          if (!cur) continue;
        } else if (cls.kind === "anshead") {
          closeSeg();
          zone = "A";
          cur = null;
          continue; // 分界行自己不成段，后面的编号行成段
        } else if (cls.kind === "solhead") {
          if (!(cur && cur.kind === "answer")) {
            closeSeg();
            zone = "A";
            cur = { kind: "answer", num: null, text: t, frags: [],
                    members: [{ t, x: l.x, y: l.y, h: l.h, si }] };
          }
        } else { // qnum
          closeSeg();
          cur = { kind: zone === "A" ? "answer" : "question", num: cls.num, text: t, frags: [],
                  members: [{ t, x: l.x, y: l.y, h: l.h, si }] };
        }
        cur.frags.push({ si, y0: cropSnapY(st.inkRows, Math.max(st.top, l.y - 3), -1), y1: null });
        openFrag = cur.frags[cur.frags.length - 1];
      } else if (cur) {
        if (!openFrag) { // 跨页续段：从本页内容顶部开始
          openFrag = { si, y0: st.top, y1: null };
          cur.frags.push(openFrag);
        }
        if (openFrag.si === si) openFrag.y1 = l.y + l.h;
        if (!cropJunkLine(t)) {
          cur.text += "\n" + t; // 表格小字不进文字备注，但图里保留
          cur.members.push({ t, x: l.x, y: l.y, h: l.h, si });
        }
      }
    }
  }
  closeSeg();

  // 层一·序号对齐拆段：段内出现“期望的下一题号”（OCR 噪声/文字层候选）就切开，
  // 治“两题并进一张图”
  const fixedSegs = cropTrySplit(segs, streams, pages);

  // 组卷：过滤注意事项，答案按编号配对（无编号大题按顺序取后续解析段）
  const qSegs = fixedSegs.filter(s => s.kind === "question" && !RE_PREAMBLE_Q.test(s.text));
  const aSegs = fixedSegs.filter(s => s.kind === "answer");
  const used = new Set();
  for (const q of qSegs) {
    q.ansSeg = aSegs.find(a => !used.has(a) &&
      (q.num !== null ? a.num === q.num : a.num === null)) || null;
    if (q.ansSeg) used.add(q.ansSeg);
  }

  // 裁图（跨页段拆成多片再竖向拼成一张）
  const pageImgs = [];
  const getPageImg = async p => {
    if (!pageImgs[p]) {
      const img = new Image();
      img.src = pages[p].dataUrl;
      await img.decode();
      pageImgs[p] = img;
    }
    return pageImgs[p];
  };
  const cropCanvas = async (si, y0, y1) => {
    const st = streams[si];
    const img = await getPageImg(st.p);
    const w = st.x1 - st.x0, h = y1 - y0;
    if (w < 10 || h < 6) return null;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, st.x0, y0, w, h, 0, 0, w, h);
    return c;
  };
  const segToImage = async s => {
    const crops = [];
    for (const f of s.frags) {
      const st = streams[f.si];
      const a0 = Math.max(0, f.y0);
      const a1 = Math.min(f.y1 ?? st.bottom, st.bottom + 4);
      if (a1 - a0 < 4) continue;
      let pieces = [[a0, a1]];
      for (const b of st.bands) { // 剔除夹在中间的页眉页脚带
        const next = [];
        for (const [p0, p1] of pieces) {
          if (b[1] <= p0 || b[0] >= p1) { next.push([p0, p1]); continue; }
          if (b[0] > p0) next.push([p0, b[0]]);
          if (b[1] < p1) next.push([b[1], p1]);
        }
        pieces = next;
      }
      for (const [p0, p1] of pieces) {
        const c = await cropCanvas(f.si, p0, p1);
        if (c) crops.push(c);
      }
    }
    if (!crops.length) return null;
    if (crops.length === 1) return crops[0].toDataURL("image/png");
    const gap = 8;
    const H = crops.reduce((s2, c) => s2 + c.height, 0) + gap * (crops.length - 1);
    const W = Math.max(...crops.map(c => c.width));
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const octx = out.getContext("2d");
    let yy = 0;
    for (const c of crops) { octx.drawImage(c, 0, yy); yy += c.height + gap; }
    return out.toDataURL("image/png");
  };

  const out = [];
  for (const q of qSegs) {
    const stemImgData = await segToImage(q);
    if (!stemImgData) continue;
    const ansImgData = q.ansSeg ? await segToImage(q.ansSeg) : null;
    const stemPage = q.frags.length ? streams[q.frags[0].si].p + 1 : null;
    const ansPage = q.ansSeg && q.ansSeg.frags.length
      ? streams[q.ansSeg.frags[0].si].p + 1 : null;
    out.push({
      stem: q.text.trim(),
      answer: q.ansSeg ? q.ansSeg.text.trim() : "",
      stemImgData, ansImgData, source: "crop",
      stemPage, ansPage,
    });
  }
  return out;
}

/* ---------- 拆题 + 提取答案 ---------- */
const RE_QSTART = /^(\d{1,2})\s*[.、．]\s*(?!\d)/;
const RE_PAREN = /^[（(]\s*(\d{1,2})\s*[)）]\s*(?!\d)/;   // （1） (1)
const RE_RPAREN = /^(\d{1,2})\s*[)）]\s*(?!\d)/;          // 1)
const RE_SECTION = /^[一二三四五六七八九十]+\s*[、．.，,]/;
const RE_SCORE_MARK = /[（(]\s*本题\s*\d+\s*分/;
const RE_ANSHEAD = /^(参考答案|试题参考答案|答案与评分标准|参考答案及评分标准|答案及评分标准|答案与解析|参考解答|试题解答|答案解析|解\s*答(?!题)|答案)/;
const RE_PAGENO = /^[—–\-_=～·\s]*\d{1,3}[—–\-_=～·\s]*$/;
const RE_JUNKLINE = /^(得\s*分|评\s*阅\s*人|题\s*号|满\s*分|姓\s*名|准\s*考\s*证\s*号|注\s*意|装\s*订\s*线)\s*[：:．.]?$/;
const RE_PREAMBLE_Q = /密封线|答题区域内|答题空白|答题卡|姓名及|准考证/;
const RE_PAGEMARK = /第\s*\d+\s*页|\bPage\s*\d+\b/i;

/* OCR 会在汉字间插空格（“考 试 形 式”），压回去 */
function normalizeOcrLine(l) {
  return l
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, "")
    .replace(/[ \t]+([，。；：？！、（）【】《》“”‘’·])\s*/g, "$1")
    .trim();
}

function cleanLines(lines) {
  const count = new Map();
  for (const l of lines) {
    if (l.length <= 40) count.set(l, (count.get(l) || 0) + 1);
  }
  // 页眉页脚特征：含“届/竞赛/试卷/满分/考试时间…”或“第 N 页/Page N”
  const headerish = /届|竞赛|试卷|试题|满分|考试时间|姓名|准考证|密封/;
  return lines.filter(l => {
    if (RE_PAGENO.test(l)) return false;
    if (RE_JUNKLINE.test(l)) return false;
    if (RE_PAGEMARK.test(l) && l.length <= 40) return false;
    const c = count.get(l) || 0;
    if (c >= 2 && l.length <= 40 && headerish.test(l)) return false;
    if (c >= 4 && l.length <= 20) return false;
    return true;
  });
}

function qNumOf(line) {
  for (const re of [RE_QSTART, RE_PAREN, RE_RPAREN]) {
    const m = re.exec(line);
    if (m) {
      const rest = line.slice(m[0].length).trim();
      if (rest.length < 2) return null; // 防止 "1.5x" 之类误判
      return { num: +m[1], rest };
    }
  }
  return null;
}

/* 大题/小节边界：“一、…”“（本题14分）…”（含 OCR 丢序号后的“、（本题…”） */
function isSectionBoundary(line) {
  return RE_SECTION.test(line) || RE_SCORE_MARK.test(line);
}
function stripSectionMark(line) {
  let s = line.replace(/^[一二三四五六七八九十、．.，,\s]+/, "");
  s = s.replace(/[（(][^（）()]*分[）)]/g, "");
  return s.replace(/^[、．.，,]/, "").trim();
}

function splitQuestions(lines) {
  const out = [];
  let lastNum = null, chainLen = 0, sectionIdx = 0;
  for (const line of lines) {
    if (isSectionBoundary(line)) {
      sectionIdx++;
      // 边界不重置编号链：既允许“6.”接着上一节的 5 继续，也允许新节从（1）重来
      if (RE_SCORE_MARK.test(line)) {
        const content = stripSectionMark(line);
        if (content.length >= 4) out.push({ num: null, sectionIdx, stem: content });
      }
      continue;
    }
    const qn = qNumOf(line);
    if (qn) {
      const okStart =
        lastNum === null ? qn.num <= 2 :
        qn.num === lastNum + 1 ||
        (qn.num <= 2 && chainLen >= 2) ||
        (qn.num > lastNum + 1 && qn.num <= lastNum + 4);
      if (okStart) {
        const isRestart = qn.num <= 2 && lastNum !== null && qn.num !== lastNum + 1;
        out.push({ num: qn.num, sectionIdx, stem: qn.rest });
        lastNum = qn.num;
        chainLen = isRestart ? 1 : chainLen + 1;
        continue;
      }
    }
    if (out.length) out[out.length - 1].stem += "\n" + line;
  }
  return out;
}

function parseExam(rawLines) {
  const lines = cleanLines(rawLines.map(normalizeOcrLine));
  // 找答案区起点
  let ansIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const bare = lines[i].replace(/\s/g, "");
    if (bare.length <= 26 && RE_ANSHEAD.test(bare)) { ansIdx = i; break; }
  }
  let qLines, aLines;
  if (ansIdx > 0) {
    qLines = lines.slice(0, ansIdx);
    // “解答：(1)…”这种行：标题词后面可能直接跟着第 (1) 题的答案
    const head = lines[ansIdx].replace(RE_ANSHEAD, "")
      .replace(/^[，,：:、\s]+/, "").trim();
    aLines = (head ? [head] : []).concat(lines.slice(ansIdx + 1));
  } else { qLines = lines; aLines = []; }
  const qs = splitQuestions(qLines);
  const seen = new Set(qs.map(q => q.stem.replace(/\s/g, "").slice(0, 12)));
  // 答案按（区段,题号）归集；区段按边界行或题号重新从小到大来切分。
  // 穿插排版的卷子（题目和解析混排）里，“（本题14分）求…”这样的大题会出现在
  // 答案区里，也把它们捞成题目（按题干前缀去重）。
  const answers = {};
  const numSections = {};
  const extraQs = [];
  let cur = null, lastNum = null, sectionIdx = 0;
  for (const line of aLines) {
    if (isSectionBoundary(line)) {
      sectionIdx++;
      if (RE_SCORE_MARK.test(line)) {
        const content = stripSectionMark(line);
        const key = content.replace(/\s/g, "").slice(0, 12);
        if (content.length >= 4 && !seen.has(key)) {
          seen.add(key);
          extraQs.push({ num: null, sectionIdx: 0, stem: content, ansKey: "X" + extraQs.length });
          cur = "X" + (extraQs.length - 1); // 大题标题后面紧跟的解析文本就是它的答案
        } else {
          cur = null;
        }
      } else {
        cur = null; // 题号链不重置：解答题答案常从上一节末尾的题号继续
      }
      continue;
    }
    const qn = qNumOf(line);
    if (qn) {
      const okStart =
        lastNum === null ? qn.num <= 2 :
        qn.num === lastNum + 1 || (qn.num === 1 && lastNum >= 3) ||
        (qn.num > lastNum + 1 && qn.num <= lastNum + 4);
      if (okStart) {
        cur = sectionIdx + ":" + qn.num;
        answers[cur] = (answers[cur] ? answers[cur] + "\n" : "") + qn.rest;
        (numSections[qn.num] = numSections[qn.num] || new Set()).add(sectionIdx);
        lastNum = qn.num;
        continue;
      }
    }
    if (cur) answers[cur] = (answers[cur] || "") + "\n" + line;
  }
  const all = qs.concat(extraQs).filter(q => !RE_PREAMBLE_Q.test(q.stem));
  if (!all.length) return [];
  const usedFallback = {};
  return all.map(q => {
    let answer = "";
    if (q.ansKey) answer = (answers[q.ansKey] || "").trim();
    else if (q.num !== null) {
      answer = (answers[q.sectionIdx + ":" + q.num] || "").trim();
      if (!answer) {
        // 区段错位时的兜底：该题号在答案区可能出现在多个区段，
        // 按出现顺序逐个消耗（第 1 个同号题配第 1 次出现，以此类推）
        const secs = [...(numSections[q.num] || [])].sort((a, b) => a - b);
        const k = usedFallback[q.num] || 0;
        if (k < secs.length) {
          answer = (answers[secs[k] + ":" + q.num] || "").trim();
          usedFallback[q.num] = k + 1;
        }
      }
    }
    return { stem: q.stem.trim(), answer, source: "extracted" };
  });
}

/* ================= 刷题设置 ================= */
function switchTab(tab, after) {
  $$(".tab").forEach(b => b.classList.remove("active"));
  $$(".view").forEach(v => v.classList.remove("active"));
  if (tab === "bank") {
    $("#tab-bank").classList.add("active");
    $("#view-bank").classList.add("active");
  } else {
    $("#tab-practice").classList.add("active");
    $("#view-practice").classList.add("active");
  }
  (after ? after() : Promise.resolve()).catch(e => toast(e.message, "err"));
}

$("#tab-bank").addEventListener("click", () => switchTab("bank"));
$("#tab-practice").addEventListener("click", () => switchTab("practice", refreshPractice));

async function refreshPractice() {
  // 类别下拉
  if (!state.cats.length) { try { await loadCats(); } catch (e) {} }
  const sel = $("#p-cat");
  sel.innerHTML = state.cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  if (!state.cats.some(c => c.id === state.practiceCatId)) {
    state.practiceCatId = state.curCatId || (state.cats[0] && state.cats[0].id) || null;
  }
  if (state.practiceCatId) sel.value = state.practiceCatId;
  await loadPracticeSets();
}

async function loadPracticeSets() {
  const box = $("#p-sets");
  const catId = state.practiceCatId;
  let sets = [];
  if (catId) {
    try { sets = await api("/api/sets?categoryId=" + catId); } catch (e) { toast(e.message, "err"); }
  }
  box.innerHTML = sets.length ? "" : `<div class="empty-hint">该类别下还没有套卷，先去「题库」上传。</div>`;
  for (const s of sets) {
    const row = document.createElement("label");
    row.className = "p-set";
    row.innerHTML = `
      <input type="checkbox" data-set-id="${s.id}" data-count="${s.questionCount}">
      <span>${esc(s.name)}</span>
      ${s.attachment ? `<a class="mini" href="${API}/files/${encodeURIComponent(s.attachment.stored)}" target="_blank" onclick="event.stopPropagation()">📎 附件</a>` : ""}
      <span class="cnt">${s.questionCount} 题</span>`;
    row.querySelector("input").addEventListener("change", updatePoolInfo);
    box.appendChild(row);
  }
  updatePoolInfo();
}

$("#p-cat").addEventListener("change", e => {
  state.practiceCatId = e.target.value;
  loadPracticeSets();
});
$("#p-all").addEventListener("click", () => { $$('#p-sets input').forEach(cb => cb.checked = true); updatePoolInfo(); });
$("#p-none").addEventListener("click", () => { $$('#p-sets input').forEach(cb => cb.checked = false); updatePoolInfo(); });

function checkedSets() {
  return $$('#p-sets input').filter(cb => cb.checked)
    .map(cb => ({ id: cb.dataset.setId, count: +cb.dataset.count, name: cb.closest(".p-set").querySelector("span").textContent }));
}
function poolSize() { return checkedSets().reduce((s, x) => s + x.count, 0); }
function updatePoolInfo() {
  const n = poolSize();
  $("#p-pool-info").textContent = n ? `已选套卷共 ${n} 题` : "";
}

$$("#view-practice [data-count]").forEach(chip => {
  chip.addEventListener("click", () => {
    $$("#view-practice [data-count]").forEach(c => c.classList.remove("on"));
    chip.classList.add("on");
    if (chip.dataset.count === "all") {
      const n = poolSize();
      if (!n) return toast("先勾选套卷", "err");
      $("#p-count").value = n;
    } else $("#p-count").value = chip.dataset.count;
  });
});
$$("#view-practice [data-time]").forEach(chip => {
  chip.addEventListener("click", () => {
    $$("#view-practice [data-time]").forEach(c => c.classList.remove("on"));
    chip.classList.add("on");
    $("#p-time").value = chip.dataset.time;
  });
});

$("#btn-start").addEventListener("click", async () => {
  const sets = checkedSets();
  if (!sets.length) return toast("请至少勾选一套题", "err");
  if (!sets.every(s => s.count > 0)) toast("所选套卷里有 0 题的（没有题目），会被跳过", "err");
  // 取题目详情
  const pool = [];
  try {
    for (const s of sets) {
      const full = await api("/api/sets/" + s.id);
      for (const q of full.questions || []) pool.push({ q, setName: full.name, setId: full.id });
    }
  } catch (e) { return toast(e.message, "err"); }
  if (!pool.length) return toast("所选套卷还没有题目，先去题库上传/添加", "err");
  let count = Math.max(1, Math.floor(+$("#p-count").value || 3));
  let notice = "";
  if (count > pool.length) { count = pool.length; notice = `题库只有 ${pool.length} 题，本次全部刷完。`; }
  const minutes = Math.max(0, Math.floor(+$("#p-time").value || 0));
  const items = shuffle(pool).slice(0, count);
  state.lastPractice = { setIds: sets.map(s => s.id), count, minutes };
  if (notice) toast(notice);
  startSession(items, minutes);
});

/* ================= 刷题会话 ================= */
const S = {
  items: [], idx: 0, verdicts: [],
  totalMs: 0, startedAt: 0, pausedTotal: 0, pauseStart: 0,
  timerId: null, active: false,
};

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60), sec = s % 60;
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function startSession(items, minutes) {
  S.items = items; S.idx = 0;
  S.verdicts = items.map(() => null);
  S.totalMs = minutes * 60000;
  S.startedAt = Date.now();
  S.pausedTotal = 0; S.pauseStart = 0;
  S.active = true;
  $("#result").classList.add("hidden");
  $("#session").classList.remove("hidden");
  $("#s-pause").textContent = "⏸ 暂停";
  $("#s-pause").disabled = S.totalMs === 0;
  renderDots();
  renderQuestion();
  clearInterval(S.timerId);
  if (S.totalMs > 0) {
    S.timerId = setInterval(tick, 250);
    tick();
  } else {
    $("#s-timer").textContent = "不限时";
    $("#s-timer").classList.remove("urgent");
  }
}

function remainingMs() {
  if (!S.totalMs) return 0;
  const paused = S.pausedTotal + (S.pauseStart ? Date.now() - S.pauseStart : 0);
  return S.totalMs - (Date.now() - S.startedAt - paused);
}

function tick() {
  const t = $("#s-timer");
  const rem = remainingMs();
  if (S.pauseStart) { t.textContent = fmtClock(rem) + " ⏸"; return; }
  t.textContent = fmtClock(rem);
  t.classList.toggle("urgent", rem <= 60000);
  if (rem <= 0) {
    clearInterval(S.timerId);
    toast("⏰ 时间到，自动交卷！", "err");
    finishSession();
  }
}

function renderDots() {
  const box = $("#s-progress");
  box.innerHTML = "";
  S.items.forEach((it, i) => {
    const d = document.createElement("button");
    d.className = "dot-q" + (i === S.idx ? " cur" : "") +
      (S.verdicts[i] === "right" ? " right" : S.verdicts[i] === "wrong" ? " wrong" : "");
    d.textContent = i + 1;
    d.onclick = () => { S.idx = i; renderQuestion(); };
    box.appendChild(d);
  });
}

function renderQuestion() {
  const it = S.items[S.idx];
  $("#s-setname").textContent = it.setName;
  $("#s-idx").textContent = `第 ${S.idx + 1} / ${S.items.length} 题`;
  const stemEl = $("#s-stem");
  if (it.q.stemImg) {
    stemEl.innerHTML = `<img class="s-img" src="${qImgUrl(it.setId, it.q.stemImg)}" alt="题干切图">`
      + (it.q.stem ? `<div class="s-img-note">${esc(it.q.stem)}</div>` : "");
    $(".s-img", stemEl).onclick = e => zoomImage(e.target.src);
  } else {
    stemEl.textContent = it.q.stem;
  }
  const ansBox = $("#s-answer");
  ansBox.classList.add("hidden");
  ansBox.innerHTML = "";
  $("#s-show").classList.remove("hidden");
  $("#s-show").textContent = "👁 显示答案";
  const judge = $("#s-judge");
  judge.classList.add("hidden");
  $("#s-judged").textContent = "";
  const prev = $("#s-prev"), next = $("#s-next");
  prev.disabled = S.idx === 0;
  next.textContent = S.idx === S.items.length - 1 ? "交卷 ✔" : "下一题 →";
  renderDots();
  $(".s-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#s-show").addEventListener("click", () => {
  const it = S.items[S.idx];
  const ansBox = $("#s-answer");
  if (ansBox.classList.contains("hidden")) {
    let html = "";
    if (it.q.ansImg) html += `<img class="s-img" src="${qImgUrl(it.setId, it.q.ansImg)}" alt="答案切图">`;
    html += it.q.answer
      ? `<span class="tag">答案</span>` + esc(it.q.answer)
      : (it.q.ansImg ? "" : `<span class="tag" style="color:#d9a119;">该题暂未录入答案，可在题库中补充</span>`);
    ansBox.innerHTML = html;
    $(".s-img", ansBox) && ($(".s-img", ansBox).onclick = e => zoomImage(e.target.src));
    ansBox.classList.remove("hidden");
    $("#s-show").textContent = "🙈 隐藏答案";
    $("#s-judge").classList.remove("hidden");
    renderJudged();
  } else {
    ansBox.classList.add("hidden");
    $("#s-show").textContent = "👁 显示答案";
  }
});

function renderJudged() {
  const v = S.verdicts[S.idx];
  $("#s-judged").textContent = v === "right" ? "已判：答对 ✓" : v === "wrong" ? "已判：答错 ✗" : "";
}
$("#s-right").addEventListener("click", () => { S.verdicts[S.idx] = "right"; renderJudged(); renderDots(); });
$("#s-wrong").addEventListener("click", () => { S.verdicts[S.idx] = "wrong"; renderJudged(); renderDots(); });

$("#s-prev").addEventListener("click", () => { if (S.idx > 0) { S.idx--; renderQuestion(); } });
$("#s-next").addEventListener("click", () => {
  if (S.idx < S.items.length - 1) { S.idx++; renderQuestion(); }
  else finishSession();
});

$("#s-pause").addEventListener("click", () => {
  if (!S.totalMs) return;
  if (S.pauseStart) {
    S.pausedTotal += Date.now() - S.pauseStart;
    S.pauseStart = 0;
    $("#s-pause").textContent = "⏸ 暂停";
  } else {
    S.pauseStart = Date.now();
    $("#s-pause").textContent = "▶ 继续";
  }
  tick();
});

$("#s-quit").addEventListener("click", () => {
  confirmModal("放弃本次刷题？进度不会保存。", () => {
    S.active = false;
    clearInterval(S.timerId);
    $("#session").classList.add("hidden");
  }, "放弃");
});

function finishSession() {
  clearInterval(S.timerId);
  S.active = false;
  const usedMs = S.totalMs
    ? Math.min(S.totalMs, Date.now() - S.startedAt - S.pausedTotal)
    : Date.now() - S.startedAt - S.pausedTotal;
  const right = S.verdicts.filter(v => v === "right").length;
  const wrong = S.verdicts.filter(v => v === "wrong").length;
  const skip = S.verdicts.length - right - wrong;
  $("#r-title").textContent = skip === 0 && wrong === 0 ? "全对！撤销一部分罚题 😎" : "交卷！";
  $("#r-used").textContent = fmtClock(usedMs);
  $("#r-right").textContent = right;
  $("#r-wrong").textContent = wrong;
  $("#r-skip").textContent = skip;
  const list = $("#r-list");
  list.innerHTML = "";
  S.items.forEach((it, i) => {
    const v = S.verdicts[i];
    const det = document.createElement("details");
    det.className = "result-row";
    const mark = v === "right" ? `<span class="mark" style="color:var(--ok);">✓</span>`
      : v === "wrong" ? `<span class="mark" style="color:var(--bad);">✗</span>`
      : `<span class="mark" style="color:var(--ink-2);">－</span>`;
    const stemPrev = it.q.stemImg
      ? `<img class="q-thumb" src="${qImgUrl(it.setId, it.q.stemImg)}" alt="题干缩略图"> ` + esc((it.q.stem || "").slice(0, 40))
      : esc(it.q.stem);
    const body = (it.q.stemImg ? `<img class="s-img" src="${qImgUrl(it.setId, it.q.stemImg)}" alt="题干切图"><br>` : esc(it.q.stem))
      + `<br>——<br>`
      + (it.q.ansImg ? `<img class="s-img" src="${qImgUrl(it.setId, it.q.ansImg)}" alt="答案切图">` : "")
      + `<span class="a">答：${esc(it.q.answer || (it.q.ansImg ? "（见答案切图）" : "（未录入答案）"))}</span>`;
    det.innerHTML = `
      <summary>${mark}<span class="stem-prev">${i + 1}. ${stemPrev}</span><span class="badge">${esc(it.setName)}</span></summary>
      <div class="result-body">${body}</div>`;
    $$(".s-img, .q-thumb", det).forEach(img => img.onclick = e => { e.stopPropagation(); zoomImage(img.src); });
    list.appendChild(det);
  });
  $("#r-redo-wrong").disabled = wrong === 0;
  $("#session").classList.add("hidden");
  $("#result").classList.remove("hidden");
}

$("#r-back").addEventListener("click", () => {
  $("#result").classList.add("hidden");
  switchTab("practice", refreshPractice);
});
$("#r-again").addEventListener("click", () => {
  const lp = state.lastPractice;
  if (!lp) return;
  (async () => {
    const pool = [];
    for (const id of lp.setIds) {
      const full = await api("/api/sets/" + id);
      for (const q of full.questions || []) pool.push({ q, setName: full.name, setId: full.id });
    }
    const items = shuffle(pool).slice(0, Math.min(lp.count, pool.length));
    startSession(items, lp.minutes);
  })().catch(e => toast(e.message, "err"));
});
$("#r-redo-wrong").addEventListener("click", () => {
  const wrongItems = S.items.filter((it, i) => S.verdicts[i] === "wrong");
  if (!wrongItems.length) return;
  startSession(shuffle(wrongItems), state.lastPractice ? state.lastPractice.minutes : 0);
});

/* ================= 启动 ================= */
(async function init() {
  try {
    const ok = await connect();
    if (ok) await setupPdfWorker();
    await loadCats();
    await refreshPractice();
  } catch (e) {
    toast(e.message, "err");
  }
})();
