# file-preview

Claude CodeのペインにMarkdown / HTMLファイルやWebページ（URL）をプレビュー表示するmodです。
macOSとWindowsのどちらでも同じファイル一式で動きます。

## できること

| 対象 | 表示のしかた |
| --- | --- |
| `.md` / `.markdown` / `.mdx` | Claudeの返答と同じMarkdownレンダラで描画 |
| `.html` / `.htm` | 本文をMarkdownに変換して描画（見出し・リスト・リンク・コードを保持。表はセルを` \| `区切りのテキストで表示） |
| `http(s)://`のURL | ページを取得してHTMLと同じく変換して描画 |
| その他のテキスト | 拡張子付きのコードブロックとして描画 |

- ローカルファイルは1.5秒ごとに更新日時を確認し、保存されたら自動で再読み込みします
- ペインのボタン: `[再読み込み]`（r）、`[スクリーンショット]`（s、ローカルのHTMLファイルのみ）、`ブラウザで開く`リンク
- Claudeに「このHTMLをプレビューして」と頼むと、modが登録するツール`mcp__file-preview__open`をClaudeが呼んでペインを開きます

## 使い方

```
/preview README.md
/preview docs/index.html
/preview "C:\Users\me\Documents\report.html"
/preview https://example.com
/preview            # 直前のプレビューをもう一度開く
```

## インストール

zipを展開してできる`file-preview`フォルダ（`.claude-plugin`ディレクトリを含む、プラグインのルートフォルダ）を、マーケットプレイスとして登録してからインストールします。

### macOS

```bash
claude plugin marketplace add ~/path/to/file-preview
```

### Windows（PowerShell）

```powershell
claude plugin marketplace add "$env:USERPROFILE\path\to\file-preview"
```

### 共通（Claude Codeのプロンプトで実行）

```
/plugin install file-preview@file-preview-local
```

### インストールせずに試す場合

```bash
claude --plugin-dir ~/path/to/file-preview
```

常に読み込ませたい場合は、`~/.claude/settings.json`（Windowsは`%USERPROFILE%\.claude\settings.json`）の`env`に書く方法もあります。
複数指定する場合の区切りはmacOSが`:`、Windowsが`;`です。

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\me\\tools\\file-preview" } }
```

## スクリーンショット機能について

- 対象はローカルのHTMLファイルだけです。URLの見た目を確認したいときは`ブラウザで開く`を使ってください
- 撮影するブラウザは通信をすべて遮断して起動します（到達できないプロキシを指定し、ループバック宛ての例外も外す）。信頼できないHTMLの`<img src="http://127.0.0.1/...">`などで、端末から社内やローカルのサービスへリクエストが送られないようにするためです。
- 元のHTMLは直接開かず、外部読み込みを止めたコピーを一時フォルダに作って撮ります。先頭にCSP（`default-src 'none'`）を入れ、元の`<meta>`と`<link>`はタグごと取り除き（ほかの要素の入れ子は変えません。ただしCSSの文字列やコメントの中にある`<meta>`・`<link>`という文字列も取り除かれます）、JavaScriptも止めます。Windowsでは`file://server/share/...`のようなUNC参照がプロキシを通らずSMBで取得され、外部ホストへの接続や認証情報の送信につながるため、読み込みそのものを止めています
- ネットワーク上のファイル（`\\server\share\a.html`など）は撮影しません
- そのため、撮影結果には外部や別ファイルから読み込む画像・CSS・フォント、JavaScriptで描く内容は反映されません。HTMLに埋め込んだスタイルと`data:`の画像だけが反映されます
- ヘッドレスのChromium系ブラウザで1280x800のPNGを撮ります
  - Google Chromeを前提にしています
  - macOS: Google Chrome、見つからなければMicrosoft Edge、Chromiumの順に探す
  - Windows: Google Chromeを`Program Files (x86)`・`Program Files`・`%LOCALAPPDATA%`から探し、どこにも無いときだけMicrosoft Edgeを使う
  - 見つからない場合は環境変数`FILE_PREVIEW_BROWSER`にブラウザ実行ファイルのフルパスを設定してください
- 撮影した画像をペイン内に表示できるのはkitty graphics protocolに対応した端末（kitty / Ghostty）だけです
  - WezTerm、Windows Terminal、macOS標準ターミナルなどでは代替テキストが出ます。その場合は`ブラウザで開く`を使ってください
- 撮影ファイルは一時フォルダ（macOSは`$TMPDIR`、Windowsは`%TEMP%`）に、セッションと対象ファイルごとに`file-preview-<セッションID>-<ファイルID>.png`、撮影用コピー`file-preview-<セッションID>.html`、ブラウザプロファイル`file-preview-profile-<セッションID>`として作られます。同じファイルを撮り直すと上書きされます。OSの一時フォルダ掃除で消えますが、手動で消しても問題ありません
- 撮影は同時に1件だけです。撮影中に別のファイルへ切り替えた場合、古い画像は付きません
- ブラウザのエラー出力（stderr）はパスやURLを含むことがあるため表示せず、終了コードだけを出します

## 秘密情報の扱い

- このmodがClaudeに返す応答（コマンド出力・ツール結果）では、URLのユーザー名・パスワード・クエリ・フラグメントを省略します。URL取得エラーも元の例外文は使わず、HTTPステータスなど安全な情報だけで伝えます
- ただし、利用者が入力したコマンド引数や、Claudeがツールに渡した引数そのものは会話履歴に残ります。トークン付きURLはなるべくプレビュー対象にしないでください
- ペイン内の表示はローカルだけなので、元のURLのまま出します

## 制限

- HTMLはDOMを使わない文字列変換なので、CSSのレイアウトやJavaScriptで描画される内容は再現しません
- 表示は先頭10万文字までです
- ローカルファイルは4 MiBまでです。読む前にサイズを確認して、超えるものは開きません
- URLの応答本文は、Claude Codeのホスト側の取得処理で全体が読み込まれます。modの中で取得量を制限するAPIが無いため、変換前に200万文字で切り詰めます
- ローカルファイルも同じく、変換前に先頭200万文字までで切り詰めます。切り詰めたことはペインに表示されません
- HTML本文中の`*`や`[...](...)`などのMarkdown記号はエスケープしないため、文字のつもりの記号が強調やリンクとして表示されることがあります
- `ブラウザで開く`は端末のリンク機能で開きます。端末によってはCtrl / Cmd +クリックが必要です
- modのAPIはearly accessのため、Claude Codeの更新で動かなくなる可能性があります（作成時: Claude Code 2.1.296）

## 構成

```
.claude-plugin/plugin.json       マニフェスト
.claude-plugin/marketplace.json  ローカルマーケットプレイス定義
hooks/hooks.json                 hooks モジュールの指定
hooks/register.tsx               コマンド・ツール・ペイン描画・I/O
hooks/load.ts                    種類判定・パス変換・本文の整形（純粋関数）
hooks/html-to-markdown.ts        HTML から Markdown への変換（純粋関数）
hooks/screenshot.ts              ブラウザ候補と起動引数の組み立て（純粋関数）
types/index.d.ts                 $.state の型定義
tests/preview.test.ts            claude plugin test 用のテスト
```

## 開発

```bash
claude plugin validate ./file-preview
claude plugin test ./file-preview
```
