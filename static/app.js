/* LFM3 Omni local web UI - app.js */

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

const state = {
  mode: "chat",
  serverUrl: "http://127.0.0.1:9931",
  health: null,
  messages: [],
  pending: [],
  streaming: false,
  tts: { status: "idle", text: "", lang: "en", voice: "female", last: null },
  voice: { status: "ready", listening: false, userText: "", assistantText: "", history: [], recorder: null, discard: false, voice: "female", stats: null, micStream: null, ptt: false, busy: false },
  ctxWindow: null,
  listen: { status: "idle", b64: null, lastContent: null, transcript: "", recorder: null, chunks: [], space: false, auto: false },
  speakRec: { active: false, recorder: null, chunks: [] },
  look: { image: null, answer: "", busy: false },
  chats: [],
  currentChatId: null,
};

const chatPlayers = {};
const chatWaves = {};

const SETTINGS = { serverUrl: "http://127.0.0.1:9931", temperature: 0, maxTokens: 32768, instructions: "", outMode: "text,audio", voice: "female" };

/* ---------------- helpers ---------------- */

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtTime() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

function fmtK(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
  return (n / 1000000).toFixed(1) + "m";
}

function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

function statsFromChunk(tc, ttftMs, totalMs) {
  const t = (tc && tc.timings) || {};
  const u = (tc && tc.usage) || {};
  const prompt = u.prompt_tokens != null ? u.prompt_tokens : (t.prompt_n != null ? t.prompt_n : null);
  const out = u.completion_tokens != null ? u.completion_tokens : (t.predicted_n != null ? t.predicted_n : null);
  const ctx = u.total_tokens != null ? u.total_tokens : (prompt != null && out != null ? prompt + out : null);
  const tps = t.predicted_per_second != null ? t.predicted_per_second : (out != null && t.predicted_ms ? out / (t.predicted_ms / 1000) : null);
  const prefill = t.prompt_per_second != null ? t.prompt_per_second : (prompt != null && t.prompt_ms ? prompt / (t.prompt_ms / 1000) : null);
  return { ttftMs, totalMs, tps, prefill, prompt, out, ctx };
}

function updateCtxChip(used) {
  const el = $("#ctx-chip");
  if (!el) return;
  const win = state.ctxWindow;
  if (used == null) { el.textContent = win ? "ctx — / " + fmtK(win) : "ctx —"; return; }
  el.textContent = "ctx " + fmtK(used) + (win ? " / " + fmtK(win) : "");
  el.title = "context used in the last turn" + (win ? " · window " + fmtK(win) : "");
}

async function loadProps() {
  try {
    const r = await fetch("/api/props");
    if (!r.ok) return;
    const j = await r.json();
    const n = j && j.default_generation_settings && j.default_generation_settings.n_ctx;
    if (n) { state.ctxWindow = n; updateCtxChip(null); }
  } catch (e) { /* optional */ }
}

function blobUrlFromB64(b64, mime) { return URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: mime || "audio/wav" })); }

async function api(path, body, timeout = 300) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: j };
  } catch (e) { return { ok: false, status: 0, error: String(e) }; }
  finally { clearTimeout(t); }
}

/* ---------------- chat persistence ---------------- */

async function apiGet(path, timeout = 20000) {
  try {
    const r = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: j };
  } catch (e) { return { ok: false, status: 0, error: String(e) }; }
}

async function listChats() {
  const r = await apiGet("/api/chats");
  if (r.ok && r.data) { state.chats = r.data.chats || []; renderChats(); }
  return state.chats;
}

function generateChatName(text) {
  const t = String(text || "").trim();
  if (!t) return "Chat";
  const low = t.toLowerCase();
  if (/^(hi|hello|hey|greetings|good morning|good afternoon|good evening|yo|sup)\b/.test(low)) return "Greeting";
  if (/(python|javascript|js|typescript|code|write|create|build|program|script|function|calculator|app|website|html|css|react|java|c\+\+|rust|go|ruby|php|sql)/.test(low)) return "Code";
  if (/^(what|how|why|when|where|who|can|could|would|is|are|do|does|will|shall)\b/.test(low)) return "Question";
  if (/(explain|tell me|describe|summary|summarize|review|analyze|help me understand)/.test(low)) return "Explanation";
  if (/(joke|funny|story|poem|creative|write a|compose|lyrics)/.test(low)) return "Creative";
  if (/(translate|conversion|convert)/.test(low)) return "Translation";
  if (/(plan|schedule|itinerary|agenda|todo|list)/.test(low)) return "Planning";
  const words = t.split(/\s+/).slice(0, 5);
  return (words.join(" ") || "Chat").replace(/[.,!?;:]$/, "");
}

async function saveChat() {
  if (!state.messages.length) return;
  const cid = state.currentChatId || "chat-" + Date.now();
  const title = generateChatName(state.messages[0] && state.messages[0].content ? msgText(state.messages[0]) : "");
  const r = await api("/api/chats", { id: cid, title, messages: state.messages, createdAt: state.currentChatId ? Date.now() : Date.now() });
  if (r.ok && r.data) {
    state.currentChatId = r.data.id || cid;
    await listChats();
  }
  return r;
}

async function loadChat(id) {
  const r = await apiGet("/api/chats/" + id);
  if (r.ok && r.data && r.data.chat) {
    state.currentChatId = id;
    state.messages = r.data.chat.messages || [];
    renderThread();
    renderChats();
  }
  return r;
}

async function deleteChat(id) {
  await fetch("/api/chats/" + id, { method: "DELETE" });
  if (state.currentChatId === id) { state.currentChatId = null; state.messages = []; renderThread(); }
  await listChats();
}

function newChat() {
  state.currentChatId = null;
  state.messages = [];
  renderThread();
  renderChats();
  saveChat();
}

function autoSaveChat() { saveChat(); }

function renderChats() {
  const list = $("#chats-list");
  if (!list) return;
  list.innerHTML = state.chats.map((c) => {
    const active = c.id === state.currentChatId ? " active" : "";
    const updated = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="chat-item${active}" data-id="${esc(c.id)}">
      <div class="title">${esc(c.title || "Chat")}</div>
      <div class="meta">${updated}</div>
      <button class="del" data-act="chat-delete" data-id="${esc(c.id)}" title="delete">×</button>
    </div>`;
  }).join("");
  list.querySelectorAll(".chat-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".del")) return;
      loadChat(el.dataset.id);
      closeSidebar();
    });
  });
  list.querySelectorAll("[data-act='chat-delete']").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); deleteChat(b.dataset.id); });
  });
  const badge = $("#chats-badge"); if (badge) badge.textContent = String(state.chats.length || 0);
}

async function refreshHealth() {
  let r = null;
  for (let i = 0; i < 5; i++) {
    r = await apiGet("/api/health");
    (window.__healthLog = window.__healthLog || []).push({ attempt: i, ok: r.ok, status: r.status, err: r.error, dataOk: !!(r.data && r.data.ok) });
    if (r.ok && r.data && r.data.ok) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  if (r && r.ok && r.data && r.data.ok) {
    state.health = r.data;
    $("#st-model").textContent = r.data.model || "—";
    $("#st-server").textContent = r.data.server_version || "llama.cpp";
    $("#st-mod").textContent = (r.data.input_modalities || []).join("+") + " → " + (r.data.output_modalities || []).join("+");
    $("#st-addr").textContent = state.serverUrl.replace(/^https?:\/\//, "");
    const caps = $("#empty-caps");
    if (caps) {
      const ins = (r.data.input_modalities || []).map((m) => `<span class="cap-chip">in <b>${m}</b></span>`).join("");
      const outs = (r.data.output_modalities || []).map((m) => `<span class="cap-chip">out <b>${m}</b></span>`).join("");
      caps.innerHTML = ins + outs;
    }
    $("#status-label").textContent = "online";
    const dot = $(".topbar .chip .dot");
    dot.classList.remove("bad"); dot.classList.add("ok", "pulse");
    return true;
  }
  $("#status-label").textContent = "offline";
  const dot = $(".topbar .chip .dot");
  dot.classList.remove("ok"); dot.classList.add("bad");
  return false;
}

function pollHealth() { setInterval(() => { if (!document.hidden) refreshHealth(); }, 10000); }

/* ---------------- chat ---------------- */

function attPart(a) {
  if (a.kind === "image") return { type: "image_url", image_url: { url: a.dataUrl || a.url || a.b64 } };
  if (a.kind === "audio") return { type: "input_audio", input_audio: { data: (a.b64 || "").split(",").pop(), format: "wav" } };
  if (a.kind === "video") return { type: "input_video", input_video: { data: (a.b64 || "").split(",").pop(), format: "mp4" } };
  if (a.kind === "document") return { type: "image_url", image_url: { url: a.dataUrl || a.url || a.b64 } };
  return { type: "text", text: a.name || "" };
}

function buildContent(text, atts) {
  const parts = [];
  const t = (text || "").trim();
  if (t) parts.push({ type: "text", text: t });
  for (const a of atts || []) { const p = attPart(a); if (p.type) parts.push(p); }
  if (parts.length === 0) return t;
  return parts;
}

async function* streamChat(body) {
  const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { yield { error: "chat failed " + r.status }; return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try { yield JSON.parse(payload); } catch (e) { /* ignore */ }
      }
    }
  }
}

function lastUserMsg() { for (let i = state.messages.length - 1; i >= 0; i--) if (state.messages[i].role === "user") return state.messages[i]; return null; }

function chatBody() {
  return { model: "lfm3-omni-2b", messages: state.messages.map((m) => ({ role: m.role, content: m.content })), temperature: SETTINGS.temperature, max_tokens: SETTINGS.maxTokens, stream: true, stream_options: { include_usage: true } };
}

async function sendChat() {
  if (state.streaming) return;
  // If an in-chat audio recording is in progress, stop it first so it gets attached
  if (state.pendingMic) {
    const mr = state.pendingMic;
    state.pendingMic = null;
    $("#btn-mic").classList.remove("on");
    mr.stop();
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (state.pending.some((p) => p.name === "recording.wav" && p.b64)) {
          clearInterval(t);
          resolve();
        }
      }, 50);
      setTimeout(() => { clearInterval(t); resolve(); }, 3000);
    });
  }
  const text = $("#composer-input").value.trim();
  const content = buildContent(text, state.pending);
  state.messages.push({ id: "m" + Date.now(), role: "user", content, ts: Date.now() });
  state.pending = [];
  renderPending();
  setComposerText("");
  state.streaming = true;
  const body = chatBody();
  state.messages.push({ id: "ma" + Date.now(), role: "assistant", content: "", ts: Date.now(), streaming: true });
  renderThread();
  let full = "";
  let reasoning = "";
  let firstAt = null;
  let finalChunk = null;
  const t0 = performance.now();
  try {
    for await (const ev of streamChat(body)) {
      if (ev.error) throw new Error(ev.error);
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (delta) {
        if ((delta.content || delta.reasoning_content) && firstAt == null) firstAt = performance.now();
        if (delta.content) { full += delta.content; updateLastAssistantText(full); }
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
      }
      finalChunk = ev;
    }
  } catch (e) {
    state.streaming = false;
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant") { last.content = full || "_stopped_"; last.reasoning = reasoning; last.finish = "stopped"; }
    else pushAssistant(full || "_stopped_", reasoning, null, "stopped", null);
    renderThread();
    autoSaveChat();
    return;
  }
  state.streaming = false;
  const tc = finalChunk || {};
  const stats = statsFromChunk(tc, firstAt == null ? null : firstAt - t0, performance.now() - t0);
  updateCtxChip(stats.ctx);
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "assistant") { last.content = full; last.reasoning = reasoning; last.stats = stats; last.finish = tc.choices && tc.choices[0] && tc.choices[0].finish_reason; delete last.streaming; }
  else pushAssistant(full, reasoning, null, tc.choices && tc.choices[0] && tc.choices[0].finish_reason, stats);
  renderThread();
  autoSaveChat();
}

function pushAssistant(text, reasoning, timings, finish, stats) {
  const last = state.messages[state.messages.length - 1];
  const m = { id: last && last.role === "assistant" ? last.id : "m" + Date.now(), role: "assistant", content: text, ts: Date.now() };
  m.reasoning = reasoning;
  m.timings = timings;
  m.stats = stats;
  m.finish = finish;
  state.messages.push(m);
}

function updateLastAssistantText(full) {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  last.content = full;
  renderThread();
}

function regenerate() {
  if (state.streaming) return;
  const u = lastUserMsg();
  if (!u) return;
  const idx = state.messages.lastIndexOf(u);
  state.messages = state.messages.slice(0, idx + 1);
  state.streaming = true;
  let full = "";
  let firstAt = null;
  let finalChunk = null;
  const t0 = performance.now();
  renderThread();
  (async () => {
    for await (const ev of streamChat(chatBody())) { if (ev.error) break; const d = ev.choices && ev.choices[0] && ev.choices[0].delta; if (d && d.content) { if (firstAt == null) firstAt = performance.now(); full += d.content; } finalChunk = ev; }
    state.streaming = false;
    const tc = finalChunk || {};
    const stats = statsFromChunk(tc, firstAt == null ? null : firstAt - t0, performance.now() - t0);
    updateCtxChip(stats.ctx);
    pushAssistant(full, "", null, tc.choices && tc.choices[0] && tc.choices[0].finish_reason, stats);
    renderThread();
    autoSaveChat();
  })();
}

let _ttsCtx=null,_ttsAnalyser=null,_ttsBars=null,_ttsRaf=null;
function setupTtsWave(audio){
  if(!_ttsBars){
    const wrap=document.createElement("div");
    wrap.id="tts-wave"; wrap.style.cssText="display:flex;align-items:flex-end;gap:2px;height:28px;margin:6px 0;";
    for(let i=0;i<24;i++){const b=document.createElement("div");b.className="wave-bar";b.style.cssText="width:3px;height:4px;background:var(--accent);border-radius:2px;transition:height .05s;";wrap.appendChild(b);}
    audio.parentNode.insertBefore(wrap,audio.nextSibling);
    _ttsBars=wrap.querySelectorAll(".wave-bar");
  }
  if(!_ttsCtx){try{_ttsCtx=new (window.AudioContext||window.webkitAudioContext)();_ttsAnalyser=_ttsCtx.createAnalyser();_ttsAnalyser.fftSize=64;const src=_ttsCtx.createMediaElementSource(audio);src.connect(_ttsAnalyser);_ttsAnalyser.connect(_ttsCtx.destination);}catch(e){console.error('tts wave err',e);}}
  if(!_ttsAnalyser){ _ttsBars.forEach(b=>b.style.height="4px"); return; }
  if(_ttsRaf) cancelAnimationFrame(_ttsRaf);
  const data=new Uint8Array(_ttsAnalyser.frequencyBinCount);
  const tick=()=>{ if(!_ttsAnalyser) return; _ttsAnalyser.getByteFrequencyData(data);_ttsBars.forEach((b,i)=>{const v=data[i%data.length]/255;b.style.height=(4+v*24)+"px";});_ttsRaf=requestAnimationFrame(tick);};
  tick();
  audio.onended=()=>{if(_ttsRaf)cancelAnimationFrame(_ttsRaf);_ttsBars.forEach(b=>b.style.height="4px");};
}
async function speakText(text, lang, voice) {
  const r = await api("/api/tts", { input: text, lang: "en", voice: state.tts.voice, response_format: "wav" });
  const d = r.data;
  window.__ttsErr = { ok: r.ok, status: r.status, error: r.error, keys: d && typeof d === "object" ? Object.keys(d) : typeof d, dataOk: !!(d && d.filename) };
  if (!r.ok || !d || !d.filename) { state.tts.status = "error"; renderSpeakState(); return null; }
  state.tts.last = d;
  state.tts.status = "ready";
  renderSpeakState();
  const url = blobUrlFromB64(d.data_b64, "audio/wav");
  const p = $("#tts-player");
  p.src = url;
  setupTtsWave(p);
  p.play().catch(() => {});
  const rate = parseInt((d.content_type || "").match(/rate=(\d+)/)?.[1] || "24000", 10);
  const nSamples = Math.floor((atob(d.data_b64).length) / 2);
  const dur = d.duration_s || (rate ? nSamples / rate : 0);
  $("#tts-meta").textContent = `llama.cpp · /tts → outputs/tts/${d.filename} · ${dur ? dur.toFixed(1) + "s" : ""}`;
  return url;
}

function renderSpeakState() { $("#tts-status").textContent = state.tts.status; $("#tts-result").style.display = state.tts.last ? "block" : "none"; }


function mdRender(s){s=String(s||"");const blocks=[];s=s.replace(/```mermaid([\s\S]*?)```/g,(_,c)=>{blocks.push(c.trim());return "\x00MER"+(blocks.length-1)+"\x00";});let h=s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
h=h.replace(/\x00MER(\d+)\x00/g,(_,i)=>"<div class=\"mermaid\">"+blocks[+i]+"</div>");
h=h.replace(/```([\s\S]*?)```/g,(_,c)=>{const lang=(c.match(/^\w+/)||[""])[0];const code=c.replace(/^\w+\n?/,"");return "<div class=\"code-wrap\"><button class=\"code-copy\" title=\"Copy\">⧉</button><pre><code class=\"lang-"+esc(lang)+"\">"+esc(code)+"</code></pre></div>";});
h=h.replace(/`([^`]+)`/g,"<code>$1</code>");
h=h.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
h=h.replace(/\*([^*]+)\*/g,"<em>$1</em>");
h=h.replace(/^### (.*)$/gm,"<h3>$1</h3>");
h=h.replace(/^## (.*)$/gm,"<h2>$1</h2>");
h=h.replace(/^# (.*)$/gm,"<h1>$1</h1>");
h=h.replace(/\n/g,"<br>");
return h;
}

const RATE_OPTS = ["1","1.25","1.5","1.75","2"].map((v)=>`<option value="${v}"${v==="1"?" selected":""}>${v}x</option>`).join("");

function msgText(m){if(!m)return"";if(typeof m.content==="string")return m.content;if(Array.isArray(m.content)){const t=m.content.find((p)=>p&&p.type==="text");return t?(t.text||""):"";}return String(m.content||"");}

function chatAudioEl(mid){return document.querySelector(`audio[data-mid="${CSS.escape(mid)}"]`);}

function stopChatWave(mid){
  const k = chatWaves[mid];
  if(k){ try{cancelAnimationFrame(k.raf);}catch(e){} k.bars.forEach((b)=>{b.style.height="4px";}); k.raf=null; }
}

function playChatAudio(mid){
  const audio = chatAudioEl(mid);
  if(!audio) return;
  const wrap = audio.closest(".chat-audio");
  const play = wrap ? wrap.querySelector(".chat-play") : null;
  const seek = wrap ? wrap.querySelector(".chat-seek") : null;
  const time = wrap ? wrap.querySelector(".chat-time") : null;
  const rate = wrap ? wrap.querySelector(".chat-rate") : null;
  const wave = wrap ? wrap.querySelector(".chat-wave") : null;
  if(rate){ audio.playbackRate = parseFloat(rate.value || "1"); rate.onchange = () => { audio.playbackRate = parseFloat(rate.value || "1"); }; }
  if(seek) seek.oninput = () => { if(!audio.duration) return; audio.currentTime = (seek.value/1000)*audio.duration; };
  if(wave){
    wave.style.cursor="pointer";
    wave.onclick = (e)=>{ if(!audio.duration) return; const r=wave.getBoundingClientRect(); const pct=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)); audio.currentTime = pct*audio.duration; };
    if(!wave.dataset.bars){
      wave.dataset.bars="1";
      for(let i=0;i<24;i++){const b=document.createElement("div");b.className="wave-bar";b.style.height="4px";wave.appendChild(b); }
    }
  }
  const bars = wave ? wave.querySelectorAll(".wave-bar") : [];
  if(!audio.dataset.wave){
    audio.dataset.wave="1";
    let ctx=null, analyser=null;
    try{
      ctx=new (window.AudioContext||window.webkitAudioContext)();
      if(ctx.state==="suspended") ctx.resume().catch(()=>{});
      analyser=ctx.createAnalyser(); analyser.fftSize=64;
      const src=ctx.createMediaElementSource(audio); src.connect(analyser); analyser.connect(ctx.destination);
    }catch(e){ console.error("chat wave err",e); }
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let raf=null;
    const tick=()=>{
      if(!analyser){ return; }
      analyser.getByteFrequencyData(data);
      bars.forEach((b,i)=>{ const v=data[i%data.length]/255; b.style.height=(4+v*24)+"px"; });
      raf=requestAnimationFrame(tick);
    };
    audio.onplay = ()=>{ if(wrap) wrap.classList.add("playing"); if(play) play.textContent="⏸"; if(!raf) tick(); };
    audio.onpause = ()=>{ if(wrap) wrap.classList.remove("playing"); if(play) play.textContent="▶"; try{cancelAnimationFrame(raf);}catch(e){} raf=null; };
    audio.onended = ()=>{ if(wrap) wrap.classList.remove("playing"); if(play) play.textContent="▶"; try{cancelAnimationFrame(raf);}catch(e){} raf=null; bars.forEach((b)=>{b.style.height="4px";}); if(seek) seek.value=1000; };
    audio.onloadedmetadata = ()=>{ if(time&&audio.duration) time.textContent = "0:00 / "+fmtTime2(audio.duration); };
    chatWaves[mid]={ctx,raf:null,bars};
  }
  audio.ontimeupdate = ()=>{ if(!audio.duration||!seek) return; seek.value=Math.round((audio.currentTime/audio.duration)*1000); if(time) time.textContent = fmtTime2(audio.currentTime)+" / "+fmtTime2(audio.duration); };
  if(audio.paused) audio.play().catch(()=>{}); else audio.pause();
}

async function speakInChat(mid){
  const m = state.messages.find((x)=>x.id===mid);
  if(!m) return;
  if(m.audioFile){ playChatAudio(mid); return; }
  state.tts.status = "generating";
  renderThread();
  const text = msgText(m);
  let input = text;
  let instructions = "";
  if (/```[\s\S]*?```/.test(text)) {
    instructions = "You are reading text aloud for English text-to-speech. Speak only in English. When the text contains code blocks, DO NOT read the code verbatim. Briefly explain what the code does in plain English. Skip reading the code itself. Only speak the explanation in English.";
    input = instructions + "\n\n---\n\n" + text;
  }
  const r = await api("/api/tts", { input: input, lang: "en", voice: state.tts.voice, response_format: "wav", instructions: instructions });
  const d = r.data;
  if(!r.ok || !d || !d.filename) { state.tts.status = "ready"; renderThread(); return; }
  m.audioFile = d.filename;
  state.tts.status = "ready";
  await autoSaveChat();
  renderThread();
  playChatAudio(mid);
}

/* ---------------- rendering: thread ---------------- */

function renderThread() {
  const inner = $("#thread-inner");
  const empty = $("#empty-state");
  if (!inner) return;
  if (empty) empty.style.display = state.messages.length === 0 ? "block" : "none";
  if (state.messages.length === 0) { inner.innerHTML = ""; return; }
  const html = state.messages.map((m) => {
    if (m.role === "user") {
      const partsArr = Array.isArray(m.content) ? m.content : [];
      const atts = partsArr.filter((p) => p.type && p.type !== "text");
      const txt = partsArr.length ? (partsArr.find((p) => p.type === "text") || {}).text || "" : String(m.content || "");
      const attHtml = atts.length ? `<div class="att">${atts.map((a) => {
        if (a.type === "image_url") return `<img src="${esc(a.image_url && a.image_url.url)}" alt="image">`;
        if (a.type === "input_audio") { const d = (a.input_audio && a.input_audio.data) || ""; return `<audio controls src="${d.startsWith("data:") ? esc(d) : "data:audio/wav;base64," + esc(d)}"></audio>`; }
        if (a.type === "input_video") { const d = (a.input_video && a.input_video.data) || ""; return `<video controls src="${d.startsWith("data:") ? esc(d) : "data:video/mp4;base64," + esc(d)}"></video>`; }
        return `<a href="${esc(a.image_url && a.image_url.url)}" target="_blank" rel="noopener">${esc(a.name || "document")}</a>`;
      }).join("")}</div>` : "";
      return `<div class="msg user"><div class="msg-body"><div class="bubble">${esc(txt)}${attHtml}</div></div></div>`;
    }
    const txt = m.content || "";
    const reasoning = m.reasoning;
    const streaming = state.streaming && state.messages[state.messages.length - 1] === m;
    const meta = [
      streaming ? `<span class="streaming-chip"><span class="spinner"></span>thinking…</span>` : `<span>${m.finish || ""}</span>`,
      m.stats ? `<span>ttft ${fmtMs(m.stats.ttftMs)}</span>` : "",
      m.stats && m.stats.tps != null ? `<span>${m.stats.tps.toFixed(1)} tok/s</span>` : "",
      m.stats ? `<span>${m.stats.prompt != null ? fmtK(m.stats.prompt) + " → " : ""}${m.stats.out != null ? fmtK(m.stats.out) : "?"} tok</span>` : "",
      m.stats && m.stats.ctx != null ? `<span>ctx ${fmtK(m.stats.ctx)}${state.ctxWindow ? "/" + fmtK(state.ctxWindow) : ""}</span>` : "",
      m.ts ? `<span>${fmtTime()}</span>` : "",
      `<button class="act${state.tts.status === "generating" ? " chat-speak-generating" : ""}" data-act="speak" data-mid="${m.id}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;font-family:var(--mono)">${state.tts.status === "generating" ? '<span class="spinner"></span>generating…' : "speak"}</button>`,
      `<button class="act" data-act="copy" data-mid="${m.id}" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:11px;font-family:var(--mono)">copy</button>`,
      m.role === "assistant" && !streaming ? `<button class="act" data-act="regen" data-mid="${m.id}" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:11px;font-family:var(--mono)">regenerate</button>` : "",
    ].join("");
    return `<div class="msg"><div class="msg-mark">L</div><div class="msg-body">
      <div class="bubble${streaming && !txt ? " caret" : ""}">${mdRender(txt)}</div>
      ${reasoning ? `<details class="reasoning"><summary>reasoning</summary><div class="body">${esc(reasoning)}</div></details>` : ""}
      <div class="meta">${meta}</div>
      ${m.audioFile ? `<div class="chat-audio" data-mid="${esc(m.id)}">
        <button class="chat-play" data-act="chat-play" data-mid="${esc(m.id)}">▶</button>
        <audio data-mid="${esc(m.id)}" src="/api/tts/${esc(m.audioFile)}" preload="metadata"></audio>
        <input type="range" class="chat-seek" data-mid="${esc(m.id)}" min="0" max="1000" value="0">
        <select class="chat-rate" data-mid="${esc(m.id)}">${RATE_OPTS}</select>
        <span class="chat-time" data-mid="${esc(m.id)}">0:00 / 0:00</span>
        <div class="chat-wave" data-mid="${esc(m.id)}"></div>
      </div>` : ""}
    </div></div>`;
  }).join("\n");
  inner.innerHTML = html;
  scrollToBottom();
  renderMermaid();
}

function renderMermaid() {
  try {
    if (window.mermaid) {
      mermaid.init(undefined, document.querySelectorAll(".msg .mermaid"));
    }
  } catch (e) { /* mermaid render optional */ }
}

function scrollToBottom() { const t = $("#thread"); if (t) t.scrollTop = t.scrollHeight; }

function updateLastAssistantTextSafe(full) { updateLastAssistantText(full); scrollToBottom(); }

/* ---------------- mode switching ---------------- */

function setMode(m) {
  state.mode = m;
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("#view-chat").style.display = m === "chat" ? "flex" : "none";
  $("#view-voice").style.display = m === "voice" ? "flex" : "none";
  $("#view-speak").style.display = m === "speak" ? "block" : "none";
  $("#view-listen").style.display = m === "listen" ? "block" : "none";
  $("#view-look").style.display = m === "look" ? "block" : "none";
  const titles = { chat: ["Chat", "the omni model, in your browser"], voice: ["Voice", "speech in, speech out"], speak: ["Speak", "text to speech"], listen: ["Listen", "transcribe & understand"], look: ["Look", "vision"] };
  const [t, s] = titles[m];
  $("#topbar-title").textContent = t;
  $("#topbar-sub").textContent = s;
  if (m === "chat") renderThread();
  if (m === "voice") { renderVoiceTranscript(); renderVoiceStatus(); renderVoiceStats(); }
  if (m !== "voice" && state.voice.listening) { voiceMicStop(false); voiceMicTeardown(); }
  if (m !== "listen" && state.listen.status === "recording") stopListenRec();
  if (m !== "speak" && state.speakRec.active) stopSpeakRec();
}

/* ---------------- composer / attachments ---------------- */

function addPendingAudio(b64, name) {
  state.pending.push({ kind: "audio", name, b64 });
  renderPending();
}

async function addPendingFromFile(f) {
  const kind = f.type ? (f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "document") : "document";
  const a = { kind, name: f.name, mime: f.type };
  state.pending.push(a);
  renderPending();
  if (kind === "audio") {
    try { a.b64 = await decodeToPcm16B64(f); a.ready = true; }
    catch (e) { a.error = String(e); }
    renderPending();
    return;
  }
  const r = new FileReader();
  r.onload = () => { a.b64 = String(r.result); a.dataUrl = String(r.result); a.ready = true; renderPending(); };
  r.readAsDataURL(f);
}

function renderPending() {
  const row = $("#attach-row");
  row.innerHTML = state.pending.map((a, i) => `<span class="attach-chip">${esc(a.kind)} · ${esc(a.name)} <button type="button" data-i="${i}">✕</button></span>`).join("");
  row.querySelectorAll("button").forEach((b) => b.onclick = () => { state.pending.splice(+b.dataset.i, 1); renderPending(); });
}

function setComposerText(t) { $("#composer-input").value = t; autosize(); }
function autosize() { const ta = $("#composer-input"); ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px"; }

/* ---------------- voice mode ---------------- */

function renderVoiceStatus() { const el = $("#voice-status"); if (el) el.textContent = state.voice.status; }

function renderVoiceTranscript() {
  const v = state.voice;
  const u = $("#voice-t-user");
  const a = $("#voice-t-assistant");
  if (u) u.textContent = v.userText || "Hold Space and speak.";
  if (a) a.textContent = v.assistantText || "Your conversation will appear here.";
}

function renderVoiceStats(st) {
  const v = state.voice;
  const s2 = st || v.stats;
  if (!s2) return;
  const set = (id, text, title) => { const el = document.getElementById(id); if (!el) return; el.textContent = text; if (title) el.title = title; };
  set("vs-ttft", fmtMs(s2.ttftMs), "time from request to first token");
  set("vs-prefill", s2.prefill != null ? s2.prefill.toFixed(0) + " tok/s" : "—", s2.prompt != null ? "prompt " + fmtK(s2.prompt) + " tokens in " + fmtMs(s2.promptMs) : "prompt processing speed");
  set("vs-tps", s2.tps != null ? s2.tps.toFixed(1) + " tok/s" : "—", "decode speed");
  set("vs-out", s2.out != null ? fmtK(s2.out) + " tok" : "—", "completion tokens");
  set("vs-ctx", s2.ctx != null ? fmtK(s2.ctx) + (state.ctxWindow ? " / " + fmtK(state.ctxWindow) : "") : "—", "prompt + completion tokens / context window");
  set("vs-stt", fmtMs(s2.sttMs), s2.stt ? "transcription: " + fmtK(s2.stt.out) + " tokens" : "speech to text");
  set("vs-tts", s2.ttsMs != null ? fmtMs(s2.ttsMs) + (s2.rtf != null ? " · " + s2.rtf.toFixed(2) + "x" : "") : "—", "text to speech time · real-time factor");
  set("vs-turn", fmtMs(s2.totalMs), "whole turn: stt + llm + tts");
}

function initVoiceWave() {
  const w = $("#voice-wave");
  if (!w || w.dataset.done) return;
  w.dataset.done = "1";
  for (let i = 0; i < 48; i++) {
    const b = document.createElement("div");
    b.className = "wave-bar";
    const h = 6 + Math.random() * 18;
    b.style.height = h + "px";
    w.appendChild(b);
  }
}

function fmtTime2(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

function setupVoicePlayer() {
  initVoiceWave();
  const audio = $("#voice-audio");
  const wrap = $("#voice-out");
  const play = $("#voice-play");
  const seek = $("#voice-seek");
  const time = $("#voice-time");
  const rate = $("#voice-rate");
  const bars = $$(".wave-bar");
  if (!audio) return;
  if (rate) audio.playbackRate = parseFloat(rate.value || "1");
  if (rate) rate.onchange = () => { audio.playbackRate = parseFloat(rate.value); };
  if (play) play.onclick = () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };
  if (seek) {
    seek.oninput = () => {
      if (!audio.duration) return;
      audio.currentTime = (seek.value / 1000) * audio.duration;
    };
  }
  const wave = $("#voice-wave");
  if (wave) {
    wave.style.cursor = "pointer";
    wave.onclick = (e) => {
      if (!audio.duration) return;
      const r = wave.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      audio.currentTime = pct * audio.duration;
    };
  }
  audio.onplay = () => {
    if (wrap) wrap.classList.add("playing");
    if (play) { play.querySelector("span").textContent = "Pause"; }
    if (bars.length) bars.forEach((b, i) => { b.style.animationDelay = (i * 0.02) % 0.4 + "s"; b.classList.add("active"); });
  };
  audio.onpause = () => {
    if (wrap) wrap.classList.remove("playing");
    if (play) { play.querySelector("span").textContent = "Play"; }
    if (bars.length) bars.forEach((b) => b.classList.remove("active"));
  };
  audio.onended = () => {
    if (wrap) wrap.classList.remove("playing");
    if (play) { play.querySelector("span").textContent = "Play"; }
    if (bars.length) bars.forEach((b) => b.classList.remove("active"));
    if (seek) seek.value = 1000;
  };
  audio.ontimeupdate = () => {
    if (!audio.duration || !seek) return;
    seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
    if (time) time.textContent = fmtTime2(audio.currentTime) + " / " + fmtTime2(audio.duration);
    if (bars.length) {
      const prog = audio.currentTime / audio.duration;
      bars.forEach((b, i) => { if (i / bars.length < prog + 0.05) b.classList.add("active"); else b.classList.remove("active"); });
    }
  };
  audio.onloadedmetadata = () => {
    if (time && audio.duration) time.textContent = "0:00 / " + fmtTime2(audio.duration);
  };
}

function voiceBusy() { return ["transcribing", "thinking", "speaking"].includes(state.voice.status); }

function voiceMicStart() {
  const v = state.voice;
  const va = $("#voice-audio");
  const wrap = $("#voice-out");
  const play = $("#voice-play");
  // interrupt any TTS playback so the user can speak over it
  if (va && !va.paused) { try { va.pause(); } catch (e) {} }
  if (wrap) wrap.classList.remove("playing");
  if (play) { play.querySelector("span").textContent = "Play"; }
  if (v.listening) return;
  v.micStartedAt = Date.now();
  v.listening = true;
  v.status = "listening";
  renderVoiceStatus();
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then((stream) => {
    if (!v.listening) { stream.getTracks().forEach((t) => t.stop()); v.status = "ready"; renderVoiceStatus(); return; }
    const mr = new MediaRecorder(stream);
    const chunks = [];
    v.micStream = stream;
    v.recorder = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      v.micStream = null;
      v.recorder = null;
      const held = (Date.now() - v.micStartedAt) / 1000;
      if (v.discard) { v.discard = false; v.status = "ready"; renderVoiceStatus(); return; }
      if (held < 0.25) { v.status = "ready"; renderVoiceStatus(); return; }
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      let wav;
      try { wav = await decodeToPcm16B64(blob); }
      catch (e) { v.status = "could not read recording"; renderVoiceStatus(); return; }
      await voiceTurn(wav, held);
    };
    mr.start();
  }).catch(() => {
    v.status = "microphone unavailable";
    v.listening = false;
    renderVoiceStatus();
  });
}

function voiceMicStop(final) {
  const v = state.voice;
  if (!v.listening) { if (!final) v.discard = true; return; }
  v.listening = false;
  if (!final) v.discard = true;
  if (v.recorder && v.recorder.state !== "inactive") {
    v.recorder.stop();
  } else if (v.micStream) {
    v.micStream.getTracks().forEach((t) => t.stop());
    v.micStream = null;
    v.status = "ready";
    renderVoiceStatus();
  }
}

function voiceMicTeardown() {
  const v = state.voice;
  v.listening = false;
  try { if (v.recorder && v.recorder.state !== "inactive") { v.discard = true; v.recorder.stop(); } } catch (e) {}
  try { if (v.micStream) v.micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  v.micStream = null;
  v.recorder = null;
}

async function voiceTurn(wavB64, held) {
  const v = state.voice;
  const turnStart = performance.now();
  v.stats = { totalMs: null, sttMs: null, ttftMs: null, tps: null, prefill: null, prompt: null, out: null, ctx: null, ttsMs: null, rtf: null };
  v.assistantText = "";
  v.userText = "";
  renderVoiceTranscript();
  renderVoiceStats(v.stats);

  v.status = "transcribing";
  renderVoiceStatus();
  const sttStart = performance.now();
  const tr = await transcribeB64(wavB64);
  v.stats.sttMs = performance.now() - sttStart;
  v.stats.stt = tr.stats || null;
  if (!tr.ok || !tr.text) {
    v.status = "didn't catch that — hold Space and try again";
    renderVoiceStatus();
    return;
  }
  v.userText = tr.text;
  v.history.push({ role: "user", content: tr.text });
  renderVoiceTranscript();
  renderVoiceStats(v.stats);
  updateCtxChip(tr.stats && tr.stats.ctx);

  v.status = "thinking";
  renderVoiceStatus();
  const llmStart = performance.now();
  let firstAt = null;
  let full = "";
  let finalChunk = null;
  const body = {
    model: "lfm3-omni-2b",
    messages: v.history.slice(-12),
    temperature: SETTINGS.temperature,
    max_tokens: SETTINGS.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  try {
    for await (const ev of streamChat(body)) {
      if (ev.error) throw new Error(ev.error);
      const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (d && d.content) {
        if (firstAt == null) firstAt = performance.now();
        full += d.content;
        v.assistantText = full;
        renderVoiceTranscript();
      }
      finalChunk = ev;
    }
  } catch (e) {
    v.status = "error: " + (e && e.message ? e.message : "chat failed");
    renderVoiceStatus();
    return;
  }
  const stats = statsFromChunk(finalChunk || {}, firstAt == null ? null : firstAt - llmStart, performance.now() - llmStart);
  Object.assign(v.stats, stats);
  updateCtxChip(stats.ctx);
  renderVoiceTranscript();
  renderVoiceStats(v.stats);
  if (!full.trim()) { v.status = "ready"; renderVoiceStatus(); return; }
  v.history.push({ role: "assistant", content: full });

  v.status = "speaking";
  renderVoiceStatus();
  await voiceSpeak(full);
  v.stats.totalMs = performance.now() - turnStart;
  renderVoiceStats(v.stats);
  v.status = "ready";
  renderVoiceStatus();
}

async function voiceSpeak(text) {
  const v = state.voice;
  const t0 = performance.now();
  const r = await api("/api/tts", { input: text, lang: "en", voice: v.voice, response_format: "wav" });
  const ms = performance.now() - t0;
  if (!r.ok || !r.data || !r.data.filename) {
    v.stats.ttsMs = ms;
    v.status = "tts error";
    renderVoiceStatus();
    renderVoiceStats(v.stats);
    return;
  }
  v.stats.ttsMs = ms;
  v.stats.audioDur = r.data.duration_s || null;
  v.stats.rtf = r.data.duration_s ? (ms / 1000) / r.data.duration_s : null;
  setupVoicePlayer();
  const url = blobUrlFromB64(r.data.data_b64, "audio/wav");
  const wrap = $("#voice-out");
  const audio = $("#voice-audio");
  const rate = $("#voice-rate");
  if (wrap) wrap.style.display = "block";
  if (audio) {
    audio.src = url;
    if (rate) audio.playbackRate = parseFloat(rate.value || "1");
    audio.currentTime = 0;
    await audio.play().catch(() => {});
  }
  renderVoiceStats(v.stats);
}

function voiceReset() {
  const v = state.voice;
  voiceMicStop(false);
  voiceMicTeardown();
  const wrap = $("#voice-out");
  const audio = $("#voice-audio");
  if (audio) { try { audio.pause(); } catch (e) {} audio.removeAttribute("src"); }
  if (wrap) { wrap.style.display = "none"; wrap.classList.remove("playing"); }
  v.history = [];
  v.userText = "";
  v.assistantText = "";
  v.stats = null;
  v.status = "ready";
  renderVoiceTranscript();
  renderVoiceStatus();
  ["vs-ttft", "vs-prefill", "vs-tps", "vs-out", "vs-ctx", "vs-stt", "vs-tts", "vs-turn"].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = "—"; });
  const play = $("#voice-play"); if (play) play.querySelector("span").textContent = "Play";
  const seek = $("#voice-seek"); if (seek) seek.value = 0;
  const time = $("#voice-time"); if (time) time.textContent = "0:00 / 0:00";
}

/* ---------------- audio helpers ---------------- */

function wavB64ToRawB64(wavB64) {
  return btoa(atob(wavB64).slice(44));
}

async function decodeToPcm16B64(blob) {
  const ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  const len = audio.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < audio.numberOfChannels; c++) { const ch = audio.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += ch[i] / audio.numberOfChannels; }
  const rateIn = audio.sampleRate;
  const rateOut = 16000;
  const nOut = Math.max(1, Math.floor(len * rateOut / rateIn));
  const out = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) { const pos = i * rateIn / rateOut; const i0 = Math.floor(pos); const i1 = Math.min(len - 1, i0 + 1); const f = pos - i0; out[i] = mono[i0] * (1 - f) + mono[i1] * f; }
  const pcm = new Int16Array(nOut);
  for (let i = 0; i < nOut; i++) { const val = Math.max(-1, Math.min(1, out[i])); pcm[i] = val < 0 ? val * 32768 : val * 32767; }
  const bytes = new Uint8Array(nOut * 2);
  for (let i = 0; i < nOut; i++) { const v = pcm[i]; bytes[2 * i] = v & 0xff; bytes[2 * i + 1] = (v >> 8) & 0xff; }
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) { let s = ""; for (let j = 0; j < CH && i + j < bytes.length; j++) s += String.fromCharCode(bytes[i + j]); bin += s; }
  // 44-byte WAV header: PCM16 mono 16kHz
  const header = new ArrayBuffer(44);
  const hb = new Uint8Array(header);
  const dv = new DataView(header);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) hb[off + i] = s.charCodeAt(i); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + bytes.length, true); wstr(8, "WAVE"); wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true); dv.setUint32(28, 16000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); wstr(36, "data"); dv.setUint32(40, bytes.length, true);
  const res = new Uint8Array(44 + bytes.length);
  res.set(new Uint8Array(header), 0); res.set(bytes, 44);
  let binstr = "";
  const CH2 = 0x8000;
  for (let i = 0; i < res.length; i += CH2) { let s = ""; for (let j = 0; j < CH2 && i + j < res.length; j++) s += String.fromCharCode(res[i + j]); binstr += s; }
  return btoa(binstr);
}

/* ---------------- init ---------------- */

/* hidden file inputs used by the composer attach buttons */
["attach-image-input", "attach-audio-input", "attach-video-input", "attach-document-input"].forEach((id) => { const i = document.getElementById(id); if (!i) { const el = document.createElement("input"); el.type = "file"; el.id = id; el.style.display = "none"; document.body.appendChild(el); } });

function bindFileInput(id, handler) {
  const i = document.getElementById(id);
  if (!i) return;
  i.onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) handler(f); e.target.value = ""; };
}

/* ---------------- speech to text helpers ---------------- */

async function transcribeB64(b64, instruction) {
  const r = await api("/api/chat", {
    model: "lfm3-omni-2b",
    messages: [{ role: "user", content: [
      { type: "input_audio", input_audio: { data: b64, format: "wav" } },
      { type: "text", text: instruction || "Transcribe the speech verbatim. Reply with only the transcript, without commentary or quotation marks." },
    ] }],
    temperature: 0,
    max_tokens: 32768,
    stream: false,
  }, 300);
  const txt = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content) || "";
  return { ok: r.ok, text: String(txt).trim().replace(/^["'“]|["'”]$/g, ""), stats: r.ok ? statsFromChunk(r.data, null, null) : null };
}

function startSpeakRec() {
  const s = state.speakRec;
  if (s.active) return;
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
    const mr = new MediaRecorder(stream);
    s.chunks = [];
    s.active = true;
    s.recorder = mr;
    $("#btn-tts-mic").classList.add("on");
    $("#tts-mic-status").textContent = "Recording… press Dictate again (or release Space) to stop.";
    mr.ondataavailable = (e) => { if (e.data && e.data.size) s.chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      s.active = false;
      s.recorder = null;
      $("#btn-tts-mic").classList.remove("on");
      const blob = new Blob(s.chunks, { type: mr.mimeType || "audio/webm" });
      s.chunks = [];
      $("#tts-mic-status").textContent = "Transcribing…";
      let b64;
      try { b64 = await decodeToPcm16B64(blob); }
      catch (e) { $("#tts-mic-status").textContent = "Could not decode the recording."; return; }
      const tr = await transcribeB64(b64);
      if (!tr.ok || !tr.text) { $("#tts-mic-status").textContent = "Transcription failed."; return; }
      $("#tts-input").value = tr.text;
      $("#tts-mic-status").textContent = "Transcript ready — generating audio…";
      state.tts.text = tr.text;
      state.tts.status = "generating";
      renderSpeakState();
      await speakText(tr.text, $("#tts-lang").value, $("#tts-voice").value);
      $("#tts-mic-status").textContent = "Transcript ready. Edit it and generate again if you like.";
    };
    mr.start();
  }).catch(() => { $("#tts-mic-status").textContent = "Microphone unavailable."; });
}

function stopSpeakRec() {
  const s = state.speakRec;
  if (s.active && s.recorder) s.recorder.stop();
}

async function startListenRec() {
  const l = state.listen;
  if (l.status === "recording") return;
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
    const mr = new MediaRecorder(stream);
    l.chunks = [];
    l.recorder = mr;
    l.status = "recording";
    renderListenState();
    $("#btn-listen-record").classList.add("on");
    mr.ondataavailable = (e) => { if (e.data && e.data.size) l.chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      l.recorder = null;
      $("#btn-listen-record").classList.remove("on");
      const blob = new Blob(l.chunks, { type: mr.mimeType || "audio/webm" });
      l.chunks = [];
      l.status = "decoding";
      renderListenState();
      try { l.b64 = await decodeToPcm16B64(blob); }
      catch (e) { l.status = "error"; renderListenState(); return; }
      l.status = "ready";
      renderListenState();
      transcribeListen();
    };
    mr.start();
  }).catch(() => { l.status = "microphone unavailable"; renderListenState(); });
}

function stopListenRec() {
  const l = state.listen;
  if (l.recorder) l.recorder.stop();
}

async function transcribeListen() {
  const l = state.listen;
  if (!l.b64) return;
  l.status = "transcribing";
  renderListenState();
  const tr = await transcribeB64(l.b64, "Transcribe the speech verbatim. Reply with only the transcript, without commentary or quotation marks.");
  if (!tr.ok || !tr.text) { l.status = "error"; renderListenState(); return; }
  l.transcript = tr.text;
  l.status = "done";
  $("#listen-transcript").textContent = tr.text;
  renderListenState();
}

function askAboutListen() {
  const l = state.listen;
  if (!l.transcript) return;
  const q = "Here is a transcript of an audio clip:\n\n" + l.transcript + "\n\nAnswer or explain what the speaker is asking or saying. Keep it brief.";
  setMode("chat");
  setComposerText(q);
  $("#composer-input").focus();
}

/* ---------------- mobile sidebar / settings ---------------- */

function setSidebar(open) {
  const s = $("#sidebar");
  const d = $("#sidebar-backdrop");
  const b = $("#btn-menu-mobile");
  if (!s) return;
  s.classList.toggle("open", !!open);
  if (d) d.classList.toggle("open", !!open);
  if (b) {
    b.setAttribute("aria-expanded", open ? "true" : "false");
    b.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
}

function closeSidebar() { setSidebar(false); }

function openSettings() {
  closeSidebar();
  const overlay = $("#drawer-overlay");
  const drawer = $("#drawer");
  if (overlay) overlay.style.display = "block";
  if (drawer) drawer.style.display = "block";
}

function closeSettings() {
  const overlay = $("#drawer-overlay");
  const drawer = $("#drawer");
  if (overlay) overlay.style.display = "none";
  if (drawer) drawer.style.display = "none";
}

function wire() {
  $$("#nav .nav-btn").forEach((b) => b.addEventListener("click", () => { setMode(b.dataset.mode); closeSidebar(); }));

  const btnMenu = $("#btn-menu-mobile");
  if (btnMenu) btnMenu.addEventListener("click", () => setSidebar(!$("#sidebar").classList.contains("open")));
  const bd = $("#sidebar-backdrop"); if (bd) bd.addEventListener("click", closeSidebar);
  const sbClose = $("#sidebar-close"); if (sbClose) sbClose.addEventListener("click", closeSidebar);

  const btnNew = $("#btn-new-chat"); if (btnNew) btnNew.addEventListener("click", () => { newChat(); closeSidebar(); });

  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.goto;
    setMode(m);
    closeSidebar();
    if (m === "chat") setTimeout(() => { const ci = $("#composer-input"); if (ci) ci.focus(); }, 40);
  }));

  const sendBtn = $("#btn-send"); if (sendBtn) sendBtn.addEventListener("click", sendChat);
  const ci = $("#composer-input"); if (ci) ci.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $("#btn-attach-image").addEventListener("click", () => document.getElementById("attach-image-input").click());
  $("#btn-attach-audio").addEventListener("click", () => document.getElementById("attach-audio-input").click());
  $("#btn-attach-video").addEventListener("click", () => document.getElementById("attach-video-input").click());
  $("#btn-attach-document").addEventListener("click", () => document.getElementById("attach-document-input").click());
  document.getElementById("attach-image-input").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) addPendingFromFile(f); });
  document.getElementById("attach-audio-input").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) addPendingFromFile(f); });
  document.getElementById("attach-video-input").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) addPendingFromFile(f); });
  document.getElementById("attach-document-input").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) addPendingFromFile(f); });

  $("#btn-mic").addEventListener("click", async () => {
    if (state.pendingMic) { try { state.pendingMic.stop(); } catch (e) {} state.pendingMic = null; $("#btn-mic").classList.remove("on"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        const b64 = await decodeToPcm16B64(blob);
        addPendingAudio(b64, "recording.wav");
        $("#btn-mic").classList.remove("on");
      };
      state.pendingMic = mr;
      mr.start();
      $("#btn-mic").classList.add("on");
    } catch (e) { alert("microphone unavailable: " + e); }
  });

  $("#thread-inner").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const m = state.messages.find((x) => x.id === act.dataset.mid);
    if (!m) return;
    if (act.dataset.act === "speak") { speakInChat(act.dataset.mid); }
    if (act.dataset.act === "chat-play") { playChatAudio(act.dataset.mid); }
    if (act.dataset.act === "copy") { navigator.clipboard.writeText(msgText(m) || ""); act.textContent = "copied"; setTimeout(()=>{act.textContent="copy";},1200); }
    if (act.dataset.act === "regen") regenerate();
  });

  $("#thread-inner").addEventListener("click", (e) => {
    const cb = e.target.closest(".code-copy");
    if (cb) {
      const pre = cb.closest(".code-wrap").querySelector("pre code");
      if (pre) { navigator.clipboard.writeText(pre.textContent); cb.textContent = "✓"; setTimeout(()=>{cb.textContent="⧉";},1200); }
    }
  });

  $("#btn-tts-generate").addEventListener("click", async () => {
    const text = $("#tts-input").value.trim();
    if (!text) return;
    state.tts.text = text;
    state.tts.status = "generating";
    renderSpeakState();
    await speakText(text, $("#tts-lang").value, $("#tts-voice").value);
  });

  $("#btn-tts-mic").addEventListener("click", () => {
    if (state.speakRec.active) stopSpeakRec();
    else startSpeakRec();
  });

  $("#btn-listen-record").addEventListener("click", () => {
    if (state.listen.status === "recording") stopListenRec();
    else startListenRec();
  });

  $("#btn-listen-transcribe").addEventListener("click", () => transcribeListen());
  $("#btn-listen-answer").addEventListener("click", () => askAboutListen());

  bindFileInput("look-file", (f) => {
    const r = new FileReader();
    r.onload = () => { state.look.image = String(r.result); };
    r.readAsDataURL(f);
  });

  bindFileInput("listen-file", async (f) => {
    state.listen.status = "decoding";
    state.listen.transcript = "";
    $("#listen-transcript").textContent = "";
    renderListenState();
    try {
      state.listen.b64 = await decodeToPcm16B64(f);
      state.listen.status = "ready";
    } catch (e) {
      state.listen.status = "error";
      renderListenState();
      return;
    }
    renderListenState();
    transcribeListen();
  });

  $("#tts-download").addEventListener("click", () => {
    if (!state.tts.last) return;
    const a = document.createElement("a");
    a.href = blobUrlFromB64(state.tts.last.data_b64, "audio/wav");
    a.download = state.tts.last.filename || "speech.wav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  $("#btn-look-run").addEventListener("click", async () => {
    const img = state.look.image;
    const q = ($("#look-q").value || "Describe this image.").trim();
    if (!img) { return; }
    state.look.busy = true;
    state.look.answer = "";
    $("#look-answer").textContent = "thinking…";
    const r = await api("/api/chat", { model: "lfm3-omni-2b", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: img } }, { type: "text", text: q }] }], temperature: SETTINGS.temperature, max_tokens: SETTINGS.maxTokens, stream: false });
    state.look.busy = false;
    const txt = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content) || "";
    state.look.answer = txt;
    $("#look-answer").textContent = txt;
    $("#look-result").style.display = "block";
  });

  $("#btn-voice-mic").addEventListener("pointerdown", (e) => { e.preventDefault(); voiceMicStart(); });
  $("#btn-voice-mic").addEventListener("pointerup", (e) => { e.preventDefault(); voiceMicStop(true); });
  $("#btn-voice-mic").addEventListener("pointerleave", () => { if (state.voice.listening) voiceMicStop(false); });
  $("#btn-voice-end").addEventListener("click", () => voiceReset());

  const voicePick = $("#voice-voice");
  if (voicePick) {
    voicePick.value = state.voice.voice;
    voicePick.addEventListener("change", () => {
      state.voice.voice = voicePick.value;
      SETTINGS.voice = voicePick.value;
      state.tts.voice = voicePick.value;
      const sv = $("#set-voice"); if (sv) sv.value = voicePick.value;
      const tv = $("#tts-voice"); if (tv) tv.value = voicePick.value;
    });
  }

  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("lfm3-theme", next); } catch (e) {}
  });

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (state.mode === "voice") {
      e.preventDefault();
      state.voice.ptt = true;
      voiceMicStart();
    } else if (state.mode === "listen") {
      e.preventDefault();
      state.listen.space = true;
      startListenRec();
    } else if (state.mode === "speak") {
      e.preventDefault();
      state.speakRec.space = true;
      startSpeakRec();
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    if (state.mode === "voice" && state.voice.ptt) {
      state.voice.ptt = false;
      voiceMicStop(true);
    } else if (state.mode === "listen" && state.listen.space) {
      state.listen.space = false;
      stopListenRec();
    } else if (state.mode === "speak" && state.speakRec.space) {
      state.speakRec.space = false;
      stopSpeakRec();
    }
  });

  $("#status-chip").addEventListener("click", () => setMode("chat"));

  $("#settings-open").addEventListener("click", openSettings);
  $("#settings-open-top").addEventListener("click", openSettings);
  $("#drawer-overlay").addEventListener("click", closeSettings);
  $("#drawer-close").addEventListener("click", closeSettings);
  $("#btn-save-settings").addEventListener("click", () => {
    SETTINGS.serverUrl = $("#set-url").value;
    SETTINGS.temperature = parseFloat($("#set-temp").value) || 0;
    SETTINGS.maxTokens = parseInt($("#set-max").value) || 32768;
    SETTINGS.instructions = $("#set-instr").value;
    const vv = $("#set-voice");
    if (vv) {
      SETTINGS.voice = vv.value;
      state.voice.voice = vv.value;
      state.tts.voice = vv.value;
      const vp = $("#voice-voice"); if (vp) vp.value = vv.value;
      const tv = $("#tts-voice"); if (tv) tv.value = vv.value;
    }
    state.serverUrl = SETTINGS.serverUrl;
    state.voice.instructions = SETTINGS.instructions;
    $("#st-addr").textContent = SETTINGS.serverUrl.replace(/^https?:\/\//, "");
    closeSettings();
  });

  document.addEventListener("dragover", (e) => { e.preventDefault(); $("#drop-overlay").style.display = "grid"; });
  document.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) $("#drop-overlay").style.display = "none"; });
  document.addEventListener("drop", (e) => { e.preventDefault(); $("#drop-overlay").style.display = "none"; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) addPendingFromFile(f); });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeSidebar();
    closeSettings();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) closeSidebar();
  });
}

function renderListenState() {
  const l = state.listen;
  $("#listen-status").textContent = l.status;
  $("#listen-result").style.display = (l.transcript && l.status === "done") ? "block" : "none";
  const lbl = $("#btn-listen-record span");
  if (lbl) lbl.textContent = l.status === "recording" ? "Stop recording" : "Hold to record";
  $("#btn-listen-record").classList.toggle("recording", l.status === "recording");
}

function renderLook() { $("#look-result").style.display = state.look.answer ? "block" : "none"; }

document.addEventListener("DOMContentLoaded", async () => {
["attach-image-input", "attach-audio-input", "attach-video-input", "attach-document-input"].forEach((id) => { const i = document.getElementById(id); if (!i) { const el = document.createElement("input"); el.type = "file"; el.id = id; el.style.display = "none"; document.body.appendChild(el); } });
  wire();
  loadProps();
  await refreshHealth();
  await listChats();
  pollHealth();
  setMode("chat");
});
