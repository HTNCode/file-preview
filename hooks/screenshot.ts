import { findTagEnd } from './html-to-markdown'
import { isWebUrl, toFileUrl } from './load'

// ヘッドレスの Chromium 系ブラウザで PNG を撮るための引数組み立て。I/O は register.tsx 側で行う。
// Chrome を前提とし、macOS・Windows とも Chrome を先に探す。見つからない場合だけ Edge（Windows は標準搭載）を使う。
export const VIEWPORT = { width: 1280, height: 800 }

export const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

/** Windows の `ProgramFiles(x86)` / `ProgramFiles` / `LOCALAPPDATA` を起点に候補を並べる */
export function windowsBrowsers(roots: readonly string[]): string[] {
  const chrome = roots.map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`)
  const edge = roots.map((root) => `${root}\\Microsoft\\Edge\\Application\\msedge.exe`)
  return [...chrome, ...edge]
}

/** `\\server\share\a.html` や `//server/share/a.html` のようなネットワーク上のパスか */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

// 撮影用コピーの先頭に入れる CSP。外部・ローカルを問わずサブリソースの読み込みを通信の前に止める。
// 画像とフォントは埋め込み（data:）だけ、スタイルはインラインだけを許す
const SCREENSHOT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/**
 * 撮影に使う HTML のコピーを作る。
 * Windows では `file://host/share/x.png` のような UNC 参照がプロキシを通らず SMB で取得され、
 * 外部ホストへの接続や認証情報（NTLM ハッシュ）の送信につながる。プロキシ遮断だけでは防げないため、
 * CSP で読み込み自体を止め、元の `<meta>`（refresh による遷移）と `<link>`（先読み等）は取り除く。
 * CSP は後から足されたものも含めてすべて適用されるので、元の HTML に CSP があっても緩むことはない。
 */
export function hardenHtmlForScreenshot(html: string): string {
  const neutralized = removeMetaAndLinkTags(html)
  // 固定の DOCTYPE（標準モード）と CSP を必ず先頭に置き、元の内容はその後ろに続ける。
  // 元の DOCTYPE を探して残す方式は、引用符内の `>` などで挿入位置をずらされ CSP を無効化され得るので採らない。
  // 後ろに残る元の DOCTYPE は、HTML の仕様上パースエラーとして無視される
  return `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SCREENSHOT_CSP}">${neutralized}`
}

/**
 * `<meta>` と `<link>` のタグを取り除く。
 * 別名（`<x-meta>` 等）に変える方式は、閉じタグの無い未知の要素として後続の本文を子要素に取り込み、
 * レイアウトを壊すので採らない。取り除いた跡は空白にし、前後がつながって新しいタグができないようにする。
 * タグの終わりが見つからないときは `<` を文字にして、ブラウザにもタグとして読ませない。
 */
function removeMetaAndLinkTags(html: string): string {
  const pattern = /<(?:meta|link)(?=[\s/>]|$)/gi
  const parts: string[] = []
  let copied = 0
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const tagEnd = findTagEnd(html, match.index)
    parts.push(html.slice(copied, match.index), tagEnd < 0 ? '&lt;' : ' ')
    copied = tagEnd < 0 ? match.index + 1 : tagEnd + 1
    pattern.lastIndex = copied
  }
  parts.push(html.slice(copied))
  // 最後の保険: 除去の後にまだ `<meta` / `<link` が残っていれば、その `<` を文字にする。
  // `<` を増やさない置き換えなので、この処理から新しいタグが生まれることはなく、
  // 除去の判定がブラウザの解釈とずれる入力でも、生きた meta（refresh）や link は残らない
  return parts.join('').replace(/<(?=(?:meta|link)(?:[\s/>]|$))/gi, '&lt;')
}

/** 撮影画像のファイル名に使う、対象パスごとの短い識別子（FNV-1a）。別ファイルの撮影で上書きし合わないようにする */
export function shotKey(source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 撮影はローカルの HTML ファイルに限り、ブラウザの通信を遮断して起動する。
 * 信頼できない HTML の `<img src="http://127.0.0.1/...">` などで、利用者の端末から社内やローカルのサービスへ
 * リクエストを送らせない（SSRF）ため。到達できないプロキシを指定し、`<-loopback>` でループバックの例外も外す。
 * プロキシを通らない file:// の UNC 参照は、hardenHtmlForScreenshot のコピーと JavaScript の無効化で防ぐ。
 * `hardenedCopy` には hardenHtmlForScreenshot で作ったファイルを渡す（元のファイルを直接開かない）。
 */
export function screenshotArgv(browser: string, hardenedCopy: string, file: string, profile: string): string[] {
  if (isWebUrl(hardenedCopy) || isNetworkPath(hardenedCopy)) {
    throw new Error('スクリーンショットはローカルの HTML ファイルだけが対象です')
  }
  return [
    browser,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--blink-settings=scriptEnabled=false',
    // 普段使いのブラウザが起動中でも干渉しないよう、専用のプロファイルで起動する
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--screenshot=${file}`,
    toFileUrl(hardenedCopy),
  ]
}
