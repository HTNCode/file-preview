// hooks モジュールの実行環境には DOM が無いため、HTML は自前のトークナイザで読める Markdown に落とす。
// 目的は「ターミナルでも中身が読める」ことで、レイアウトの再現はしない。
// 細工した HTML（閉じない `<` の連続など）で処理が詰まらないよう、正規表現の後戻りに頼らず
// 入力を先頭から一度だけ走査する。検索位置は単調に進むので、全体で入力長に比例する時間で終わる。

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '(c)',
  reg: '(R)',
  hellip: '...',
  mdash: '-',
  ndash: '-',
}

/** 中身ごと読み飛ばす要素。閉じタグまで本文として扱わない */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'head', 'title', 'textarea'])
const BLOCKS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside',
  'ul', 'ol', 'table', 'blockquote', 'dl', 'dt', 'dd', 'form', 'figure', 'figcaption',
])
const EMPHASIS: Record<string, string> = { strong: '**', b: '**', em: '*', i: '*' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,32});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    const name = body.toLowerCase()
    return Object.hasOwn(NAMED_ENTITIES, name) ? (NAMED_ENTITIES[name] ?? whole) : whole
  })
}

// Link が受け付けるアドレスの上限。これを超える URL はリンクにせず文字だけ残す
const MAX_HREF_CHARS = 2048

/** Markdown 要素が描画するのは http / https / file のリンクだけなので、それ以外は文字として残す */
function resolveHref(href: string, base: string | undefined): string | undefined {
  try {
    const url = base === undefined ? new URL(href) : new URL(href, base)
    const isDrawable = ['http:', 'https:', 'file:'].includes(url.protocol) && url.href.length <= MAX_HREF_CHARS
    return isDrawable ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * タグ内の属性を先頭から順に読み、指定した名前の値を返す。
 * 正規表現で探すと `title="href='/x'"` のような引用符内の文字列を拾うので、引用符の内外を追って読む
 */
function attribute(attrs: string, name: string): string | undefined {
  const pattern = /\s*([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?|\s*[^\s]/y
  for (let match = pattern.exec(attrs); match !== null && match[0] !== ''; match = pattern.exec(attrs)) {
    if (match[1]?.toLowerCase() === name) {
      const value = match[2] ?? match[3] ?? match[4]
      return value === undefined ? undefined : decodeEntities(value)
    }
  }
  return undefined
}

/**
 * 大文字小文字を区別せずに `needle` を探し、元の文字列での位置を返す。
 * toLowerCase した文字列の位置は、`İ` のように小文字化で長さが変わる文字があると元とずれるため使わない
 */
function indexOfIgnoringCase(html: string, needle: string, from: number): number {
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi')
  pattern.lastIndex = from
  return pattern.exec(html)?.index ?? -1
}

export function extractTitle(html: string): string | undefined {
  const open = indexOfIgnoringCase(html, '<title', 0)
  const start = open < 0 ? -1 : html.indexOf('>', open)
  const end = start < 0 ? -1 : indexOfIgnoringCase(html, '</title', start)
  if (end < 0) return undefined
  const title = decodeEntities(html.slice(start + 1, end)).replace(/\s+/g, ' ').trim()
  return title === '' ? undefined : title
}

type LinkFrame = { start: number; target: string | undefined }

// 1 つのタグとして読む長さの上限。閉じない引用符で残り全体を読み進めないための保険
const MAX_TAG_CHARS = 8192

/**
 * `<` から始まるタグの終わりの `>` の位置を返す。タグでなければ -1。
 * 属性値の `"1 > 0"` のような引用符内の `>` `<` はタグの区切りとして扱わない。
 * 引用符の外で `<` が現れたら、この `<` は文字とみなす（以降のタグは次の走査で読む）。
 */
export function findTagEnd(html: string, lt: number): number {
  if (!/[a-zA-Z/]/.test(html[lt + 1] ?? '')) return -1
  const limit = Math.min(html.length, lt + MAX_TAG_CHARS)
  let quote: string | undefined
  for (let j = lt + 1; j < limit; j++) {
    const char = html[j]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return j
    } else if (char === '<') {
      return -1
    }
  }
  return -1
}

// 入れ子のリストを字下げする段数の上限。深い入れ子で 1 行の字下げが膨らまないようにする
const MAX_LIST_INDENT = 10

// 変換結果の上限。表示は 10 万文字までなので、空白整理で縮む分を見込んでも十分な量で打ち切る
const OUTPUT_BUDGET = 400_000

/** 中身に含まれる最長のバッククォート列より長いフェンスで囲み、本文でフェンスが閉じないようにする */
export function codeFence(text: string, language = ''): string {
  let longest = 2
  let run = 0
  for (const char of text) {
    run = char === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  const marker = '`'.repeat(longest + 1)
  return `${marker}${language}\n${text}\n${marker}`
}

// \u5165\u308c\u5b50\u306e\u30ea\u30b9\u30c8\u306e\u5b57\u4e0b\u3052\u3060\u3051\u306f\u6b8b\u3059\u3002\u307b\u304b\u306e\u884c\u982d\u306e\u7a7a\u767d\u306f\u3001\u5143\u306e HTML \u306e\u6539\u884c\u3084\u30a4\u30f3\u30c7\u30f3\u30c8\u306b\u7531\u6765\u3059\u308b\u306e\u3067\u6d88\u3059
const LIST_ITEM_INDENT = /^( +)(?=- |\d+\. )/

function normalizeText(text: string): string {
  return text
    .split('\n')
    .map((line) => (LIST_ITEM_INDENT.exec(line)?.[1] ?? '') + line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function htmlToMarkdown(html: string, baseUrl?: string): string {
  // pre の中身は空白整理で崩れるので、本文とは別の種類のセグメントとして持つ。
  // 文字列の目印で退避すると、入力に同じ目印を書かれたときに中身が増殖するため使わない
  const segments: Array<{ text: string } | { fence: string }> = []
  let out: string[] = []
  let links: LinkFrame[] = []
  let pre: string[] | undefined
  let produced = 0
  let i = 0
  // ul / ol の入れ子。番号付きは次に振る番号を持つ
  const lists: Array<{ next: number | undefined }> = []
  // 表は一番外側だけを Markdown の表にする。内側の表は外側のセルの文字として流す
  let tableDepth = 0
  let row = 0
  let cells = 0

  // 表の中では改行を空白にする。セル内の改行は Markdown の表の行を壊すため。
  // 表の行や区切り行そのものを出すときだけ isStructural で改行を通す
  const emit = (text: string, isStructural = false) => {
    const value = tableDepth > 0 && pre === undefined && !isStructural ? text.replace(/\n+/g, ' ') : text
    produced += value.length
    if (pre !== undefined) pre.push(value)
    else out.push(value)
  }
  const pushText = (raw: string) => {
    const decoded = decodeEntities(raw)
    if (pre !== undefined) emit(decoded)
    else emit((tableDepth > 0 ? decoded.replace(/\|/g, '\\|') : decoded).replace(/\s+/g, ' '))
  }
  const flushText = () => {
    segments.push({ text: out.join('') })
    out = []
    links = []
  }

  while (i < html.length && produced < OUTPUT_BUDGET) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      pushText(html.slice(i))
      break
    }
    if (lt > i) pushText(html.slice(i, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    // `<!doctype html>` や `<?xml ...?>` は本文ではないので読み飛ばす
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const tagEnd = findTagEnd(html, lt)
    if (tagEnd < 0) {
      pushText('<')
      i = lt + 1
      continue
    }

    const tag = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*)$/.exec(html.slice(lt + 1, tagEnd))
    i = tagEnd + 1
    if (tag === null) continue
    const isClosing = tag[1] === '/'
    const name = (tag[2] ?? '').toLowerCase()
    const attrs = tag[3] ?? ''

    // `<svg/>` のような自己終了タグは閉じタグを持たないので、開始タグだけを読み飛ばす
    const isSelfClosing = attrs.trimEnd().endsWith('/')
    if (!isClosing && SKIPPED.has(name) && !isSelfClosing) {
      const close = indexOfIgnoringCase(html, `</${name}`, i)
      const closeEnd = close < 0 ? -1 : html.indexOf('>', close)
      i = closeEnd < 0 ? html.length : closeEnd + 1
      continue
    }
    if (name === 'pre') {
      if (!isClosing && pre === undefined) {
        flushText()
        pre = []
      } else if (isClosing && pre !== undefined) {
        segments.push({ fence: pre.join('').replace(/^\n/, '').replace(/\n+$/, '') })
        pre = undefined
      }
      continue
    }
    if (pre !== undefined) continue

    const heading = /^h([1-6])$/.exec(name)
    if (heading !== null) {
      emit(isClosing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `)
    } else if (name === 'a') {
      if (!isClosing) {
        // 入れ子のリンクは外側だけを扱う。内側ごとに本文を組み直すと入れ子の深さだけ処理が膨らむ
        const href = links.length === 0 ? attribute(attrs, 'href') : undefined
        links.push({ start: out.length, target: href === undefined ? undefined : resolveHref(href, baseUrl) })
      } else {
        const frame = links.pop()
        if (frame?.target !== undefined) {
          const label = out.splice(frame.start).join('').replace(/[[\]]/g, '').trim()
          const target = frame.target.replace(/\(/g, '%28').replace(/\)/g, '%29')
          // 増えた分（URL と記号）も出力量に数え、上限の外で文字列が膨らまないようにする
          produced += target.length + 4
          out.push(label === '' ? '' : `[${label}](${target})`)
        }
      }
    } else if (Object.hasOwn(EMPHASIS, name)) {
      emit(EMPHASIS[name] ?? '')
    } else if (name === 'code') {
      emit('`')
    } else if (name === 'img' && !isClosing) {
      const alt = attribute(attrs, 'alt')
      if (alt !== undefined && alt.trim() !== '') emit(`[画像: ${alt.trim()}]`)
    } else if (name === 'br') {
      emit('\n')
    } else if (name === 'hr') {
      emit('\n\n---\n\n')
    } else if ((name === 'ul' || name === 'ol') && !isClosing) {
      lists.push({ next: name === 'ol' ? 1 : undefined })
    } else if ((name === 'ul' || name === 'ol') && isClosing) {
      lists.pop()
      emit('\n\n')
    } else if (name === 'li' && !isClosing) {
      const list = lists.at(-1)
      const marker = list?.next === undefined ? '- ' : `${list.next++}. `
      emit(`\n${'  '.repeat(Math.min(MAX_LIST_INDENT, Math.max(0, lists.length - 1)))}${marker}`)
    } else if (name === 'table') {
      if (!isClosing) {
        tableDepth++
        if (tableDepth === 1) {
          row = 0
          emit('\n\n', true)
        }
      } else if (tableDepth > 0) {
        tableDepth--
        if (tableDepth === 0) emit('\n\n', true)
      }
    } else if (name === 'tr' && tableDepth === 1) {
      if (!isClosing) {
        cells = 0
        emit('\n| ', true)
      } else {
        // 1 行目の後ろに区切り行を入れて、Markdown の表として読めるようにする
        if (row === 0 && cells > 0) emit(`\n|${' --- |'.repeat(cells)}`, true)
        row++
      }
    } else if ((name === 'td' || name === 'th') && isClosing && tableDepth > 0) {
      // 内側の表のセルは外側のセルの中身なので、区切りの | を出さない
      if (tableDepth === 1) cells++
      emit(tableDepth === 1 ? ' | ' : ' ')
    } else if (BLOCKS.has(name) && isClosing) {
      emit('\n\n')
    }
  }
  if (pre !== undefined) segments.push({ fence: pre.join('') })
  flushText()
  if (produced >= OUTPUT_BUDGET) segments.push({ text: '...（以降は省略）' })

  return segments
    .map((segment) => ('fence' in segment ? codeFence(segment.fence) : normalizeText(segment.text)))
    .filter((part) => part !== '')
    .join('\n\n')
}
