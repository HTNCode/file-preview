// ペインの Markdown を、ターミナルで読みやすい形に組み直す（純粋関数）。
// ターミナルの Markdown 要素は
// - コードブロックに枠を付けない
// - 表をペインより広い幅で組み、狭いペインでは罫線が折り返して崩れる
// - 箇条書きの記号や見出しの大きさを変えられない
// ため、表示の前にここで書き換える。元のファイルの内容は変えない。
// ターミナルは単独の改行をそのまま改行として描くので、書き換えた行は 1 行ずつ表示される前提にしている。

export type DisplayBlock = { kind: 'markdown' | 'code'; text: string }

// コードブロックを枠付きの箱にする数の上限。これを超えた分は箱にせず本文として描き、要素数が膨らみすぎないようにする
const MAX_CODE_BOXES = 100
// 組み直した結果の上限。表の縦並びは列名を行ごとに繰り返すので、元より膨らみうる。
// ペインのツリー全体で描かれるのは 10 万文字までなので、それを超えて作っても描かれない
const OUTPUT_BUDGET = 90_000
const TRUNCATED_NOTE = '...（以降は省略）'
const HEADING_MARKS = ['■', '□', '▸', '▸', '▸', '▸']

// 字下げの量は問わない。リストの中で字下げしたフェンスも、コードとして書き換えの対象から外すため
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/s
// `.` が U+2028 / U+2029 に当たらないと、末尾の `$` で失敗して空白と本文の長さの積だけ後戻りする。
// s フラグで `.` を行内のすべての文字に当て、1 回の照合で終わらせる
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/s
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/s
const ORDERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+(.*)$/s
const SEPARATOR_CELL = /^:?-+:?$/
// 縦並びにする列数と列名の長さの上限。極端な表で、行数 × 列数の処理と出力が膨らまないようにする
const MAX_COLUMNS = 50
const MAX_NAME_CHARS = 40

function indentWidth(line: string): number {
  let width = 0
  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4
    else break
  }
  return width
}

/**
 * 字下げを全角スペースに置き換える。行頭の半角スペースのままだと、4 つ以上でコードブロックとして描かれるため。
 * 箇条書きの入れ子は 2 文字単位で字下げされる前提で、2 文字を 1 段とみなす
 */
function indent(whitespace: string): string {
  return '　'.repeat(Math.floor(indentWidth(whitespace) / 2))
}

/** リストの行を・や文字の番号に書き換える。リストの行でなければ undefined */
function transformListItem(line: string): string | undefined {
  if (RULE.test(line)) return undefined
  const bullet = BULLET.exec(line)
  if (bullet !== null) return `${indent(bullet[1] ?? '')}・${bullet[2] ?? ''}`
  // 箇条書きを本文に変えたので、番号付きも番号を文字として残す（リストとして描くと番号が振り直される）
  const ordered = ORDERED.exec(line)
  if (ordered !== null) return `${indent(ordered[1] ?? '')}${ordered[2] ?? ''}\\${ordered[3] ?? '.'} ${ordered[4] ?? ''}`
  return undefined
}

function transformHeading(line: string): string | undefined {
  const heading = HEADING.exec(line)
  if (heading === null) return undefined
  const hashes = heading[1] ?? '#'
  return `${hashes} ${HEADING_MARKS[hashes.length - 1] ?? '▸'} ${heading[2] ?? ''}`
}

// 区切り行を 1 つの正規表現で判定すると、空白を分け合う量指定子で後戻りが 2 乗に膨らむため、セルごとに見る
function isTableSeparator(line: string): boolean {
  return line.includes('-') && line.includes('|') && splitRow(line).every((cell) => SEPARATOR_CELL.test(cell))
}

/** 表の 1 行をセルに分ける。`\|` はセルの区切りではなく文字の `|` */
export function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function columnName(header: string[], column: number): string {
  const name = header[column] ?? ''
  return name === '' ? `列${column + 1}` : name.slice(0, MAX_NAME_CHARS)
}

/**
 * 表を「列名: 値」の縦並びにする。行ごとに先頭の列を・で始め、行の間を空行で区切る。
 * 列名を行ごとに繰り返すので元より膨らみうる。budget 文字を超えたらそこで作るのをやめる
 */
export function tableToList(header: string[], rows: string[][], budget = Number.POSITIVE_INFINITY): string[] {
  if (rows.length === 0) {
    const names = header.slice(0, MAX_COLUMNS).map((_, column) => columnName(header, column))
    return [`・${names.join(' / ')}`]
  }
  const lines: string[] = []
  let produced = 0
  const add = (line: string) => {
    lines.push(line)
    produced += line.length + 1
  }
  for (let rowIndex = 0; rowIndex < rows.length && produced <= budget; rowIndex++) {
    const row = rows[rowIndex] ?? []
    if (rowIndex > 0) add('')
    // 見出しより多いセル（colspan など）も落とさないよう、行のセル数まで回す
    const columns = Math.min(MAX_COLUMNS, Math.max(1, row.length))
    for (let column = 0; column < columns; column++) {
      const value = row[column] ?? ''
      if (column === 0) add(`・${columnName(header, column)}: ${value}`)
      else if (value !== '') add(`　${columnName(header, column)}: ${value}`)
    }
  }
  return lines
}

/** 開きフェンスに対応する閉じフェンスの行番号。閉じていなければ最後の行（CommonMark と同じく末尾まで続く） */
function findFenceEnd(lines: string[], start: number, marker: string): number {
  const close = new RegExp(`^[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
  for (let i = start + 1; i < lines.length; i++) {
    if (close.test(lines[i] ?? '')) return i
  }
  return lines.length - 1
}

/** フェンスの字下げ分だけ各行の先頭の空白を外す。外さないと、字下げしたフェンスがインデントのコードとして描かれる */
function dedent(lines: string[], width: number): string[] {
  return lines.map((line) => {
    let removed = 0
    let index = 0
    while (index < line.length && removed < width) {
      const char = line[index]
      if (char === ' ') removed += 1
      else if (char === '\t') removed += 4
      else break
      index++
    }
    return line.slice(index)
  })
}

/** バッククォートのフェンスは info にバッククォートを含められない（行頭の ```inline``` はフェンスではない） */
function openFence(line: string): { indent: number; marker: string } | undefined {
  const fence = FENCE_OPEN.exec(line)
  if (fence === null) return undefined
  const marker = fence[2] ?? '```'
  if (marker[0] === '`' && (fence[3] ?? '').includes('`')) return undefined
  return { indent: indentWidth(fence[1] ?? ''), marker }
}

export function toDisplayBlocks(markdown: string): DisplayBlock[] {
  const lines = markdown.split('\n')
  const blocks: DisplayBlock[] = []
  let buffer: string[] = []
  let codeBoxes = 0
  let produced = 0
  // 直前までリストの中か。字下げ 4 以上の行は、リストの中なら入れ子の項目、外ならインデントのコードとして扱う
  let isInList = false

  const flush = () => {
    // 前後の空行は、改行を含まない行の配列のまま落とす。結合後に `/\n+$/` で削ると、空行が長く続く入力で2乗時間になる
    let start = 0
    let end = buffer.length
    while (start < end && buffer[start] === '') start++
    while (end > start && buffer[end - 1] === '') end--
    const text = buffer.slice(start, end).join('\n')
    if (text !== '') blocks.push({ kind: 'markdown', text })
    buffer = []
  }
  const push = (...added: string[]) => {
    for (const line of added) produced += line.length + 1
    buffer.push(...added)
  }

  for (let i = 0; i < lines.length; i++) {
    if (produced > OUTPUT_BUDGET) {
      push(TRUNCATED_NOTE)
      break
    }
    const line = lines[i] ?? ''
    const fence = openFence(line)
    if (fence !== undefined) {
      const end = findFenceEnd(lines, i, fence.marker)
      const code = dedent(lines.slice(i, end + 1), fence.indent)
      if (codeBoxes < MAX_CODE_BOXES) {
        flush()
        const text = code.join('\n')
        produced += text.length
        blocks.push({ kind: 'code', text })
        codeBoxes++
      } else {
        push(...code)
      }
      i = end
      continue
    }
    // インデントのコードは表より先に見る。中にパイプの表があっても書き換えない
    const width = indentWidth(line)
    if (width >= 4 && !isInList) {
      push(line)
      continue
    }
    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined && isTableSeparator(next) && !isTableSeparator(line)) {
      let end = i + 2
      while (end < lines.length && (lines[end] ?? '').includes('|') && (lines[end] ?? '').trim() !== '') end++
      push(...tableToList(splitRow(line), lines.slice(i + 2, end).map(splitRow), OUTPUT_BUDGET - produced))
      // 縦並びの最後の行の次の `---` も setext の見出しの下線になるので、空行で切り離す
      if (SETEXT_UNDERLINE.test(lines[end] ?? '')) push('')
      isInList = false
      i = end - 1
      continue
    }

    const item = transformListItem(line)
    if (item !== undefined) {
      push(item)
      isInList = true
      // `・b` の次の `---` は setext の見出しの下線になってしまうので、空行で切り離す
      if (next !== undefined && SETEXT_UNDERLINE.test(next)) push('')
      continue
    }
    if (line.trim() !== '' && width === 0) isInList = false
    if (isInList && width > 0) {
      // リスト項目の続きの段落。記号を・に変えてリストではなくなったので、半角の字下げのままだと
      // インデントのコードとして描かれる。項目と同じく全角の字下げにする
      const body = line.trimStart()
      push(`${indent(line.slice(0, line.length - body.length))}${body}`)
      continue
    }
    push(transformHeading(line) ?? line)
  }
  if (produced > OUTPUT_BUDGET && buffer.at(-1) !== TRUNCATED_NOTE) push(TRUNCATED_NOTE)
  flush()
  return blocks
}
