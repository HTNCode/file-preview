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

/** Markdown 要素はタブと改行以外の制御文字（C0、DEL、C1）を含むテキストを拒否するため、読み込んだ内容から落とす */
export function sanitize(text: string): string {
  const cleaned = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  if (cleaned.length <= MAX_CHARS) return cleaned
  const note = `\n\n...（${cleaned.length} 文字中、先頭のみ表示）`
  return `${cleaned.slice(0, MAX_CHARS - note.length)}${note}`
}

// ペインの見出しに出すタイトルの上限。$.ui.open の title にも渡すので、長すぎると開けなくなる
const MAX_TITLE_CHARS = 200

/** タイトルは 1 行で描くので、改行やタブを含む制御文字を空白にし、長さを切る。制御文字があるとホストが描画を拒否する */
export function cleanTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
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

/** Windows の `C:\a\b.html` と POSIX の `/a/b.html` の両方を file URL にする */
export function toFileUrl(absolutePath: string): string {
  const slashed = absolutePath.replace(/\\/g, '/')
  const withRoot = slashed.startsWith('/') ? slashed : `/${slashed}`
  return `file://${encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

function fence(text: string, path: string): string {
  return codeFence(text, /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '')
}

/**
 * Web から取得した文書の本文に書かれた file: のリンク（`[x](file://...)`、`<file://...>`、参照定義）を、
 * 描画されない形に変えて文字として残す。本文の Markdown 記号はエスケープしないため、
 * HTML の本文や .md に書かれただけで、ホスト付き file:（SMB 接続）のリンクになってしまう
 */
export function neutralizeFileLinks(markdown: string): string {
  return markdown.replace(/(\]\(\s*<?|<|\]:[ \t]*<?)file:/gi, '$1blocked-file:')
}

export function docFromUrl(url: string, fetched: string): PreviewDoc {
  const body = capSource(fetched)
  const isMarkdown = MARKDOWN_EXT.test(new URL(url).pathname)
  return {
    // URL の構文に沿って正規化し、表示に制御文字などが混ざらないようにする
    source: new URL(url).href,
    kind: 'url',
    title: cleanTitle((isMarkdown ? undefined : extractTitle(body)) ?? redactSource(url)),
    markdown: sanitize(neutralizeFileLinks(isMarkdown ? body : htmlToMarkdown(body, url))),
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
    markdown: sanitize(converted),
    mtimeMs,
  }
}
