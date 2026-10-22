#!/usr/bin/env node
// JARVIS — Claude Code と音声で会話しながら仕事を進めるための HUD サーバー。
// 依存パッケージなし。ローカルにインストール済みの `claude` CLI を呼び出す。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.JARVIS_PORT || 7777);
const HOST = process.env.JARVIS_HOST || '127.0.0.1';
const WORKDIR = path.resolve(process.env.JARVIS_WORKDIR || process.cwd());
const CLAUDE_BIN = process.env.JARVIS_CLAUDE_BIN || 'claude';
// default: 確認なしで読む・編集する。コマンド実行などは許可ルールに従う。
// bypassPermissions にすると全部確認なしで実行する（自己責任で）。
const PERMISSION_MODE = process.env.JARVIS_PERMISSION_MODE || 'acceptEdits';
const MODEL = process.env.JARVIS_MODEL || '';
const USER_NAME = process.env.JARVIS_USER_NAME || 'ボス';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.jarvis-state.json');
const PROMPT_FILE = path.join(__dirname, '.jarvis-system-prompt.txt');
const IS_WIN = process.platform === 'win32';

const SYSTEM_PROMPT = `
あなたは「JARVIS」。${USER_NAME}に仕える、極めて優秀で落ち着いた部下（AIアシスタント）です。
${USER_NAME}とは音声で会話しています。返答はそのまま音声で読み上げられます。

話し方:
- ${USER_NAME}のことは「${USER_NAME}」と呼ぶ。丁寧だが堅すぎず、自信のある口調で。ときどき軽いウィットを効かせてよい。
- 最初に結論。そのあと要点を2〜4文で。長い一覧・表・コードは返答に貼らず「ファイルに保存しました」のように要約して報告する。
- Markdown記号（#, *, |, \`\`\`）や URL の羅列は読み上げにくいので最小限に。

仕事の進め方:
- 指示を受けたら、自分で調べて手を動かし、終わったら「何をしたか・結果・次の提案」を簡潔に報告する。
- 指示があいまいでも、妥当な解釈で進められるなら進め、どう解釈したかを一言添える。本当に判断が必要なときだけ質問する。
- ファイル削除、git push、外部への送信、お金がかかる操作など取り返しのつかない操作は、実行前に必ず${USER_NAME}に確認する。
`.trim();

// 日本語や改行を含むプロンプトはコマンドライン引数だと Windows で崩れるのでファイル経由で渡す
// claude を起動するたびにこのファイルが読まれるので、書き換えれば次の指示から反映される
let rules = { text: '', syncedAt: null, error: null };
function writePrompt() {
  const text = rules.text
    ? `${SYSTEM_PROMPT}\n\n以下は${USER_NAME}と決めた作業ルール（リポジトリの CLAUDE.md）。必ず従うこと。\n\n${rules.text}`
    : SYSTEM_PROMPT;
  fs.writeFileSync(PROMPT_FILE, text, 'utf8');
}
writePrompt();

// クラウドの Claude で保存したルール（GitHub の main ブランチの CLAUDE.md）を定期的に取り込む。
// 作業ツリーには触らず、fetch した main から CLAUDE.md だけを読む
const RULES_BRANCH = process.env.JARVIS_RULES_BRANCH || 'main';
const RULES_SYNC_MIN = Number(process.env.JARVIS_RULES_SYNC_MIN || 60);
function syncRules() {
  const opts = { cwd: __dirname, windowsHide: true, timeout: 60000 };
  execFile('git', ['fetch', '-q', 'origin', RULES_BRANCH], opts, (fetchErr) => {
    execFile('git', ['show', `origin/${RULES_BRANCH}:CLAUDE.md`], { ...opts, maxBuffer: 1e6 }, (err, out) => {
      if (err || !out.trim()) {
        rules.error = (fetchErr || err || new Error('CLAUDE.md が空です')).message.trim().split('\n')[0];
        console.warn(`[rules] ルールを取り込めませんでした: ${rules.error}`);
        return;
      }
      rules = { text: out.trim(), syncedAt: new Date().toISOString(), error: fetchErr ? 'fetch に失敗（前回取得分を使用）' : null };
      writePrompt();
      console.log(`[rules] ルールを取り込みました (${new Date().toLocaleString('ja-JP')})`);
    });
  });
}
syncRules();
if (RULES_SYNC_MIN > 0) setInterval(syncRules, RULES_SYNC_MIN * 60 * 1000).unref();

let state = { sessionId: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };

let current = null; // 実行中の claude プロセス

function stopCurrent() {
  if (!current) return;
  current.stopped = true;
  // Windows ではシェルごと子プロセスを止める
  if (IS_WIN) execFile('taskkill', ['/pid', String(current.pid), '/T', '/F'], () => {});
  else current.kill('SIGINT');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ツール呼び出しを HUD のアクティビティ表示用に一行へ要約する
function summarizeTool(name, input = {}) {
  const short = (s, n = 80) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const rel = (p) => (p ? path.relative(WORKDIR, p) || p : '');
  switch (name) {
    case 'Bash': return short(input.description || input.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return rel(input.file_path || input.notebook_path);
    case 'Glob': case 'Grep': return short(input.pattern);
    case 'WebFetch': return short(input.url);
    case 'WebSearch': return short(input.query);
    case 'Task': case 'Agent': return short(input.description);
    case 'TodoWrite': return `${(input.todos || []).length} 件のタスク`;
    default: return short(JSON.stringify(input), 60);
  }
}

async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad json' }); }
  const message = String(body.message || '').trim();
  if (!message) return json(res, 400, { error: 'empty message' });
  if (current) return json(res, 409, { error: '前の指示を実行中です' });

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', PROMPT_FILE,
    '--permission-mode', PERMISSION_MODE,
  ];
  if (MODEL) args.push('--model', MODEL);
  if (state.sessionId) args.push('--resume', state.sessionId);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  // Windows の claude は .cmd なのでシェル経由で起動する。指示文は stdin で渡す
  const child = IS_WIN
    ? spawn([CLAUDE_BIN, ...args].map((a) => `"${a}"`).join(' '), { cwd: WORKDIR, env: process.env, shell: true, windowsHide: true })
    : spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env: process.env });
  child.stdin.on('error', () => {});
  child.stdin.end(message);
  current = child;
  let buf = '';
  let stderr = '';
  let gotResult = false;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      handleEvent(ev);
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

  function handleEvent(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          send({ t: 'init', session: ev.session_id, model: ev.model, cwd: ev.cwd, tools: (ev.tools || []).length });
        }
        break;
      case 'stream_event': {
        const e = ev.event || {};
        if (ev.parent_tool_use_id) break; // サブエージェントの途中経過は流さない
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          send({ t: 'text', d: e.delta.text });
        } else if (e.type === 'message_start') {
          send({ t: 'turn' });
        }
        break;
      }
      case 'assistant':
        for (const block of (ev.message && ev.message.content) || []) {
          if (block.type === 'tool_use') {
            send({ t: 'tool', id: block.id, name: block.name, summary: summarizeTool(block.name, block.input), sub: !!ev.parent_tool_use_id });
          }
        }
        break;
      case 'user':
        for (const block of (ev.message && ev.message.content) || []) {
          if (block.type === 'tool_result') send({ t: 'tool_done', id: block.tool_use_id, error: !!block.is_error });
        }
        break;
      case 'result':
        gotResult = true;
        if (ev.session_id) { state.sessionId = ev.session_id; saveState(); }
        send({
          t: 'done',
          ok: !ev.is_error,
          result: ev.result || '',
          cost: ev.total_cost_usd,
          ms: ev.duration_ms,
          turns: ev.num_turns,
          session: ev.session_id,
          denied: (ev.permission_denials || []).map((d) => d.tool_name),
        });
        break;
    }
  }

  child.on('error', (err) => {
    send({ t: 'error', msg: `claude を起動できません: ${err.message}（Claude Code はインストール済みですか？）` });
  });
  child.on('close', (code, signal) => {
    current = null;
    if (signal || child.stopped) send({ t: 'error', msg: '中断しました' });
    else if (!gotResult) {
      // 古いセッションが消えている場合は次回まっさらに始める
      if (/No conversation found/i.test(stderr)) { state.sessionId = null; saveState(); }
      send({ t: 'error', msg: (stderr.trim() || `claude が終了しました (code ${code})`).slice(-600) });
    }
    res.end();
  });
  // ブラウザが切断しても作業は最後まで続ける（止めたいときは /api/stop）
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  // 別サイトからこのサーバーを叩かれないよう、API は同一オリジンのみ許可
  if (pathname.startsWith('/api/') && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'forbidden origin' });
  }
  if (req.method === 'POST' && pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && pathname === '/api/stop') {
    stopCurrent();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/reset') {
    stopCurrent();
    state.sessionId = null; saveState();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    return json(res, 200, {
      session: state.sessionId, busy: !!current, cwd: WORKDIR,
      permissionMode: PERMISSION_MODE, model: MODEL || 'default', user: USER_NAME,
      rulesSyncedAt: rules.syncedAt, rulesError: rules.error,
    });
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`
  J.A.R.V.I.S. online
  ─────────────────────────────────────────
  URL        : http://localhost:${PORT}
  作業フォルダ : ${WORKDIR}
  権限モード   : ${PERMISSION_MODE}
  ルール同期   : ${RULES_SYNC_MIN > 0 ? `${RULES_SYNC_MIN} 分ごと（origin/${RULES_BRANCH} の CLAUDE.md）` : 'オフ'}
  ─────────────────────────────────────────
  ブラウザ（Chrome / Edge 推奨）で上の URL を開いてください。
`);
});
