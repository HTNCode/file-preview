// ペインの Markdown を、ターミナルで読みやすい形に組み直す（純粋関数）。
// 描画は Claude の返答と同じ Markdown 要素に任せるが、その要素は
// - コードブロックに枠を付けない
// - 表をペインより広い幅で組み、狭いペインでは罫線が折り返して崩れる
// - 箇条書きの記号や見出しの大きさを変えられない
// ため、表示の前にここで書き換える。元のファイルの内容は変えない。

export type DisplayBlock = { kind: 'markdown' | 'code'; text: string }

// コードブロックを枠付きの箱にする数の上限。これを超えた分は箱にせず本文として描き、要素数が膨らみすぎないようにする
const MAX_CODE_BOXES = 100
const HEADING_MARKS = ['■', '□', '▸', '▸', '▸', '▸']

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
// `.` が U+2028 / U+2029 に当たらないと、末尾の `$` で失敗して空白と本文の長さの積だけ後戻りする。
// s フラグで `.` を行内のすべての文字に当て、1 回の照合で終わらせる
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/s
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/s
const ORDERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+(.*)$/s
const SEPARATOR_CELL = /^:?-+:?$/
// 縦並びにする列数の上限。列が極端に多い表で、行数 × 列数の処理と出力が膨らまないようにする
const MAX_COLUMNS = 50

/**
 * 字下げを全角スペースに置き換える。行頭の半角スペースのままだと、4 つ以上でコードブロックとして描かれるため。
 * 箇条書きの入れ子は 2 文字単位で字下げされる前提で、2 文字を 1 段とみなす
 */
function indent(whitespace: string): string {
  let width = 0
  for (const char of whitespace) width += char === '\t' ? 4 : 1
  return '　'.repeat(Math.floor(width / 2))
}

function transformLine(line: string): string {
  if (RULE.test(line)) return line
  const heading = HEADING.exec(line)
  if (heading !== null) {
    const hashes = heading[1] ?? '#'
    return `${hashes} ${HEADING_MARKS[hashes.length - 1] ?? '▸'} ${heading[2] ?? ''}`
  }
  const bullet = BULLET.exec(line)
  if (bullet !== null) return `${indent(bullet[1] ?? '')}・${bullet[2] ?? ''}`
  // 箇条書きを本文に変えたので、番号付きも番号を文字として残す（リストとして描くと番号が振り直される）
  const ordered = ORDERED.exec(line)
  if (ordered !== null) return `${indent(ordered[1] ?? '')}${ordered[2] ?? ''}\\${ordered[3] ?? '.'} ${ordered[4] ?? ''}`
  return line
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

/** 表を「列名: 値」の縦並びにする。行ごとに先頭の列を・で始め、行の間を空行で区切る */
export function tableToList(header: string[], rows: string[][]): string[] {
  const names = header.slice(0, MAX_COLUMNS).map((name, index) => (name === '' ? `列${index + 1}` : name))
  if (rows.length === 0) return [names.join(' / ')]
  const lines: string[] = []
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push('')
    names.forEach((name, column) => {
      const value = row[column] ?? ''
      if (column === 0) lines.push(`・${name}: ${value}`)
      else if (value !== '') lines.push(`　${name}: ${value}`)
    })
  })
  return lines
}

/** 開きフェンスに対応する閉じフェンスの行番号。閉じていなければ最後の行（CommonMark と同じく末尾まで続く） */
function findFenceEnd(lines: string[], start: number, marker: string): number {
  const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
  for (let i = start + 1; i < lines.length; i++) {
    if (close.test(lines[i] ?? '')) return i
  }
  return lines.length - 1
}

export function toDisplayBlocks(markdown: string): DisplayBlock[] {
  const lines = markdown.split('\n')
  const blocks: DisplayBlock[] = []
  let buffer: string[] = []
  let codeBoxes = 0
  const flush = () => {
    const text = buffer.join('\n').replace(/^\n+|\n+$/g, '')
    if (text !== '') blocks.push({ kind: 'markdown', text })
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE_OPEN.exec(line)
    if (fence !== null) {
      const end = findFenceEnd(lines, i, fence[1] ?? '```')
      const code = lines.slice(i, end + 1)
      if (codeBoxes < MAX_CODE_BOXES) {
        flush()
        blocks.push({ kind: 'code', text: code.join('\n') })
        codeBoxes++
      } else {
        buffer.push(...code)
      }
      i = end
      continue
    }
    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined && isTableSeparator(next) && !isTableSeparator(line)) {
      let end = i + 2
      while (end < lines.length && (lines[end] ?? '').includes('|') && (lines[end] ?? '').trim() !== '') end++
      buffer.push(...tableToList(splitRow(line), lines.slice(i + 2, end).map(splitRow)))
      i = end - 1
      continue
    }
    buffer.push(transformLine(line))
  }
  flush()
  return blocks
}
