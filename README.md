# file-preview

Claude CodeのペインにMarkdown / HTMLファイルやWebページ（URL）をプレビュー表示するmodです。
macOSとWindowsのどちらでも同じファイル一式で動きます。

## 必要な環境変数

modを使うだけなら必須の値はありません。

| 名前 | 用途 | 設定先 | 必須 |
| --- | --- | --- | --- |
| `FILE_PREVIEW_BROWSER` | スクリーンショットに使うブラウザ実行ファイルのフルパス。Chrome / Edge / Chromiumが自動で見つからないときだけ設定する | ローカル環境変数 | 任意 |

macOS（`~/.zshrc`などに追記）:

```
export FILE_PREVIEW_BROWSER="<値>"
```

Windows（設定後は新しいターミナルから有効）:

```
setx FILE_PREVIEW_BROWSER "<値>"
```

## できること

| 対象 | 表示のしかた |
| --- | --- |
| `.md` / `.markdown` / `.mdx` | Claudeの返答と同じMarkdownレンダラで描画（ターミナルでは下記の組み直しをしてから描く） |
| `.html` / `.htm` / `.xhtml` | 本文をMarkdownに変換して描画（見出し・番号付きや入れ子のリスト・表・リンク・コードを保持） |
| `http(s)://`のURL | ページを取得してHTMLと同じく変換して描画 |
| その他のテキスト | 拡張子付きのコードブロックとして描画 |

- ローカルファイルは1.5秒ごとに更新日時を確認し、保存されたら自動で再読み込みします
- ペインのボタン: `[再読み込み]`（r）、`[スクリーンショット]`（s、ローカルのHTMLファイルのみ）、`ブラウザで開く`リンク、`[閉じる]`（q）
  - キーで押せるのはペインにフォーカスがあるときだけです。ペインをクリックするか、ctrl+x tabでフォーカスを移してから押してください
- Claudeに「このファイルをプレビューして」と頼むと、modが登録するツール`mcp__file-preview__open`をClaudeが呼んでペインを開きます
  - このツールで開けるのは、作業ディレクトリ（セッションを始めたフォルダ。`/cd`で移すと移した先）の配下にあるローカルのファイルだけです（シンボリックリンクは、たどった先の場所で判定します）。Claudeがシェルで`cd`しても範囲は変わりません。開けるのはMarkdown・HTML・.txtの文書だけで、拡張子もたどった先のファイルで判定します。作業ディレクトリの外のファイル、文書以外のファイル、URL、ネットワーク上のファイル（`\\server\share\a.md`など）は`/preview`で自分で開いてください
  - 相対パスは、Claudeがシェルで`cd`した先を基準に解決されることがあります。開けないときは絶対パスで頼んでください
  - ハードリンクはたどった先ではなくリンク自身の名前と場所で判定されます。作業ディレクトリ内に作られた`notes.md`という名前のハードリンクが鍵ファイルを指していると、表示されます（gitはハードリンクを再現しないので、リポジトリをクローンしただけでは起きません）
  - Windowsのパスは英字（ASCII）の大文字小文字を区別せずに判定します。大文字小文字を区別するフォルダ（WSLのフォルダなど）では、作業ディレクトリのパスと大文字小文字だけが違うフォルダ（`proj`に対する`PROJ`など。途中のフォルダの違いも含みます）も配下とみなされます
  - ツールの呼び出しはClaude Codeの許可確認を通らず、設定の`permissions.deny`も効きません。そのため、Claudeが確認なしに外部へ通信したり、作業ディレクトリの外のファイルや、作業ディレクトリ内の設定ファイル・鍵（`.json`や拡張子のない鍵など）を画面に出したりできないようにしています。作業ディレクトリ内のMarkdown・HTML・.txtは、`permissions.deny`で読み取りを禁じていても表示されます
  - 範囲は、開くとき・再読み込みのとき・撮影のときに確かめ、読んだ後にも確かめ直します。それでも、確かめてから読むまでのごく短い間に作業ディレクトリ内のフォルダやファイルをリンクへ差し替えられ、読んだ直後に元へ戻されると、外を読む余地は残ります
  - ファイルの中身はClaudeに返しません。開けたかどうかは伝わりますが、開けなかった理由（ファイルが無い、大きすぎる、時間切れなど）とシンボリックリンクの実体のパスは伝えません
  - ローカルのパスでも、ネットワーク上の場所を指すシンボリックリンクは、たどった時点で接続が起きます。信頼できないフォルダのファイルをClaudeに開かせるときは注意してください

## 使い方

```
/preview README.md
/preview docs/index.html
/preview "C:\Users\me\Documents\report.html"
/preview https://example.com
/preview            # 直前のプレビューをもう一度開く
```

`~`はホームディレクトリに展開されません。ホーム配下のファイルは絶対パスで指定してください。

## インストール

```bash
claude plugin marketplace add HTNCode/file-preview
claude plugin install file-preview@htncode
```

インストール後にClaude Codeを再起動すると使えます。更新するときは次を実行し、再起動します。

```bash
claude plugin marketplace update htncode
claude plugin update file-preview@htncode
```

起動時の自動更新は既定でオフです。`/plugin`の画面で有効にできます。

### 以前の名前（file-preview-local）で入れている場合

マーケットプレイス名を`file-preview-local`から`htncode`に変えました。古い登録を外してから入れ直してください。

```bash
claude plugin uninstall file-preview@file-preview-local
claude plugin marketplace remove file-preview-local
```

### cloneしたフォルダから入れる場合

```bash
git clone https://github.com/HTNCode/file-preview.git
claude plugin marketplace add ./file-preview
claude plugin install file-preview@htncode
```

### インストールせずに試す場合

```bash
claude --plugin-dir ./file-preview
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
- 撮影ファイルは一時フォルダ（macOSは`$TMPDIR`、Windowsは`%TEMP%`）に、セッションと対象ファイルごとに`file-preview-<セッションID>-<ファイルID>.png`、撮影用コピー`file-preview-<セッションID>.html`、ブラウザプロファイル`file-preview-profile-<セッションID>`として作られます。撮影用コピーは撮影後に中身を空にします（空のファイルは残ります。空にできなかったときは中身が残り、デバッグログに記録します。撮影中にClaude Codeを終了した場合なども、記録なしで中身が残ることがあります）。同じファイルを撮り直すと上書きされます。OSの一時フォルダ掃除で消えますが、手動で消しても問題ありません
- 撮影は同時に1件だけです。撮影中に別のファイルへ切り替えた場合、古い画像は付きません
- ブラウザのエラー出力（stderr）はパスやURLを含むことがあるため表示せず、終了コードだけを出します

## 秘密情報とリンクの扱い

- このmodがClaudeに返す応答（コマンド出力・ツール結果）では、URLのユーザー名・パスワード・クエリ・フラグメントを省略します。URL取得エラーも元の例外文は使わず、HTTPステータスなど安全な情報だけで伝えます
- ただし、利用者が入力したコマンド引数や、Claudeがツールに渡した引数そのものは会話履歴に残ります。トークン付きURLはなるべくプレビュー対象にしないでください
- ペイン内の表示はローカルだけなので、元のURLのまま出します
- Webから取得した文書では`file:`のリンクを描きません。ローカルの文書（.md / .html）でも、描くのは`file:///Users/...`や`file:///C:/...`のようなローカルのパスだけです。ホスト付きの`file://server/...`などはWindowsで開くとSMB接続になり、認証情報が外部ホストへ送られうるためです
  - 開くときの正規化でホスト付きに変わりうる書き方（`/../`や`/./`、`%2F`・`%5C`・`%2E`、`\`、`&`（文字参照やクエリの区切り）、タブを含むもの）も、ローカルのパスとはみなしません
  - 判定は、リンク先として読まれうる範囲として`file:`から行末までを見ます。そのため、同じ行の後ろに上の書き方（別のリンクの`%5C`や本文の`&`など）があると、正当なローカルのリンクでも文字になります。`file:`から行末までが1024文字を超える場合も文字になります。HTMLから変換した段落は1行になりやすいので、どちらの影響も受けやすくなります
  - 描かない`file:`は、本文中の`file:`を`file：`（全角のコロン）に置き換えて文字として残します。文字参照やタブを挟んだ書き方も対象にするため、Webの文書でもローカルの.md / .htmlでも、コードブロック内の`file:`（YAMLのキーなど）が`file：`と表示されることがあります。英数字の直後にあるもの（`profile:`など）は置き換えません。ただし、`;`を省いた数値参照（`&#32`など）の直後は、復号すると語の区切りになりうるので置き換えます
- 利用者以外から届いた`/preview`（通知や別セッションなど）は、Claudeのツールと同じ扱いです。開けるのは作業ディレクトリの配下にあるMarkdown・HTML・.txtの文書だけで、URLとネットワーク上のファイルは開きません。引数のない`/preview`で直前のプレビューを開き直すこともしません。応答には渡されたパスだけを返し、開けなかった理由やシンボリックリンクの実体のパスは返しません

## 制限

- HTMLはDOMを使わない文字列変換なので、CSSのレイアウトやJavaScriptで描画される内容は再現しません
  - セルに見出し・リスト・入れ子の表などを持つレイアウト用の表は、表にせずセルごとに改行した本文として流します。セルを`<p>`や`<div>`で包んだだけの表はデータの表として扱います
- ターミナルでは、読みやすいよう表示の前に次のように組み直します（ファイルの内容は変えません。ほかの面ではそのまま描きます）
  - コードブロックは枠付きの箱で描く（100個まで）
  - 見出しの前に記号（■ □ ▸）を付け、箇条書きは`・`、番号付きは番号を文字のまま残す
  - 表は罫線が狭いペインで崩れるため、「列名: 値」の縦並びにする（50列まで）。1行だけの表（外枠に使ったものなど）は、セルの全文を1つずつ並べる
- 太字・斜体・見出しの文字の大きさは端末とフォントに依存します。日本語の太字や斜体を出せないフォントでは区別が付きません
- 表示は先頭9万文字までです（ペイン全体で描ける量に、タイトルやボタンの分の余裕を残しています）
- ローカルファイルは4 MiBまでです。読む前にサイズを確認して、超えるものは開きません
- URLの応答本文は、Claude Codeのホスト側の取得処理で全体が読み込まれます。modの中で取得量を制限するAPIが無いため、変換前に200万文字で切り詰めます
- ローカルファイルも同じく、変換前に先頭200万文字までで切り詰めます。切り詰めたことはペインに表示されません
- HTML本文中の`*`や`[...](...)`などのMarkdown記号はエスケープしないため、文字のつもりの記号が強調やリンクとして表示されることがあります
- `ブラウザで開く`は端末のリンク機能で開きます。端末によってはCtrl / Cmd +クリックが必要です
- modのAPIはearly accessのため、Claude Codeの更新で動かなくなる可能性があります（作成時: Claude Code 2.1.296）

## 構成

```
.claude-plugin/plugin.json       マニフェスト
.claude-plugin/marketplace.json  マーケットプレイス定義（htncode）
hooks/hooks.json                 hooks モジュールの指定
hooks/register.tsx               コマンド・ツール・ペイン描画・I/O
hooks/load.ts                    種類判定・パス変換・本文の整形（純粋関数）
hooks/html-to-markdown.ts        HTML から Markdown への変換（純粋関数）
hooks/display.ts                 ペインの表示用の組み直し（純粋関数）
hooks/screenshot.ts              ブラウザ候補と起動引数の組み立て（純粋関数）
types/index.d.ts                 $.state の型定義
tests/preview.test.ts            claude plugin test 用のテスト
.github/workflows/claude-review.yml  @claude メンションで動く自動レビュー（メンテナー用）
.github/dependabot.yml           ワークフローの actions の更新追従
LICENSE                          Unlicense
SECURITY.md                      脆弱性の報告方法
```

## 開発者向け

```bash
claude plugin validate ./file-preview
claude plugin test ./file-preview
```

- インストール済みのmodはバージョンごとにキャッシュされます。`.claude-plugin/plugin.json`に`version`を書いているので、変更を公開するときは`version`も上げてください。上げないと、利用者が更新しても古い内容のままになります

### @claude自動レビュー（メンテナー用）

PRやIssueのコメントで`@claude`とメンションすると、Claude Codeがレビューします。反応するのはリポジトリのオーナーとコラボレーターのコメントだけで、Claudeが読むコメントもメンテナー本人のものに限っています。

- 使うにはActionsシークレット`CLAUDE_CODE_OAUTH_TOKEN`が必要です。値は`claude setup-token`で取得し、`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>`で登録します（値はプロンプトで入力するのでシェル履歴に残りません）。フォークで使う場合は、自分のリポジトリに登録してください
- 長いトークンは端末の折り返し表示をコピーすると、途中に空白や改行が混入することがあります。貼り付けた値が1行で、空白がないことを確認してください
- ジョブはリポジトリへの書き込み権限を持ちます。第三者のPRやIssueの中で`@claude`を使うと、その本文がClaudeへの入力になるため、外部からの投稿では使わないでください
- 公開リポジトリではActionsのログも公開されます。デバッグログを有効にした再実行はしないでください

## 連絡先

不具合の報告や要望はGitHubのIssueへお願いします。それ以外のお問い合わせは https://www.htncode.com/contact から受け付けています。
セキュリティ上の問題は公開のIssueには書かず、[SECURITY.md](SECURITY.md)の手順で非公開で報告してください。

## ライセンス

[Unlicense](LICENSE)で公開しています。条件なしで使用・改変・再配布できます。
