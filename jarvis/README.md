# J.A.R.V.I.S. — Claude Code 音声秘書

アイアンマンの JARVIS みたいな画面で、**Claude Code に話しかけて仕事を進める**ためのツールです。
話しかける → Claude Code が実際にファイルを読んだり、作ったり、コマンドを実行したりする → 結果を声で報告してくれます。

- 🎙 **音声で指示**（マイクボタン or `Ctrl + /`）。話し終えると自動で送信
- 🔊 **返事を音声で読み上げ**（声・速さを選べる）
- 🔁 **会話モード**：返事が終わると自動で聞き取りを再開。キーボードに触らずに会話を続けられる
- 🧠 **会話を覚えている**：前の話の続きで「さっきのやつ直して」が通じる（`NEW SESSION` でリセット）
- 📡 **ACTIVITY パネル**：JARVIS が今どのファイルを読んで、何のコマンドを打っているかがリアルタイムで見える
- ⏹ **STOP（Esc）** でいつでも中断
- 優秀な部下として振る舞う設定済み：結論から短く報告、削除や push などは実行前に確認

## 必要なもの

1. **Node.js 18 以上** — https://nodejs.org
2. **Claude Code**（ログイン済み） — ターミナルで `claude` が動けば OK
   ```
   npm install -g @anthropic-ai/claude-code
   claude   # 初回はログイン
   ```
3. **Google Chrome または Microsoft Edge**（音声入力のため）

追加の npm パッケージや API キーは不要です。Claude Code のログインをそのまま使います。

## 起動

```bash
cd jarvis
JARVIS_WORKDIR=~/Documents/仕事 node server.js
```

ブラウザで **http://localhost:7777** を開き、マイクの使用を許可すれば準備完了です。

- **Windows**: `start-windows.bat` をダブルクリック。ブラウザも自動で開きます（作業フォルダは既定で「ドキュメント」。変えたいときは bat をメモ帳で開いて `JARVIS_WORKDIR` の行を書き換え）。
- **Mac**: `start-mac.command` をダブルクリック（作業フォルダは中の `JARVIS_WORKDIR` を書き換えてください）。

Windows で Claude Code を使うには [Git for Windows](https://git-scm.com/downloads/win) も必要です。

## 話しかけ方の例

- 「このフォルダに何があるか教えて」
- 「施工図管理のHTMLを開いて、検索機能を追加して」
- 「昨日作った見積もりの合計金額を確認して」
- 「さっきの修正、もう少しボタンを大きくして」

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `JARVIS_WORKDIR` | 起動したフォルダ | JARVIS が作業するフォルダ |
| `JARVIS_USER_NAME` | `ボス` | JARVIS からの呼ばれ方（例: `社長`、`古澤さん`） |
| `JARVIS_PERMISSION_MODE` | `acceptEdits` | Claude Code の権限モード（下記） |
| `JARVIS_MODEL` | Claude Code の既定 | 使うモデル（例: `opus`, `sonnet`） |
| `JARVIS_PORT` | `7777` | ポート番号 |

### 権限モードについて

- `acceptEdits`（既定）: ファイルの読み書きは確認なしで進める。許可されていないコマンドは実行されず、その旨が返事の下に表示されます。
- `bypassPermissions`: すべての操作を確認なしで実行。いちばん「部下っぽく」動きますが、何でも実行できてしまうので、作業フォルダを限定して自己責任で使ってください。
- よく使うコマンドだけ許可したい場合は、作業フォルダの `.claude/settings.json` に許可ルールを書くのがおすすめです（例: `"permissions": { "allow": ["Bash(npm run *)", "Bash(git status)"] }`）。

## しくみ

```
ブラウザ (HUD画面・音声認識・読み上げ)
   │  POST /api/chat
   ▼
server.js  ──  claude -p "指示" --output-format stream-json --resume <前回の会話>
   │                    ▲
   └── 途中経過（文章・ツール実行）を逐次ブラウザへ流す
```

- サーバーは `127.0.0.1` だけで待ち受けるので、同じ PC からしか使えません。
- 会話の続き（セッション ID）は `jarvis/.jarvis-state.json` に保存されます。
- 声は OS に入っている音声を使います。Mac なら「システム設定 → アクセシビリティ → 読み上げコンテンツ → システムの声」から、より自然な日本語音声（Kyoko 拡張、Otoya など）を追加できます。
