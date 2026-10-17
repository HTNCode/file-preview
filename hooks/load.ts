import type { PreviewDoc, PreviewKind } from '../types'
import { codeFence, extractTitle, htmlToMarkdown } from './html-to-markdown'

// `$` は import 先の関数へ渡せない（validate が拒否する）ため、ここには I/O を持たない純粋関数だけを置く

// ペインのツリー全体で描かれるのは 10 万文字まで（タイトルやボタンの文字も含む）。
// 本文で使い切ると末尾の省略の注記が描かれないので、余裕を残して切る
export const MAX_CHARS = 90_000
// 変換前の入力の上限。変換は線形時間だが、巨大な応答でフックの持ち時間を使い切らないよう先に切る
export const MAX_SOURCE_CHARS = 2_000_000

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i
const HTML_EXT = /\.(html?|xhtml)$/i

/**
 * 本文中の file: のリンクの扱い。keep はそのまま（コードブロックとして描くテキスト）、
 * local はローカルのパスだけ残す（ローカルの文書）、none はすべて無効化する（Web から取得した文書）
 */
export type FileLinkPolicy = 'keep' | 'local' | 'none'

/**
 * Markdown 要素はタブと改行以外の制御文字（C0、DEL、C1）を含むテキストを拒否するため、読み込んだ内容から落とす。
 * file: のリンクの無効化は制御文字を落とした後に行う。先に行うと、`fi\u0001le:` のように制御文字を挟んだ書き方が
 * 無効化をすり抜け、制御文字を落とした時点で生きたリンクに戻る
 */
export function sanitize(text: string, fileLinks: FileLinkPolicy): string {
  const stripped = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  // 無効化は切り詰めた後に行い、描かれない部分まで照合しない。置き換えは元より長くならないので上限は超えない
  const note = stripped.length <= MAX_CHARS ? '' : `\n\n...（${stripped.length} 文字中、先頭のみ表示）`
  const shown = note === '' ? stripped : stripped.slice(0, MAX_CHARS - note.length)
  return `${fileLinks === 'keep' ? shown : neutralizeFileLinks(shown, fileLinks === 'local')}${note}`
}

// ペインの見出しに出すタイトルの上限。$.ui.open の title にも渡すので、長すぎると開けなくなる
const MAX_TITLE_CHARS = 200

/** 1 行で描く文字列から、改行やタブを含む制御文字を空白にする。制御文字があるとホストがペイン全体の描画を拒否する */
export function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function cleanTitle(title: string): string {
  return oneLine(title).slice(0, MAX_TITLE_CHARS)
}

function capSource(text: string): string {
  return text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text
}

/**
 * モデルが読む応答（コマンド出力・ツール結果）に載せる URL から、認証情報・クエリ・フラグメントを外す。
 * トークン付き URL をプレビューしたときに秘密値が会話履歴へ残らないようにするため。
 */
export function redactSource(source: string): string {
  if (!isWebUrl(source)) return source
  try {
    const url = new URL(source)
    const hasSecretParts = url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    return `${url.origin}${url.pathname}${hasSecretParts ? ' (クエリ等は省略)' : ''}`
  } catch {
    return '(不正な URL)'
  }
}

export function isWebUrl(target: string): boolean {
  return /^https?:\/\//i.test(target)
}

export function kindOf(target: string): PreviewKind {
  if (isWebUrl(target)) return 'url'
  if (MARKDOWN_EXT.test(target)) return 'markdown'
  if (HTML_EXT.test(target)) return 'html'
  return 'text'
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * realPath が root の配下か。どちらも `$.fs.stat` の realPath（同じ方法で解決したもの）を渡す。
 * Windows のパス（ドライブ名か `\\` で始まる root）は大文字小文字と区切りを揃えて比べる。
 * それ以外は綴りどおりに比べ、別の綴りは外とみなす（POSIX では `\` もファイル名の文字）
 */
export function isInsideRoot(realPath: string, root: string): boolean {
  const isWindowsRoot = /^(?:[A-Za-z]:[\\/]?|\\\\)/.test(root)
  const normalize = (path: string) => (isWindowsRoot ? path.replace(/\\/g, '/').toLowerCase() : path)
  const base = normalize(root).replace(/\/+$/, '')
  return normalize(realPath).startsWith(`${base}/`)
}

/** Windows の `C:\a\b.html` と POSIX の `/a/b.html` の両方を file URL にする */
export function toFileUrl(absolutePath: string): string {
  const slashed = absolutePath.replace(/\\/g, '/')
  const withRoot = slashed.startsWith('/') ? slashed : `/${slashed}`
  return `file://${encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

function fence(text: string, path: string): string {
  return codeFence(text, /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '')
}

// HTML の構文では数値参照の `;` を省ける（次が数字でなければ参照として読まれる）ので、省いた書き方も拾う
function charRef(code: number): string {
  return `&#0*${code}(?:;|(?![0-9]))|&#x0*${code.toString(16)}(?:;|(?![0-9a-f]))`
}

function letterPattern(letter: string): string {
  return `(?:${letter}|${charRef(letter.charCodeAt(0))}|${charRef(letter.toUpperCase().charCodeAt(0))})`
}

// 描画側が `file:` と読む書き方をまとめて拾う。Markdown のパーサーは文字参照（`&#102;` など）と `\:` を、
// URL のパーサーは途中のタブ・LF・CR を取り除くため、それらを挟んだ書き方も対象にする
// （生の LF と CR はリンク先に書けないので、文字参照の形だけ拾う）。
// リンクの文脈（`](` や `<`）では絞らない。参照定義の改行や `\:` など、文脈の書き方が多く漏れやすいため。
// 語の途中（英数字の直後。ただし `;` を省いた数値参照の直後は除く）は対象外にする（isInWord）。`profile:` などは file スキームにならず、書き換えると本文やコードが変わってしまう
const SCHEME_GAP = `(?:\\t|&tab;|&newline;|${charRef(9)}|${charRef(10)}|${charRef(13)})*`
const FILE_SCHEME = new RegExp(
  [...'file'].map(letterPattern).join(SCHEME_GAP) + SCHEME_GAP + `(?::|\\\\:|&colon;|${charRef(58)})`,
  'gi',
)

/** offset の直前から、chars に当たる文字が続く間さかのぼった位置 */
function runStart(text: string, offset: number, chars: RegExp): number {
  let start = offset
  while (start > 0 && chars.test(text[start - 1] ?? '')) start--
  return start
}

/**
 * `&#32` や `&#xa` のように `;` を省いた数値参照の直後か。参照は数字や a〜f で終わるが、復号すると語の区切りになりうる。
 * さかのぼって読むのは 16 進の文字（0-9、a-f）の並びだけ。どの一致も 16 進以外の文字（i、l、#、;、x など）を含むので、
 * 前の一致を越えてさかのぼることはなく、全体は線形のまま
 */
function followsBareNumericRef(text: string, offset: number): boolean {
  const decimal = runStart(text, offset, /[0-9]/)
  if (decimal < offset && text.slice(decimal - 2, decimal) === '&#') return true
  const hex = runStart(text, offset, /[0-9a-f]/i)
  return hex < offset && /^&#x$/i.test(text.slice(hex - 3, hex))
}

function isInWord(text: string, offset: number): boolean {
  return /[A-Za-z0-9]/.test(text[offset - 1] ?? '') && !followsBareNumericRef(text, offset)
}

// ローカルの文書で残すのは、開く側が正規化しても `file:///` の後ろにホスト名が来ないリンクだけ
// （`file:////host` などは Windows で UNC として開かれうる）。判定は、リンク先として読まれうる範囲の全体で行う。
// リンク先は改行を含めないが、それ以外の区切りは書式ごとに違う。裸の書式は `<`・`>`・全角の空白や NBSP を含められ、
// `<…>` の書式は半角の空白を含められ、参照定義では行内の最後の `>` まで伸びうる。`<` の直後に空白・タブ・文字参照を
// 置いた `< file:///a b/../x>` もリンク先になる（URL のパーサーが先頭の空白を取り除く）ので、直前の文字から書式を
// 見分けることもできない。そこで書式に関係なく行末までを範囲にする。同じ行の後ろにある別のリンクや本文に
// `&` や `/../` があると正当なリンクも残らないが、安全側に倒す。
// 行の残りの長さを限るのは、1 つの長い行に file: が並ぶ入力で、照合ごとに行末まで読んで2乗時間になるのを防ぐため。
// 上限を超える行（HTML から変換した長い段落など）では、正当なリンクも残らない
const MAX_LINE_TAIL_CHARS = 1024
const LINK_TAIL = new RegExp(`[^\\n]{0,${MAX_LINE_TAIL_CHARS + 1}}`, 'y')
const LOCAL_PATH_HEAD = /^\/\/\/[^/\\]/
// 開く側の正規化で `//host` に変わりうる書き方。`.` と `..` のセグメントは取り除かれ、`\` は `/` になる。
// 文字参照（`&`）、`\` のエスケープ、%2e / %2f / %5c の符号化、URL のパーサーが取り除くタブは、それらを隠せる
const HIDES_HOST = /[\\&\t]|%(?:2e|2f|5c)|\/\.\.?(?:\/|$)/i

function isLocalFileLink(markdown: string, from: number): boolean {
  LINK_TAIL.lastIndex = from
  const tail = LINK_TAIL.exec(markdown)?.[0] ?? ''
  return tail.length <= MAX_LINE_TAIL_CHARS && LOCAL_PATH_HEAD.test(tail) && !HIDES_HOST.test(tail)
}

/**
 * 本文に書かれた file: のリンクを、`file：`（全角のコロン）に変えて文字として残す。
 * 本文の Markdown 記号はエスケープしないため、HTML の本文や .md に書かれただけで、
 * ホスト付き file:（Windows では SMB 接続になり、認証情報が外部ホストへ送られうる）のリンクになってしまう
 */
export function neutralizeFileLinks(markdown: string, keepLocalPaths: boolean): string {
  return markdown.replace(FILE_SCHEME, (match: string, offset: number) => {
    if (isInWord(markdown, offset)) return match
    const isLocalPath =
      keepLocalPaths && match.toLowerCase() === 'file:' && isLocalFileLink(markdown, offset + match.length)
    return isLocalPath ? match : 'file：'
  })
}

export function docFromUrl(url: string, fetched: string): PreviewDoc {
  const body = capSource(fetched)
  const isMarkdown = MARKDOWN_EXT.test(new URL(url).pathname)
  return {
    // URL の構文に沿って正規化し、表示に制御文字などが混ざらないようにする
    source: new URL(url).href,
    kind: 'url',
    title: cleanTitle((isMarkdown ? undefined : extractTitle(body)) ?? redactSource(url)),
    markdown: sanitize(isMarkdown ? body : htmlToMarkdown(body, url), 'none'),
    mtimeMs: 0,
  }
}

export function docFromFile(absolutePath: string, read: string, mtimeMs: number): PreviewDoc {
  const raw = capSource(read)
  const kind = kindOf(absolutePath)
  const converted =
    kind === 'html' ? htmlToMarkdown(raw, toFileUrl(absolutePath)) : kind === 'text' ? fence(raw, absolutePath) : raw
  return {
    source: absolutePath,
    kind,
    title: cleanTitle((kind === 'html' ? extractTitle(raw) : undefined) ?? baseName(absolutePath)),
    markdown: sanitize(converted, kind === 'text' ? 'keep' : 'local'),
    mtimeMs,
  }
}
