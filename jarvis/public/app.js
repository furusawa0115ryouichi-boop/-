'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  log: $('log'), input: $('input'), form: $('form'), mic: $('micBtn'), stop: $('stopBtn'),
  activity: $('activity'), status: $('statusText'), reactor: $('reactorLabel'),
  speak: $('tSpeak'), auto: $('tAuto'), hands: $('tHands'),
  voice: $('voiceSelect'), rate: $('rate'), rateVal: $('rateVal'),
};

const app = {
  mode: 'standby',
  busy: false,
  tasks: 0,
  tools: 0,
  cost: 0,
  abort: null,
};

// ── 設定の保存（このブラウザだけ） ─────────────────
const prefs = (() => { try { return JSON.parse(localStorage.getItem('jarvis-prefs') || '{}'); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('jarvis-prefs', JSON.stringify(prefs)); } catch {} };
for (const [key, el] of [['speak', els.speak], ['auto', els.auto], ['hands', els.hands]]) {
  if (key in prefs) el.checked = prefs[key];
  el.addEventListener('change', () => { prefs[key] = el.checked; savePrefs(); if (key === 'speak' && !el.checked) stopSpeaking(); });
}
if (prefs.rate) els.rate.value = prefs.rate;
els.rateVal.textContent = els.rate.value;
els.rate.addEventListener('input', () => { els.rateVal.textContent = els.rate.value; prefs.rate = els.rate.value; savePrefs(); });

// ── 状態表示 ─────────────────────────────────
const LABELS = { standby: 'STANDBY', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING' };
function setMode(mode) {
  app.mode = mode;
  document.body.dataset.mode = mode;
  els.status.textContent = LABELS[mode];
  els.reactor.textContent = LABELS[mode];
}
function refreshMode() {
  if (rec.active) setMode('listening');
  else if (app.busy) setMode('thinking');
  else if (tts.active) setMode('speaking');
  else setMode('standby');
}

// ── 時計 ────────────────────────────────────
function tick() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  $('clock').textContent = t;
  $('clockTop').textContent = t;
  $('date').textContent = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
setInterval(tick, 1000); tick();

async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('kvUser').textContent = s.user;
    $('kvModel').textContent = s.model;
    $('kvPerm').textContent = s.permissionMode;
    $('kvCwd').textContent = s.cwd; $('kvCwd').title = s.cwd;
    $('kvSession').textContent = s.session ? s.session.slice(0, 8) : 'NEW';
  } catch {
    addMsg('err', 'サーバーに接続できません。`node server.js` が起動しているか確認してください。');
  }
}
loadStatus();

// ── 会話ログ ─────────────────────────────────
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderMd(text) {
  const parts = text.split(/```[\w-]*\n?([\s\S]*?)(?:```|$)/g);
  return parts.map((part, i) => {
    if (i % 2) return `<pre>${esc(part)}</pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6}\s*(.+)$/gm, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }).join('');
}
function addMsg(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  const body = document.createElement('div');
  body.className = 'body';
  if (kind === 'ai') body.innerHTML = renderMd(text); else body.textContent = text;
  div.appendChild(body);
  els.log.appendChild(div);
  scrollLog();
  return div;
}
function scrollLog() { els.log.scrollTop = els.log.scrollHeight; }

// ── アクティビティ ──────────────────────────
const toolItems = new Map();
function addActivity(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  els.activity.prepend(li);
  while (els.activity.children.length > 200) els.activity.lastChild.remove();
  return li;
}
const now = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });

// ── 音声読み上げ ─────────────────────────────
const tts = { active: false, queue: 0, voices: [] };
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const all = speechSynthesis.getVoices();
  tts.voices = all.filter((v) => /^ja/i.test(v.lang));
  if (!tts.voices.length) tts.voices = all;
  els.voice.innerHTML = tts.voices.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('');
  // 好みの声を記憶、なければ自然な日本語音声を優先
  let idx = tts.voices.findIndex((v) => v.name === prefs.voice);
  if (idx < 0) idx = tts.voices.findIndex((v) => /Google|Otoya|Hattori|Keita|Natural|Online/i.test(v.name));
  els.voice.value = String(Math.max(0, idx));
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
els.voice.addEventListener('change', () => { prefs.voice = tts.voices[els.voice.value]?.name; savePrefs(); });

function toSpeech(text) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '。コードは画面に表示しています。')
    .replace(/https?:\/\/\S+/g, 'リンク')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/[*_|>#]/g, '')
    .replace(/\n{2,}/g, '。\n')
    .trim();
}
function speak(text, onDone) {
  if (!els.speak.checked || !('speechSynthesis' in window)) return onDone && onDone();
  const clean = toSpeech(text);
  // Chrome は長い文を途中で打ち切るので文ごとに区切って順番に読む
  const chunks = clean.match(/[^。！？!?\n]+[。！？!?\n]*/g) || [];
  if (!chunks.length) return onDone && onDone();
  speechSynthesis.cancel();
  tts.active = true; tts.queue = chunks.length;
  refreshMode();
  const voice = tts.voices[els.voice.value];
  for (const c of chunks) {
    const u = new SpeechSynthesisUtterance(c.trim());
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'ja-JP';
    u.rate = Number(els.rate.value);
    u.onend = u.onerror = () => {
      if (--tts.queue <= 0 && tts.active) { tts.active = false; refreshMode(); onDone && onDone(); }
    };
    speechSynthesis.speak(u);
  }
}
function stopSpeaking() {
  if (!('speechSynthesis' in window)) return;
  tts.active = false; tts.queue = 0;
  speechSynthesis.cancel();
  refreshMode();
}

// ── 音声認識 ─────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = { active: false, engine: null, finalText: '' };
if (SR) {
  const r = new SR();
  r.lang = 'ja-JP';
  r.interimResults = true;
  r.continuous = false;
  r.onresult = (e) => {
    let interim = '', final = '';
    for (const res of e.results) (res.isFinal ? (final += res[0].transcript) : (interim += res[0].transcript));
    rec.finalText = final;
    els.input.value = final + interim;
    autoGrow();
  };
  r.onend = () => {
    rec.active = false;
    refreshMode();
    const text = rec.finalText.trim();
    rec.finalText = '';
    if (text && els.auto.checked) submit();
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed') addMsg('err', 'マイクの使用が許可されていません。ブラウザのアドレスバーから許可してください。');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') addMsg('err', `音声認識エラー: ${e.error}`);
  };
  rec.engine = r;
} else {
  els.mic.title = 'このブラウザは音声入力に対応していません（Chrome / Edge 推奨）';
  els.mic.style.opacity = .35;
}
function startListening() {
  if (!rec.engine || rec.active || app.busy) return;
  stopSpeaking();
  els.input.value = '';
  rec.finalText = '';
  try { rec.engine.start(); rec.active = true; refreshMode(); } catch {}
}
function stopListening() { if (rec.engine && rec.active) rec.engine.stop(); }
els.mic.addEventListener('click', () => (rec.active ? stopListening() : startListening()));

// ── 送信 ────────────────────────────────────
async function submit() {
  const message = els.input.value.trim();
  if (!message || app.busy) return;
  els.input.value = ''; autoGrow();
  stopSpeaking();
  addMsg('user', message);
  const aiDiv = addMsg('ai', '');
  aiDiv.classList.add('pending');
  const body = aiDiv.querySelector('.body');

  app.busy = true; refreshMode();
  app.tasks++; $('mTasks').textContent = app.tasks;
  addActivity(`<span class="time">${now()}</span>TASK #${app.tasks}<span class="sum">${esc(message.slice(0, 60))}</span>`, 'task');

  let text = '';      // 画面に流れる全文
  let lastTurn = '';  // 最後の発言（読み上げ用）
  let finalResult = null;
  const started = performance.now();
  const ctrl = new AbortController();
  app.abort = ctrl;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        switch (ev.t) {
          case 'init':
            if (ev.model) $('kvModel').textContent = ev.model;
            if (ev.session) $('kvSession').textContent = ev.session.slice(0, 8);
            break;
          case 'turn':
            if (lastTurn) { text += '\n\n'; }
            lastTurn = '';
            break;
          case 'text':
            text += ev.d; lastTurn += ev.d;
            body.innerHTML = renderMd(text);
            scrollLog();
            break;
          case 'tool': {
            app.tools++; $('mTools').textContent = app.tools;
            const li = addActivity(`<span class="time">${now()}</span><span class="name">${esc(ev.name)}</span><span class="sum">${esc(ev.summary || '')}</span>`, ev.sub ? 'sub' : '');
            toolItems.set(ev.id, li);
            break;
          }
          case 'tool_done': {
            const li = toolItems.get(ev.id);
            if (li) { li.classList.add(ev.error ? 'ng' : 'ok'); toolItems.delete(ev.id); }
            break;
          }
          case 'done':
            finalResult = ev;
            break;
          case 'error':
            addMsg('err', ev.msg);
            break;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') addMsg('err', `通信エラー: ${err.message}`);
  }

  aiDiv.classList.remove('pending');
  for (const li of toolItems.values()) li.classList.add('ng');
  toolItems.clear();
  app.busy = false; app.abort = null;

  if (finalResult) {
    if (!text && finalResult.result) body.innerHTML = renderMd(finalResult.result);
    const sec = ((finalResult.ms || performance.now() - started) / 1000).toFixed(1);
    $('mTime').textContent = `${sec}s`;
    if (typeof finalResult.cost === 'number') { app.cost += finalResult.cost; $('mCost').textContent = app.cost.toFixed(4); }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${sec}s · ${finalResult.turns ?? '-'} turns` +
      (finalResult.denied && finalResult.denied.length ? ` · 許可されなかった操作: ${[...new Set(finalResult.denied)].join(', ')}` : '');
    aiDiv.appendChild(meta);
    scrollLog();
  } else if (!text) {
    aiDiv.remove();
  }
  refreshMode();

  const say = finalResult ? (finalResult.result || lastTurn || text) : '';
  speak(say, () => { if (els.hands.checked) startListening(); });
  if (!say && els.hands.checked && finalResult) startListening();
}

async function stopAll() {
  stopListening();
  stopSpeaking();
  if (app.busy) {
    await fetch('/api/stop', { method: 'POST' }).catch(() => {});
    addActivity(`<span class="time">${now()}</span>STOP 要求`, 'task');
  }
}

els.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
els.stop.addEventListener('click', stopAll);
$('resetBtn').addEventListener('click', async () => {
  if (!confirm('会話の記憶をリセットして新しいセッションを始めますか？')) return;
  await fetch('/api/reset', { method: 'POST' });
  els.log.innerHTML = '';
  addMsg('sys', '新しいセッションを開始しました。');
  loadStatus();
});

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}
els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stopAll();
  if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); rec.active ? stopListening() : startListening(); }
});
