"use strict";
/* ================================================================
   NIM Studio — NVIDIA API playground
   Chat with any model on your key, attach files, generate images.
   ================================================================ */

/* ---------------- constants & state ---------------- */
const DIRECT_BASE = "https://integrate.api.nvidia.com/v1";
const PROXY_BASE  = "/proxy/v1"; // served by server.py

const LS = {
  key:  "nvs.key",
  mode: "nvs.mode",
  chat: "nvs.chatModel",
  img:  "nvs.imgModel",
  temp: "nvs.temp",
  tok:  "nvs.maxTokens",
  sys:  "nvs.system",
};

const state = {
  apiKey: "",
  mode: "auto",          // auto | direct | proxy
  base: DIRECT_BASE,
  models: [],            // [{id, cat}]
  chatModel: "",
  imgModel: "",
  history: [],           // [{role, content(string|parts[])}]
  pending: [],           // [{name, kind, part}]
  generating: false,
  reader: null,
  stopRequested: false,
  modelFilter: "all",
  modelQuery: "",
};

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const PREFERRED_CHAT = [
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-8b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "mistralai/mistral-7b-instruct-v0.3",
];
const PREFERRED_IMAGE = [
  "black-forest-labs/flux.1-dev",
  "black-forest-labs/flux.1-schnell",
  "stabilityai/stable-diffusion-xl",
  "stabilityai/sdxl-turbo",
];

/* ---------------- tiny utils ---------------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

let toastTimer;
function toast(msg, kind = "info") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 4500);
}

function openModal(id)  { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }

function categorize(id) {
  const s = id.toLowerCase();
  if (/embed/.test(s)) return "embeddings";
  if (/rerank|ranker|ranking/.test(s)) return "ranking";
  if (/whisper|parakeet|canary|tts|speech|audio|asr/.test(s)) return "audio";
  if (/cosmos|video|hunyuan|mochi|ltx|wan/.test(s)) return "video";
  if (/flux|stable[-_ ]?diffusion|sdxl|sana|pixart|imagen|dall|t2i|text-to-image/.test(s)) return "image";
  return "chat";
}

function visionLikely(id) {
  return /vision|llava|nemotron|qwen2?-vl|pixtral|molmo|phi-3-vision|fuyu|internvl|cogvlm|eagle|clip/.test(id.toLowerCase());
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(p => p.type === "text").map(p => p.text).join("\n");
  return "";
}
function contentImages(content) {
  return Array.isArray(content)
    ? content.filter(p => p.type === "image_url" && p.image_url).map(p => p.image_url.url)
    : [];
}

/* ---------------- markdown (minimal, safe) ---------------- */
function mdToHtml(src) {
  const parts = String(src).split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const chunk = parts[i];
      let lang = "", code = chunk;
      const nl = chunk.indexOf("\n");
      if (nl >= 0 && /^[\w+#.\-]{0,24}$/.test(chunk.slice(0, nl).trim())) {
        lang = chunk.slice(0, nl).trim();
        code = chunk.slice(nl + 1);
      }
      html += `<div class="codeblock"><div class="codebar"><span>${esc(lang) || "code"}</span>` +
              `<button class="copy-btn" type="button">Copy</button></div>` +
              `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`;
    } else {
      html += blockMd(parts[i]);
    }
  }
  return html;
}

function blockMd(chunk) {
  const lines = chunk.split("\n");
  let out = "", list = null;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); const n = h[1].length + 2; out += `<h${n}>${inlineMd(h[2])}</h${n}>`; continue; }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) { closeList(); out += "<hr>"; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)/);
    if (ul) { if (list !== "ul") { closeList(); out += "<ul>"; list = "ul"; } out += `<li>${inlineMd(ul[1])}</li>`; continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ol) { if (list !== "ol") { closeList(); out += "<ol>"; list = "ol"; } out += `<li>${inlineMd(ol[1])}</li>`; continue; }
    const bq = line.match(/^\s*>\s?(.*)/);
    if (bq) { closeList(); out += `<blockquote>${inlineMd(bq[1])}</blockquote>`; continue; }
    if (line.trim() === "") { closeList(); continue; }
    closeList();
    out += `<p>${inlineMd(line)}</p>`;
  }
  closeList();
  return out;
}

function inlineMd(s) {
  let x = esc(s);
  const stash = [];
  const put = html => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  x = x.replace(/`([^`]+)`/g, (m, c) => put(`<code>${c}</code>`));
  x = x.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, t, u) => put(`<a href="${u}" target="_blank" rel="noopener">${t}</a>`));
  x = x.replace(/https?:\/\/[^\s<)]+/g, u => put(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`));
  x = x.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  x = x.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  x = x.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
  return x;
}

/* ---------------- API plumbing ---------------- */
async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (state.apiKey) headers["Authorization"] = "Bearer " + state.apiKey;
  return fetch(state.base + path, Object.assign({}, opts, { headers }));
}

async function safeErr(res) {
  try {
    const j = await res.json();
    if (j && j.error) return typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error));
    return `HTTP ${res.status}`;
  } catch (_) {
    return `HTTP ${res.status} ${res.statusText || ""}`.trim();
  }
}

function setConn(mode) {
  const badge = $("#connBadge");
  badge.classList.remove("off", "direct", "proxy");
  if (!mode) { badge.classList.add("off"); $("#connLabel").textContent = "offline"; return; }
  badge.classList.add(mode);
  $("#connLabel").textContent = mode === "direct" ? "direct" : "via proxy";
}

async function detectBase() {
  if (state.mode === "direct") { state.base = DIRECT_BASE; setConn("direct"); return; }
  if (state.mode === "proxy")  { state.base = PROXY_BASE;  setConn("proxy");  return; }
  // auto: try direct first
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 7000);
    await fetch(DIRECT_BASE + "/models", {
      headers: { Authorization: "Bearer " + state.apiKey }, signal: c.signal,
    });
    clearTimeout(t);
    state.base = DIRECT_BASE; setConn("direct");
  } catch (_) {
    try {
      const p = await fetch("/healthz", { cache: "no-store" });
      if (p.ok) {
        state.base = PROXY_BASE; setConn("proxy");
        toast("Browser blocked NVIDIA (CORS) — using local proxy.", "warn");
        return;
      }
    } catch (_2) { /* no proxy either */ }
    state.base = DIRECT_BASE; setConn("direct");
    toast("Could not reach NVIDIA. If requests fail, run server.py and retry.", "warn");
  }
}

/* ---------------- connect & models ---------------- */
async function connect(key) {
  state.apiKey = key.trim();
  localStorage.setItem(LS.key, state.apiKey);
  $("#setupStatus").className = "setup-status";
  $("#setupStatus").textContent = "Checking connection…";
  await detectBase();
  const ok = await loadModels();
  if (ok) {
    $("#setupStatus").className = "setup-status ok";
    $("#setupStatus").textContent = `Connected — ${state.models.length} models found.`;
    setTimeout(() => closeModal("setupModal"), 700);
  }
}

async function loadModels() {
  try {
    const res = await api("/models");
    if (res.status === 401 || res.status === 403) {
      $("#setupStatus").className = "setup-status error";
      $("#setupStatus").textContent = "Invalid API key (401). Check the key and try again.";
      toast("Invalid API key.", "error");
      openModal("setupModal");
      return false;
    }
    if (!res.ok) throw new Error(await safeErr(res));
    const json = await res.json();
    const list = (json.data || []).map(m => ({ id: m.id, cat: categorize(m.id) }));
    list.sort((a, b) => a.id.localeCompare(b.id));
    state.models = list;
    pickDefaults();
    renderModelsTab();
    renderImageSelect();
    renderChatModelBtn();
    return true;
  } catch (e) {
    $("#setupStatus").className = "setup-status error";
    $("#setupStatus").textContent = "Failed: " + e.message;
    toast("Could not load models: " + e.message, "error");
    return false;
  }
}

function pickDefaults() {
  const ids = state.models.map(m => m.id);
  const chatModels = state.models.filter(m => m.cat === "chat").map(m => m.id);
  const imgModels  = state.models.filter(m => m.cat === "image").map(m => m.id);

  const savedChat = localStorage.getItem(LS.chat);
  state.chatModel = (savedChat && ids.includes(savedChat)) ? savedChat
    : PREFERRED_CHAT.find(id => ids.includes(id)) || chatModels[0] || "";

  const savedImg = localStorage.getItem(LS.img);
  state.imgModel = (savedImg && ids.includes(savedImg)) ? savedImg
    : PREFERRED_IMAGE.find(id => ids.includes(id)) || imgModels[0] || "";
}

/* ---------------- models tab ---------------- */
function renderModelsTab() {
  const counts = { all: state.models.length, chat: 0, image: 0, other: 0 };
  for (const m of state.models) {
    if (m.cat === "chat") counts.chat++;
    else if (m.cat === "image") counts.image++;
    else counts.other++;
  }
  $("#cnt-all").textContent = counts.all;
  $("#cnt-chat").textContent = counts.chat;
  $("#cnt-image").textContent = counts.image;
  $("#cnt-other").textContent = counts.other;

  const q = state.modelQuery.toLowerCase();
  const visible = state.models.filter(m => {
    if (state.modelFilter === "chat" && m.cat !== "chat") return false;
    if (state.modelFilter === "image" && m.cat !== "image") return false;
    if (state.modelFilter === "other" && (m.cat === "chat" || m.cat === "image")) return false;
    return !q || m.id.toLowerCase().includes(q);
  });

  const listEl = $("#modelList");
  if (!state.models.length) {
    listEl.innerHTML = `<p class="dim center">Connect with your API key to load models.</p>`;
    return;
  }
  if (!visible.length) {
    listEl.innerHTML = `<p class="dim center">No models match.</p>`;
    return;
  }
  listEl.innerHTML = visible.map(m => {
    const usable = m.cat === "chat" || m.cat === "image";
    const isSel = m.id === state.chatModel || m.id === state.imgModel;
    return `<div class="model-card">
      <div>
        <div class="mc-id">${esc(m.id)}${isSel ? " ✅" : ""}</div>
        <div class="mc-cat">${m.cat}</div>
      </div>
      <button class="use-btn" data-id="${esc(m.id)}" ${usable ? "" : "disabled title=\"Not supported in this UI — use the raw API\""}>
        ${usable ? (isSel ? "Selected" : "Use") : "API only"}
      </button>
    </div>`;
  }).join("");
}

function useModel(id) {
  const m = state.models.find(x => x.id === id);
  if (!m) return;
  if (m.cat === "image") {
    state.imgModel = id;
    localStorage.setItem(LS.img, id);
    renderImageSelect();
    switchTab("image");
    toast("Image model set: " + id);
  } else {
    state.chatModel = id;
    localStorage.setItem(LS.chat, id);
    renderChatModelBtn();
    switchTab("chat");
    toast("Chat model set: " + id);
  }
  renderModelsTab();
}

/* ---------------- chat UI ---------------- */
function renderChatModelBtn() {
  $("#chatModelName").textContent = state.chatModel || "Select a model";
}

function switchTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + name));
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
}

function renderMessages() {
  const box = $("#chatMessages");
  box.innerHTML = "";
  if (!state.history.length) {
    box.innerHTML = $("#chatEmpty") ? "" : "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.id = "chatEmpty";
    empty.innerHTML = `
      <div class="empty-logo">🚀</div>
      <h2>Welcome to NIM Studio</h2>
      <p>Enter your NVIDIA API key, pick any model, and start chatting.<br>
      You can attach <b>images</b> (for vision models) and <b>text / code files</b>.</p>
      <p class="dim">Get a free key at <a href="https://build.nvidia.com" target="_blank" rel="noopener">build.nvidia.com</a></p>`;
    box.appendChild(empty);
    return;
  }
  for (const m of state.history) appendMessage(m.role, m.content);
  scrollBottom();
}

function appendMessage(role, content) {
  const box = $("#chatMessages");
  const empty = $("#chatEmpty");
  if (empty) empty.remove();

  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "assistant");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You" : (state.chatModel || "Assistant");
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const imgs = contentImages(content);
  if (imgs.length) {
    const tb = document.createElement("div");
    tb.className = "thumbs";
    for (const src of imgs) {
      const im = document.createElement("img");
      im.src = src; im.alt = "attachment";
      tb.appendChild(im);
    }
    bubble.appendChild(tb);
  }
  const bodyEl = document.createElement("div");
  bodyEl.className = "msg-body";
  bodyEl.innerHTML = mdToHtml(contentToText(content));
  bubble.appendChild(bodyEl);

  wrap.appendChild(who);
  wrap.appendChild(bubble);
  box.appendChild(wrap);
  return wrap;
}

function scrollBottom() {
  const box = $("#chatMessages");
  box.scrollTop = box.scrollHeight;
}

/* copy buttons in generated markdown */
document.addEventListener("click", e => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const code = btn.closest(".codeblock").querySelector("code").innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1400);
  }).catch(() => toast("Copy failed", "warn"));
});

/* ---------------- attachments ---------------- */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|ts|jsx|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|yml|yaml|toml|ini|cfg|conf|log|xml|html|css|sql|swift|r|lua|pl|tex)$/i;

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (file.type.startsWith("image/")) {
      const url = await readDataURL(file);
      state.pending.push({ name: file.name, kind: "image", part: { type: "image_url", image_url: { url } } });
    } else if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(file.name)) {
      if (file.size > 1_000_000) { toast(`${file.name} is over 1 MB — skipped.`, "warn"); continue; }
      const txt = await file.text();
      state.pending.push({
        name: file.name, kind: "file",
        part: { type: "text", text: `\n\n[Attached file: ${file.name}]\n--------\n${txt}\n--------\n[End of ${file.name}]` },
      });
    } else if (file.type === "application/pdf") {
      toast("PDF attachments aren't supported — use images or text files.", "warn");
    } else {
      toast(`Unsupported file type: ${file.name}`, "warn");
    }
  }
  renderPending();
}

function renderPending() {
  const box = $("#attachPreviews");
  box.innerHTML = "";
  state.pending.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (p.kind === "image") {
      const im = document.createElement("img");
      im.src = p.part.image_url.url;
      chip.appendChild(im);
    } else {
      const ic = document.createElement("span");
      ic.textContent = "📄";
      chip.appendChild(ic);
    }
    const nm = document.createElement("span");
    nm.textContent = p.name.length > 22 ? p.name.slice(0, 20) + "…" : p.name;
    chip.appendChild(nm);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.onclick = () => { state.pending.splice(i, 1); renderPending(); };
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

/* ---------------- sending chat ---------------- */
function toggleSendStop() {
  $("#sendBtn").hidden = state.generating;
  $("#stopBtn").hidden = !state.generating;
}

async function sendChat() {
  if (state.generating) return;
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text && !state.pending.length) return;

  if (!state.chatModel) { toast("Pick a chat model first.", "warn"); openPicker(); return; }
  if (!state.apiKey) { openModal("setupModal"); return; }

  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const p of state.pending) parts.push(p.part);
  const content = (parts.length === 1 && parts[0].type === "text") ? text : parts;

  state.history.push({ role: "user", content });
  state.pending = [];
  renderPending();
  input.value = "";
  input.style.height = "auto";
  renderMessages();
  scrollBottom();

  await streamAssistant();
}

function buildMessages() {
  const msgs = [];
  const sys = localStorage.getItem(LS.sys);
  if (sys && sys.trim()) msgs.push({ role: "system", content: sys.trim() });
  msgs.push(...state.history);
  return msgs;
}

async function streamAssistant() {
  state.generating = true;
  state.stopRequested = false;
  toggleSendStop();

  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = state.chatModel;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const bodyEl = document.createElement("div");
  bodyEl.className = "msg-body typing";
  bubble.appendChild(bodyEl);
  wrap.appendChild(who);
  wrap.appendChild(bubble);
  $("#chatMessages").appendChild(wrap);
  scrollBottom();

  let text = "", reasoning = "", gotSomething = false;
  let renderQueued = false;
  const paint = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      bodyEl.innerHTML = (reasoning ? `<p class="dim"><em>${esc(reasoning)}</em></p>` : "") + mdToHtml(text);
      scrollBottom();
    });
  };

  const body = {
    model: state.chatModel,
    messages: buildMessages(),
    temperature: parseFloat($("#tempRange").value),
    top_p: 0.95,
    max_tokens: parseInt($("#maxTokens").value, 10) || 2048,
    stream: true,
  };

  try {
    let res = await api("/chat/completions", { method: "POST", body: JSON.stringify(body) });

    if (!res.ok) {
      const errText = await safeErr(res);
      // Some models don't support streaming — retry without stream.
      if (/stream/i.test(errText)) {
        res = await api("/chat/completions", {
          method: "POST",
          body: JSON.stringify(Object.assign({}, body, { stream: false })),
        });
        if (!res.ok) throw new Error(await safeErr(res));
        const j = await res.json();
        const c = j.choices && j.choices[0];
        text = (c && c.message && c.message.content) || "";
        gotSomething = !!text;
      } else {
        throw new Error(errText);
      }
    } else if (body.stream && res.body) {
      const reader = res.body.getReader();
      state.reader = reader;
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const ch = j.choices && j.choices[0];
            if (!ch) continue;
            const d = ch.delta || {};
            if (d.content) { text += d.content; gotSomething = true; paint(); }
            if (d.reasoning_content) { reasoning += d.reasoning_content; paint(); }
          } catch (_) { /* keep-alive or partial */ }
        }
      }
    } else {
      const j = await res.json();
      const c = j.choices && j.choices[0];
      text = (c && c.message && c.message.content) || "";
      gotSomething = !!text;
    }

    if (!gotSomething) text = "(The model returned an empty response.)";
    state.history.push({ role: "assistant", content: text });
  } catch (e) {
    if (state.stopRequested) {
      if (text) {
        state.history.push({ role: "assistant", content: text + "\n\n_(stopped)_" });
      } else {
        bodyEl.innerHTML = `<span class="err-text">Generation stopped.</span>`;
        return finishStream(wrap);
      }
    } else {
      bodyEl.classList.remove("typing");
      bodyEl.innerHTML = `<span class="err-text">⚠ ${esc(e.message || String(e))}</span>` +
        (e instanceof TypeError
          ? `<p class="dim small">Network/CORS error. If you opened this site from a static host, run <code>python3 server.py</code> in the site folder and use the local URL — the app auto-routes through the proxy.</p>`
          : "");
      return finishStream(wrap);
    }
  } finally {
    state.reader = null;
  }

  bodyEl.classList.remove("typing");
  bodyEl.innerHTML = mdToHtml(text);
  scrollBottom();
  finishStream(wrap);
}

function finishStream(wrap) {
  state.generating = false;
  toggleSendStop();
  const bodyEl = wrap.querySelector(".msg-body");
  if (bodyEl) bodyEl.classList.remove("typing");
  scrollBottom();
}

/* ---------------- image generation ---------------- */
function renderImageSelect() {
  const sel = $("#imgModelSel");
  const imgs = state.models.filter(m => m.cat === "image");
  sel.innerHTML = "";
  if (!imgs.length) {
    sel.innerHTML = `<option value="">${state.models.length ? "No image models found on this key" : "Connect to load image models…"}</option>`;
    return;
  }
  for (const m of imgs) {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = m.id;
    sel.appendChild(o);
  }
  if (state.imgModel && imgs.some(m => m.id === state.imgModel)) sel.value = state.imgModel;
  else { state.imgModel = sel.value; }
}

function looksLikeB64Image(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.startsWith("data:image")) return true;
  if (t.length < 500) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(t.slice(0, 2000));
}

function b64ToDataURL(b64) {
  b64 = b64.replace(/\s+/g, "");
  if (b64.startsWith("data:")) return b64;
  let mime = "image/png";
  try {
    const bin = atob(b64);
    if (bin[0] === "\xFF" && bin[1] === "\xD8") mime = "image/jpeg";
    else if (bin[0] === "\x89" && bin[1] === "P") mime = "image/png";
    else if (bin.slice(0, 4) === "RIFF" && bin.slice(8, 12) === "WEBP") mime = "image/webp";
    else if (bin.slice(0, 5) === "GIF87" || bin.slice(0, 5) === "GIF89") mime = "image/gif";
  } catch (_) { /* keep png */ }
  return `data:${mime};base64,${b64}`;
}

function extractImages(json) {
  const out = [];
  const pushB64 = b => { const u = b64ToDataURL(b); if (u) out.push(u); };

  if (Array.isArray(json.data)) {
    for (const d of json.data) {
      if (d && d.b64_json) pushB64(d.b64_json);
      else if (d && d.url) out.push(d.url);
    }
  }
  const choice = json.choices && json.choices[0];
  if (choice) {
    const c = choice.message ? choice.message.content : choice.content;
    if (typeof c === "string") {
      const t = c.trim();
      if (looksLikeB64Image(t)) pushB64(t);
      else if (t.startsWith("{") || t.startsWith("[")) {
        try {
          const inner = JSON.parse(t);
          const arr = inner.images || inner.artifacts || inner.data ||
                      (Array.isArray(inner) ? inner : null);
          if (Array.isArray(arr)) {
            for (const it of arr) {
              if (typeof it === "string") pushB64(it);
              else if (it && (it.b64_json || it.image)) pushB64(it.b64_json || it.image);
              else if (it && it.url) out.push(it.url);
            }
          }
        } catch (_) { /* not JSON */ }
      }
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && part.type === "image_url" && part.image_url && part.image_url.url) out.push(part.image_url.url);
      }
    }
  }
  return out;
}

async function generateImage() {
  if (state.generating) return;
  const model = $("#imgModelSel").value;
  const prompt = $("#imgPrompt").value.trim();
  const statusEl = $("#imgStatus");
  if (!model) { toast("No image model selected.", "warn"); return; }
  if (!prompt) { toast("Write a prompt first.", "warn"); return; }
  if (!state.apiKey) { openModal("setupModal"); return; }

  const [w, h] = $("#imgSize").value.split("x").map(Number);
  const body = { model, messages: [{ role: "user", content: prompt }], stream: false };
  if (/stable[-_ ]?diffusion|sdxl/i.test(model)) {
    Object.assign(body, {
      height: h, width: w,
      steps: Math.max(1, Math.min(100, parseInt($("#imgSteps").value, 10) || 30)),
      cfg_scale: Math.max(1, Math.min(20, parseFloat($("#imgCfg").value) || 5)),
    });
  }

  state.generating = true;
  const btn = $("#imgGenBtn");
  btn.disabled = true;
  statusEl.className = "img-status";
  const started = Date.now();
  statusEl.innerHTML = `<span class="spinner"></span>Generating with ${esc(model)}… this can take up to a minute.`;

  try {
    const res = await api("/chat/completions", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await safeErr(res));
    const json = await res.json();
    const urls = extractImages(json);
    if (!urls.length) {
      console.log("Raw image-model response:", json);
      throw new Error("The model returned no image data. Check the raw response in the browser console.");
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    statusEl.textContent = `✅ Generated ${urls.length} image${urls.length > 1 ? "s" : ""} in ${secs}s.`;
    for (const url of urls) addGalleryItem(url, prompt);
  } catch (e) {
    statusEl.className = "img-status error";
    statusEl.textContent = "⚠ " + (e.message || String(e));
  } finally {
    state.generating = false;
    btn.disabled = false;
  }
}

function addGalleryItem(url, prompt) {
  const g = $("#imgGallery");
  const item = document.createElement("div");
  item.className = "img-item";
  const im = document.createElement("img");
  im.src = url;
  im.alt = prompt;
  item.appendChild(im);
  const bar = document.createElement("div");
  bar.className = "img-item-bar";
  const label = document.createElement("span");
  label.textContent = new Date().toLocaleTimeString();
  const a = document.createElement("a");
  a.href = url.startsWith("data:") ? url : url;
  a.download = "nim-studio-" + Date.now() + ".png";
  a.target = "_blank";
  a.textContent = "⬇ Download";
  bar.appendChild(label);
  bar.appendChild(a);
  item.appendChild(bar);
  g.prepend(item);
}

/* ---------------- model picker ---------------- */
function openPicker() {
  const list = $("#pickerList");
  const q = $("#pickerSearch").value.trim().toLowerCase();
  const chatModels = state.models.filter(m => m.cat === "chat" || m.cat === "audio" || m.cat === "video")
    .filter(m => !q || m.id.toLowerCase().includes(q));
  if (!chatModels.length) {
    list.innerHTML = `<p class="dim center">No models${q ? " match" : " loaded — connect first"}.</p>`;
  } else {
    list.innerHTML = chatModels.map(m =>
      `<button class="picker-item${m.id === state.chatModel ? " selected" : ""}" data-id="${esc(m.id)}">
        ${esc(m.id)}${visionLikely(m.id) ? '<span class="vis-tag">👁 vision</span>' : ""}
      </button>`).join("");
  }
  openModal("pickerModal");
}

/* ---------------- wiring ---------------- */
function bindEvents() {
  // tabs
  $$(".nav-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // modals: close buttons & backdrop click
  $$(".modal-close").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
  $$(".modal-backdrop").forEach(bd => bd.addEventListener("click", e => {
    if (e.target === bd && bd.id !== "setupModal") bd.hidden = true;
    else if (e.target === bd && state.apiKey) bd.hidden = true;
  }));

  // setup
  $("#setupBtn").onclick = () => {
    $("#apiKeyInput").value = state.apiKey;
    $("#modeSel").value = state.mode;
    $("#setupStatus").textContent = "";
    openModal("setupModal");
  };
  $("#keyEyeBtn").onclick = () => {
    const i = $("#apiKeyInput");
    i.type = i.type === "password" ? "text" : "password";
  };
  $("#connectBtn").onclick = () => {
    const key = $("#apiKeyInput").value.trim();
    if (!key) { toast("Enter your API key.", "warn"); return; }
    state.mode = $("#modeSel").value;
    localStorage.setItem(LS.mode, state.mode);
    connect(key);
  };
  $("#apiKeyInput").addEventListener("keydown", e => {
    if (e.key === "Enter") $("#connectBtn").click();
  });
  $("#disconnectBtn").onclick = () => {
    localStorage.removeItem(LS.key);
    state.apiKey = "";
    state.models = [];
    state.history = [];
    setConn(null);
    renderMessages();
    renderModelsTab();
    renderImageSelect();
    renderChatModelBtn();
    $("#apiKeyInput").value = "";
    $("#setupStatus").textContent = "Key forgotten.";
    toast("Disconnected.");
  };

  // chat
  $("#chatModelBtn").onclick = openPicker;
  $("#pickerSearch").addEventListener("input", openPicker);
  $("#pickerList").addEventListener("click", e => {
    const item = e.target.closest(".picker-item");
    if (!item) return;
    state.chatModel = item.dataset.id;
    localStorage.setItem(LS.chat, state.chatModel);
    renderChatModelBtn();
    closeModal("pickerModal");
  });

  $("#sendBtn").onclick = sendChat;
  $("#stopBtn").onclick = () => {
    state.stopRequested = true;
    if (state.reader) state.reader.cancel().catch(() => {});
  };
  const input = $("#chatInput");
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  $("#attachBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").addEventListener("change", e => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  // drag & drop attachments
  const chatTab = $("#tab-chat");
  ["dragover", "drop"].forEach(ev => chatTab.addEventListener(ev, e => e.preventDefault()));
  chatTab.addEventListener("drop", e => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  // paste images
  input.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { addFiles(files); e.preventDefault(); }
  });

  $("#clearChatBtn").onclick = () => {
    state.history = [];
    renderMessages();
    toast("Conversation cleared.");
  };

  // settings
  $("#chatSettingsBtn").onclick = () => {
    $("#sysPrompt").value = localStorage.getItem(LS.sys) || "";
    $("#tempRange").value = localStorage.getItem(LS.temp) || "0.7";
    $("#tempLabel").textContent = $("#tempRange").value;
    $("#maxTokens").value = localStorage.getItem(LS.tok) || "2048";
    openModal("settingsModal");
  };
  $("#tempRange").addEventListener("input", () => {
    $("#tempLabel").textContent = $("#tempRange").value;
    localStorage.setItem(LS.temp, $("#tempRange").value);
  });
  $("#sysPrompt").addEventListener("change", () => localStorage.setItem(LS.sys, $("#sysPrompt").value));
  $("#maxTokens").addEventListener("change", () => localStorage.setItem(LS.tok, $("#maxTokens").value));

  // models tab
  $("#modelSearch").addEventListener("input", e => { state.modelQuery = e.target.value; renderModelsTab(); });
  $$("#catChips .chip").forEach(ch => ch.addEventListener("click", () => {
    $$("#catChips .chip").forEach(c => c.classList.remove("active"));
    ch.classList.add("active");
    state.modelFilter = ch.dataset.cat;
    renderModelsTab();
  }));
  $("#modelList").addEventListener("click", e => {
    const btn = e.target.closest(".use-btn");
    if (btn && !btn.disabled) useModel(btn.dataset.id);
  });
  $("#refreshModelsBtn").onclick = async () => {
    if (!state.apiKey) { openModal("setupModal"); return; }
    toast("Refreshing models…");
    await loadModels();
    toast(`${state.models.length} models loaded.`);
  };

  // image tab
  $("#imgModelSel").addEventListener("change", e => {
    state.imgModel = e.target.value;
    localStorage.setItem(LS.img, state.imgModel);
  });
  $("#imgGenBtn").onclick = generateImage;
}

/* ---------------- init ---------------- */
async function init() {
  bindEvents();
  state.mode = localStorage.getItem(LS.mode) || "auto";
  $("#modeSel").value = state.mode;
  $("#tempRange").value = localStorage.getItem(LS.temp) || "0.7";
  $("#tempLabel").textContent = $("#tempRange").value;
  $("#maxTokens").value = localStorage.getItem(LS.tok) || "2048";

  const key = localStorage.getItem(LS.key);
  if (key) {
    $("#apiKeyInput").value = key;
    await connect(key);
  } else {
    openModal("setupModal");
  }
}

document.addEventListener("DOMContentLoaded", init);
