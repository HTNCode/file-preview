import { describe, expect, test } from 'claude-code/testing'

import { toDisplayBlocks } from '../hooks/display'
import { extractTitle, htmlToMarkdown } from '../hooks/html-to-markdown'
import { MAX_CHARS, docFromFile, docFromUrl, redactSource, sanitize, toFileUrl } from '../hooks/load'
import { hardenHtmlForScreenshot, screenshotArgv, shotKey, windowsBrowsers } from '../hooks/screenshot'

const PAGE = `<!doctype html><html><head><title>Hello &amp; Welcome</title><style>p{color:red}</style></head>
<body><h1>見出し</h1><p>本文 <strong>太字</strong> と <a href="/docs">リンク</a></p>
<ul><li>one</li><li>two</li></ul><pre>const a = 1 &lt; 2
  indented</pre><script>alert(1)</script></body></html>`

const PANE_PROPS = {
  title: 'Preview',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

describe('HTML から Markdown への変換', () => {
  test('見出し・強調・リンク・リスト・pre を変換し、script と style を落とす', async () => {
    const markdown = htmlToMarkdown(PAGE, 'https://example.com/a/')
    expect(markdown).toContain('# 見出し')
    expect(markdown).toContain('**太字**')
    expect(markdown).toContain('[リンク](https://example.com/docs)')
    expect(markdown).toContain('- one')
    expect(markdown).toContain('```\nconst a = 1 < 2\n  indented\n```')
    expect(markdown).not.toContain('alert')
    expect(markdown).not.toContain('color:red')
    expect(extractTitle(PAGE)).toBe('Hello & Welcome')
  })

  test('数値参照の 0x80〜0x9F は Windows-1252 の文字として読み、制御文字を残さない', async () => {
    expect(htmlToMarkdown('<p>It&#146;s &#150; &#129; &#0; &#xD800;</p>')).toBe('It’s – � � �')
    expect(sanitize('a\u0085b\u009fc', 'keep')).toBe('abc')
  })

  test('doctype は本文に出さない', async () => {
    expect(htmlToMarkdown('<!doctype html><?xml version="1.0"?><p>本文</p>')).toBe('本文')
  })

  test('番号付きリストと入れ子のリストを字下げして変換する', async () => {
    const markdown = htmlToMarkdown('<ul><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ul>')
    expect(markdown).toBe('- a\n  1. x\n  2. y\n\n- b')
  })

  test('表は区切り行付きの Markdown の表にし、セル内の | と改行を表の外に漏らさない', async () => {
    const markdown = htmlToMarkdown(
      '<table><tr><th>項目</th><th>値</th></tr><tr><td>a|b</td><td>1<br>2</td></tr></table>',
    )
    expect(markdown).toBe('| 項目 | 値 |\n| --- | --- |\n| a\\|b | 1 2 |')
  })

  test('ブロックを持つレイアウト用の表は、表にせず見出しやリストを保つ', async () => {
    const layout = htmlToMarkdown('<table><tr><td><h1>題</h1><p>説明</p><ul><li>a</li></ul></td><td>b</td></tr></table>')
    expect(layout).toContain('# 題')
    expect(layout).toContain('\n- a')
    expect(layout).toContain('\nb')
    expect(layout).not.toContain('---')
    expect(layout).not.toContain('|')
    const unclosed = htmlToMarkdown('<table><tr><td>x</td></tr><h1>題</h1><p>段落</p>')
    expect(unclosed).toContain('# 題')
    expect(unclosed).not.toContain('---')
  })

  test('セルを p で包んだデータの表は表のまま変換する', async () => {
    const markdown = htmlToMarkdown(
      '<table><tr><th><p>Operation</p></th><th><p>Result</p></th></tr><tr><td><p><code>x or y</code></p></td><td><div>if x</div></td></tr></table>',
    )
    expect(markdown).toBe('| Operation | Result |\n| --- | --- |\n| `x or y` | if x |')
  })

  test('データの表のセル内のリンクと画像の | で表を壊さない', async () => {
    const markdown = htmlToMarkdown(
      '<table><tr><th>h</th></tr><tr><td><a href="https://e.com/a|b">x</a><img alt="c|d"></td></tr></table>',
    )
    expect(markdown).toBe('| h |\n| --- |\n| [x](https://e.com/a%7Cb)[画像: c\\|d] |')
  })

  test('<ol start> と <li value> の番号を保つ', async () => {
    expect(htmlToMarkdown('<ol start="3"><li>c</li><li value="7">g</li><li>h</li></ol>')).toBe('3. c\n7. g\n8. h')
  })

  test('表が大量にあっても線形時間で終わる', async () => {
    const started = Date.now()
    htmlToMarkdown('<table><tr><td>a</td></tr></table><p>b</p>'.repeat(50_000))
    htmlToMarkdown('<table><td>'.repeat(100_000))
    htmlToMarkdown('<table_></table_>'.repeat(30_000))
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('リンク先の丸括弧はどちらもエンコードして Markdown のリンクを壊さない', async () => {
    expect(htmlToMarkdown('<a href="https://example.com/a(b)">説明</a>')).toBe('[説明](https://example.com/a%28b%29)')
  })

  test('Web の文書から file: のリンクを作らず、ホスト付きの file: はローカルからも作らない', async () => {
    expect(htmlToMarkdown('<a href="file:///etc/hosts">a</a>', 'https://example.com/')).toBe('a')
    expect(htmlToMarkdown('<a href="//evil.example/share/x.html">b</a>', 'file:///work/page.html')).toBe('b')
    expect(htmlToMarkdown('<a href="file:////evil.example/s/x">d</a>', 'file:///work/page.html')).toBe('d')
    expect(htmlToMarkdown('<a href="file://localhost//evil.example/s/x">e</a>', 'file:///work/page.html')).toBe('e')
    expect(htmlToMarkdown('<a href="other.html">c</a>', 'file:///work/page.html')).toBe('[c](file:///work/other.html)')
    const doc = docFromUrl('https://example.com/readme.md', '[x](file://evil.example/s) <file://evil.example/t>')
    expect(doc.markdown).toBe('[x](file：//evil.example/s) <file：//evil.example/t>')
  })

  test('制御文字・文字参照・エスケープ・タブを挟んだ file: も無効化する', async () => {
    const bypasses = [
      '[x](fi\u0001le://evil/s)',
      '[x](\u0007file://evil/s)',
      '[x](fi\u0085le://evil/s)',
      '[x](file\\://evil/s)',
      '[x]:\nfile://evil/s',
      '[x](< file://evil/s>)',
      '[x](<fi\tle://evil/s>)',
      '[x](&#102;ile://evil/s)',
      '[x](FIL&#x45;&colon;//evil/s)',
    ]
    for (const body of bypasses) {
      expect(docFromUrl('https://e.example/a.md', body).markdown).toContain('file：//evil/s')
    }
    const html = docFromUrl('https://e.example/a.html', '<p>[x](fi&#1;le://evil/s) [y](&amp;#102;ile://evil/s)</p>')
    expect(html.markdown).toBe('[x](file：//evil/s) [y](file：//evil/s)')
  })

  test('ローカルの文書ではローカルのパスの file: だけ残す', async () => {
    const md = docFromFile('/work/readme.md', '[a](file:///work/b.md) [x](file://evil/s) [y](file:////evil/s) [z](file:///%5C%5Cevil/s)', 1)
    expect(md.markdown).toBe('[a](file:///work/b.md) [x](file：//evil/s) [y](file：////evil/s) [z](file：///%5C%5Cevil/s)')
    const html = docFromFile('/work/page.html', '<p>[x](file://evil/s)</p><a href="b.html">b</a>', 1)
    expect(html.markdown).toContain('[b](file:///work/b.html)')
    expect(html.markdown).toContain('[x](file：//evil/s)')
    expect(docFromFile('/work/a.yml', 'file: x', 1).markdown).toContain('\nfile: x\n')
  })

  test('file: の無効化は細工した入力でも線形時間で終わる', async () => {
    const started = Date.now()
    docFromUrl('https://e.example/a.md', `&#${'0'.repeat(1_000_000)}`)
    docFromUrl('https://e.example/a.md', 'f\t'.repeat(500_000))
    docFromUrl('https://e.example/a.md', `f${'&tab;'.repeat(300_000)}`)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('pre の末尾の手前に改行が大量にあっても線形時間で終わる', async () => {
    const started = Date.now()
    expect(htmlToMarkdown(`<pre>${'\n'.repeat(200_000)}x</pre>`)).toBe(`\`\`\`\n${'\n'.repeat(199_999)}x\n\`\`\``)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('javascript: のリンクは文字だけ残す', async () => {
    expect(htmlToMarkdown('<a href="javascript:alert(1)">x</a>')).toBe('x')
  })

  test('コード内のエンティティはタグとして消さずに文字で残す', async () => {
    expect(htmlToMarkdown('<p><code>&lt;div&gt;</code></p>')).toBe('`<div>`')
  })

  test('Object のプロトタイプ名と同じ実体参照・タグ名を文字のまま扱う', async () => {
    expect(htmlToMarkdown('<constructor>a &constructor; b</constructor>')).toBe('a &constructor; b')
  })

  test('閉じない < が大量に続く入力でも線形時間で終わる', async () => {
    const started = Date.now()
    const markdown = htmlToMarkdown('<'.repeat(1_000_000))
    const unclosedTags = htmlToMarkdown('<a href="x'.repeat(100_000))
    const unclosedBlocks = htmlToMarkdown('<h1><script>'.repeat(100_000))
    expect(Date.now() - started).toBeLessThan(3000)
    expect(markdown.startsWith('<<<<')).toBe(true)
    expect(markdown.endsWith('...（以降は省略）')).toBe(true)
    expect(unclosedTags.length).toBeGreaterThan(0)
    expect(unclosedBlocks).toBe('#')
  })

  test('入れ子のリンクが深くても線形時間で終わる', async () => {
    const depth = 100_000
    const started = Date.now()
    const markdown = htmlToMarkdown(`${'<a href="/">'.repeat(depth)}${'x'.repeat(depth)}${'</a>'.repeat(depth)}`, 'https://e.com/')
    expect(Date.now() - started).toBeLessThan(3000)
    expect(markdown).toBe(`[${'x'.repeat(depth)}](https://e.com/)`)
  })

  test('本文に書かれた退避用の目印が pre の中身に化けない', async () => {
    const marker = '\u0000FENCE0\u0000'
    const markdown = htmlToMarkdown(`<pre>${'A'.repeat(1000)}</pre>${marker.repeat(1000)}`)
    expect(markdown.length).toBeLessThan(20_000)
    expect(markdown.startsWith(`\`\`\`\n${'A'.repeat(1000)}\n\`\`\``)).toBe(true)
  })

  test('長いベース URL と大量の相対リンクでも出力が膨らまない', async () => {
    const base = `https://e.com/${'p'.repeat(2000)}`
    const markdown = htmlToMarkdown('<a href="#x">x</a>'.repeat(100_000), base)
    expect(markdown.length).toBeLessThan(500_000)
    expect(markdown.endsWith('...（以降は省略）')).toBe(true)
    expect(htmlToMarkdown('<a href="#x">x</a>', `https://e.com/${'p'.repeat(3000)}`)).toBe('x')
  })

  test('属性値の中の > や < でタグを切らない', async () => {
    expect(htmlToMarkdown('<a title="1 > 0" href="/docs">リンク</a>', 'https://e.com/')).toBe('[リンク](https://e.com/docs)')
    expect(htmlToMarkdown("<a data-x='<b>' href=\"/d\">x</a>", 'https://e.com/')).toBe('[x](https://e.com/d)')
    expect(htmlToMarkdown('1 < 2 かつ 3 > 2')).toBe('1 < 2 かつ 3 > 2')
    expect(htmlToMarkdown(`<a title="see href='/wrong'" href="/right">リンク</a>`, 'https://e.com/')).toBe(
      '[リンク](https://e.com/right)',
    )
  })

  test('自己終了の svg の後ろの本文を失わない', async () => {
    expect(htmlToMarkdown('<svg/><h1>本文</h1>')).toBe('# 本文')
    expect(htmlToMarkdown('<svg viewBox="0 0 1 1" /><p>続き</p>')).toBe('続き')
  })

  test('小文字化で長さが変わる文字があっても後続の本文を失わない', async () => {
    const markdown = htmlToMarkdown(`<p>${'İ'.repeat(30)}</p><SCRIPT>x</SCRIPT><p>残す本文</p>`)
    expect(markdown).toContain('残す本文')
    expect(markdown).not.toContain('x')
    expect(extractTitle(`<p>${'İ'.repeat(30)}</p><TITLE>題名</TITLE>`)).toBe('題名')
  })

  test('閉じない引用符を含むタグが大量にあっても線形時間で終わる', async () => {
    const started = Date.now()
    htmlToMarkdown(`<a "${'<a x '.repeat(400_000)}`)
    htmlToMarkdown(`<a "<a '`.repeat(200_000))
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('出力が上限を超えたら打ち切る', async () => {
    const markdown = htmlToMarkdown('<p>x</p>'.repeat(500_000))
    expect(markdown.endsWith('...（以降は省略）')).toBe(true)
  })

  test('pre の中にバッククォートが大量にあってもフェンスが閉じない', async () => {
    const markdown = htmlToMarkdown(`<pre>${'````a'.repeat(200_000)}</pre>`)
    expect(markdown.startsWith('`````\n')).toBe(true)
  })
})

describe('パスと本文の扱い', () => {
  test('macOS と Windows のパスを file URL にする', async () => {
    expect(toFileUrl('/Users/me/a b.html')).toBe('file:///Users/me/a%20b.html')
    expect(toFileUrl('C:\\Users\\me\\a#1.html')).toBe('file:///C:/Users/me/a%231.html')
  })

  test('撮影はローカル HTML だけで、ブラウザの通信とスクリプトを止めて起動する', async () => {
    const argv = screenshotArgv('chrome', '/x/a.html', '/tmp/s.png', '/tmp/p')
    expect(argv).toContain('--proxy-server=http://127.0.0.1:9')
    expect(argv).toContain('--proxy-bypass-list=<-loopback>')
    expect(argv).toContain('--blink-settings=scriptEnabled=false')
    expect(argv.at(-1)).toBe('file:///x/a.html')
    expect(() => screenshotArgv('chrome', 'https://e.com/', '/tmp/s.png', '/tmp/p')).toThrow()
    expect(() => screenshotArgv('chrome', '\\\\server\\share\\a.html', '/tmp/s.png', '/tmp/p')).toThrow()
    expect(() => screenshotArgv('chrome', '//server/share/a.html', '/tmp/s.png', '/tmp/p')).toThrow()
  })

  test('撮影用コピーは CSP で読み込みを止め、元の meta と link を無効にする', async () => {
    const hardened = hardenHtmlForScreenshot(
      '<META http-equiv="refresh" content="0;url=file://evil/x"><link rel="prefetch" href="file://evil/y"><img src="file://evil/z">',
    )
    expect(hardened.startsWith('<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(hardened).toContain("default-src 'none'")
    expect(hardened).not.toContain('refresh')
    expect(hardened).not.toContain('prefetch')
    expect(hardened.match(/<meta\b/gi)).toHaveLength(2)
    expect(hardened.match(/<link\b/gi)).toBeNull()
    expect(hardened).toContain('<img src="file://evil/z">')
    expect(hardened).toContain("base-uri 'none'; form-action 'none'")
  })

  test('撮影用コピーは固定の DOCTYPE と CSP を必ず先頭に置き、元の DOCTYPE で位置をずらされない', async () => {
    const head = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'
    const attack = `<!DOCTYPE html PUBLIC 'x>'><img src="file://attacker.example/share/pixel.png">`
    expect(hardenHtmlForScreenshot(attack).startsWith(head)).toBe(true)
    expect(hardenHtmlForScreenshot(attack).endsWith(attack)).toBe(true)
    expect(hardenHtmlForScreenshot('<html><body>x</body></html>').startsWith(head)).toBe(true)
  })

  test('meta と link を取り除いても、ほかの要素の入れ子を変えない', async () => {
    const page =
      '<html><head><meta charset="utf-8"><link rel="stylesheet" href="a.css"><style>body>div{color:red}</style></head>' +
      '<body><div class="c">本文</div></body></html>'
    const hardened = hardenHtmlForScreenshot(page)
    expect(hardened).not.toMatch(/x-meta|x-link/i)
    expect(hardened).toContain('<html><head>  <style>body>div{color:red}</style></head><body><div class="c">本文</div></body></html>')
  })

  test('取り除いた跡が前後とつながって新しいタグにならない', async () => {
    const hardened = hardenHtmlForScreenshot('<<meta x>meta http-equiv="refresh" content="0;url=file://evil/x">')
    expect(hardened.match(/<meta\b/gi)).toHaveLength(2)
    expect(hardened).toContain('< meta http-equiv')
  })

  test('引用符内の > や閉じない meta でもタグを残さない', async () => {
    const quoted = hardenHtmlForScreenshot(`<meta content='a>b' http-equiv="refresh"><p>x</p>`)
    expect(quoted).not.toContain('refresh')
    expect(quoted.endsWith(' <p>x</p>')).toBe(true)
    const unclosed = hardenHtmlForScreenshot('<meta http-equiv="refresh" content="0;url=file://evil/x"')
    expect(unclosed.match(/<meta\b/gi)).toHaveLength(2)
    expect(unclosed).toContain('&lt;meta http-equiv')
    expect(hardenHtmlForScreenshot('<metadata>x</metadata>')).toContain('<metadata>x</metadata>')
  })

  test('どんな入力でも、先頭の 2 つ以外に生きた meta と link を残さない', async () => {
    const cases = [
      '<<meta x>meta http-equiv="refresh" content="0;url=file://evil/x">',
      `<meta a" http-equiv="refresh" content="0;url=file://evil/x>y" >`,
      '<!-- <meta x="--> <meta http-equiv=refresh content=0> "> -->',
      '<p title="<meta x=\'">\'<meta http-equiv=refresh content=0>\'>',
      `<meta${'"'.repeat(5)} http-equiv=refresh><LINK rel=prefetch href=//evil/y>`,
      `<meta ${'a'.repeat(9000)}>`,
      '<META\thttp-equiv=refresh content=0>',
      '<meta\nhttp-equiv=refresh content=0>',
    ]
    for (const input of cases) {
      const hardened = hardenHtmlForScreenshot(input)
      expect(hardened.match(/<meta(?=[\s/>]|$)/gi)).toHaveLength(2)
      expect(hardened.match(/<link(?=[\s/>]|$)/gi)).toBeNull()
    }
  })

  test('閉じない meta や引用符が大量にあっても線形時間で終わる', async () => {
    const started = Date.now()
    hardenHtmlForScreenshot('<meta "'.repeat(300_000))
    hardenHtmlForScreenshot(`<meta "${'<meta '.repeat(300_000)}`)
    hardenHtmlForScreenshot('<link'.repeat(400_000))
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('撮影画像のファイル名は対象ファイルごとに分かれる', async () => {
    expect(shotKey('/x/a.html')).not.toBe(shotKey('/x/b.html'))
    expect(shotKey('/x/a.html')).toBe(shotKey('/x/a.html'))
    expect(shotKey('/x/a.html')).toMatch(/^[0-9a-f]{8}$/)
  })

  test('Windows のブラウザ候補はどの場所でも Chrome を先に探し、Edge は最後の手段にする', async () => {
    const candidates = windowsBrowsers(['C:\\Program Files (x86)', 'C:\\Program Files', 'C:\\Users\\me\\AppData\\Local'])
    expect(candidates.slice(0, 3).every((path) => path.endsWith('\\Google\\Chrome\\Application\\chrome.exe'))).toBe(true)
    expect(candidates.slice(3).every((path) => path.endsWith('\\Microsoft\\Edge\\Application\\msedge.exe'))).toBe(true)
  })

  test('制御文字を落とし、CRLF を LF にする', async () => {
    expect(sanitize('a\r\nb\u0007c', 'keep')).toBe('a\nbc')
  })

  test('省略メッセージを含めても上限文字数を超えない', async () => {
    expect(sanitize('x'.repeat(MAX_CHARS), 'keep').length).toBe(MAX_CHARS)
    const cut = sanitize('x'.repeat(MAX_CHARS + 1), 'keep')
    expect(cut.length).toBe(MAX_CHARS)
    expect(cut.endsWith('先頭のみ表示）')).toBe(true)
  })

  test('応答に載せる URL から認証情報とクエリを外す', async () => {
    expect(redactSource('https://user:pw@example.com/a?token=SECRET#x')).toBe('https://example.com/a (クエリ等は省略)')
    expect(redactSource('https://example.com/a')).toBe('https://example.com/a')
    expect(redactSource('/local/path.md')).toBe('/local/path.md')
  })

  test('タイトルから制御文字を除き、長さを切る', async () => {
    const page = `<title>a\u001b[31mb\u0007\n\tc${'x'.repeat(1000)}</title>`
    const title = docFromFile('/x/page.html', page, 1).title
    expect(title.startsWith('a [31mb c')).toBe(true)
    expect(title.length).toBe(200)
  })

  test('拡張子に応じて種類を決める', async () => {
    expect(docFromFile('/x/readme.md', '# T', 1).kind).toBe('markdown')
    expect(docFromFile('C:\\x\\page.html', PAGE, 1).title).toBe('Hello & Welcome')
    expect(docFromFile('/x/main.ts', 'const a = 1', 1).markdown).toBe('```ts\nconst a = 1\n```')
  })
})

describe('ペインの表示用の組み直し', () => {
  test('見出しに記号を付け、箇条書きを・にし、番号は文字として残す', async () => {
    const blocks = toDisplayBlocks('# 題\n\n## 節\n\n- a\n    - b\n1. c\n\n---')
    expect(blocks).toEqual([{ kind: 'markdown', text: '# ■ 題\n\n## □ 節\n\n・a\n　　・b\n1\\. c\n\n---' }])
  })

  test('コードブロックは別のブロックにし、中身は書き換えない', async () => {
    const blocks = toDisplayBlocks('前\n```ts\n- not a list\n# not a heading\n```\n後')
    expect(blocks).toEqual([
      { kind: 'markdown', text: '前' },
      { kind: 'code', text: '```ts\n- not a list\n# not a heading\n```' },
      { kind: 'markdown', text: '後' },
    ])
  })

  test('表は「列名: 値」の縦並びにする', async () => {
    const blocks = toDisplayBlocks('| 名前 | 用途 | 必須 |\n| --- | :-: | --- |\n| A | x\\|y | |\n| B | z | 任意 |')
    expect(blocks).toEqual([
      { kind: 'markdown', text: '・名前: A\n　用途: x|y\n\n・名前: B\n　用途: z\n　必須: 任意' },
    ])
  })

  test('細工した行や表でも線形時間で終わる', async () => {
    const started = Date.now()
    toDisplayBlocks(`-${' '.repeat(50_000)}${'a'.repeat(50_000)}\u2028`)
    toDisplayBlocks(`# ${' '.repeat(50_000)}${'a'.repeat(50_000)}\u2029`)
    toDisplayBlocks(`a|b\n|${' '.repeat(100_000)}-${' '.repeat(100_000)}x`)
    toDisplayBlocks(`${'|'.repeat(50_000)}\n|-|\n${'a|\n'.repeat(25_000)}`)
    const blankRun = '\n'.repeat(89_000)
    expect(toDisplayBlocks(`a\n${blankRun}b`)).toEqual([{ kind: 'markdown', text: `a\n${blankRun}b` }])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('インデントのコードと、リスト内で字下げしたフェンスの中身は書き換えない', async () => {
    expect(toDisplayBlocks('段落\n\n    steps:\n      - uses: x')).toEqual([
      { kind: 'markdown', text: '段落\n\n    steps:\n      - uses: x' },
    ])
    expect(toDisplayBlocks('1. 設定する:\n\n    ```yaml\n    - uses: x\n    ```')).toEqual([
      { kind: 'markdown', text: '1\\. 設定する:' },
      { kind: 'code', text: '```yaml\n- uses: x\n```' },
    ])
  })

  test('行頭のインラインコードはフェンスとみなさず、リスト直後の --- は見出しにしない', async () => {
    expect(toDisplayBlocks('```a``` の書き方\n本文')).toEqual([{ kind: 'markdown', text: '```a``` の書き方\n本文' }])
    expect(toDisplayBlocks('- a\n---')).toEqual([{ kind: 'markdown', text: '・a\n\n---' }])
  })

  test('表の縦並びは見出しより多いセルも残し、出力を上限で打ち切る', async () => {
    expect(toDisplayBlocks('| h |\n| --- |\n| a | b |')).toEqual([{ kind: 'markdown', text: '・h: a\n　列2: b' }])
    const huge = `| ${'n'.repeat(20_000)} |\n| --- |\n${'| a |\n'.repeat(20_000)}`
    const text = toDisplayBlocks(huge).map((block) => block.text).join('')
    expect(text.length).toBeLessThan(100_000)
    expect(text.endsWith('...（以降は省略）')).toBe(true)
  })

  test('表の直後の --- を見出しにせず、インデントのコードの中の表は書き換えない', async () => {
    expect(toDisplayBlocks('| a |\n| - |\n| x |\n---')).toEqual([{ kind: 'markdown', text: '・a: x\n\n---' }])
    const code = '本文\n\n    a | b\n    --|--\n    1 | 2'
    expect(toDisplayBlocks(code)).toEqual([{ kind: 'markdown', text: code }])
  })

  test('リスト項目の続きの段落は全角で字下げし、インデントのコードにしない', async () => {
    expect(toDisplayBlocks('1. 手順\n\n    説明')).toEqual([{ kind: 'markdown', text: '1\\. 手順\n\n　　説明' }])
  })

  test('閉じていないコードブロックは末尾まで続く', async () => {
    expect(toDisplayBlocks('```\na\nb')).toEqual([{ kind: 'code', text: '```\na\nb' }])
  })
})

test('/preview でファイルを読み込み、ペインに描画する', async ($, on) => {
  on('fs.stat', async () => ({
    value: { kind: 'file', size: 3, mtimeMs: 10, isLink: false, realPath: '/work/readme.md' },
  }))
  on('fs.read', async () => ({ value: '# タイトル\n\n本文' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))

  const ran = await $.command.run({
    command: 'preview',
    args: 'readme.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toBe('プレビュー: /work/readme.md')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'file-preview',
      surface,
      component: 'Pane',
      requestId: 'file-preview',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ key: 'reload' })).toBeDefined()
    expect(await ui.find({ key: 'shot' })).toBeUndefined()
    await ui.unmount()
  }
})

test('モデルが呼ぶツールでは URL を取得しない', async ($, on) => {
  let fetched = 0
  on('http.fetch', async () => {
    fetched++
    return { value: { ok: true, status: 200, headers: {}, text: '<p>x</p>' } }
  })
  const called = await $.tool.call({ tool: 'mcp__file-preview__open', target: 'https://example.com/?q=1' })
  expect(called.deny).toContain('/preview')
  expect(fetched).toBe(0)
})

test('モデルが呼ぶツールではネットワークパスやスキーム付きの文字列を開かない', async ($, on) => {
  const statted: string[] = []
  on('fs.stat', async (_$, e) => {
    statted.push(e.path)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false, realPath: 'C:\\work\\a.md' } }
  })
  on('fs.read', async () => ({ value: '# a' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const targets = [
    '\\\\evil\\s\\a.md',
    '//evil/s/a.md',
    '"\\\\evil\\s\\a.md"',
    "' //evil/s/a.md '",
    '\\\\?\\UNC\\evil\\s\\a.md',
    '\\??\\UNC\\evil\\s\\a.md',
    'file://evil/s/a.md',
    'HTTPS://evil/a.md',
  ]
  for (const target of targets) {
    const called = await $.tool.call({ tool: 'mcp__file-preview__open', target })
    expect(called.deny).toContain('/preview')
  }
  expect(statted).toEqual([])
  const local = await $.tool.call({ tool: 'mcp__file-preview__open', target: 'C:\\work\\a.md' })
  expect(local.deny).toBeUndefined()
  expect(String(local.result)).toContain('in the preview pane')
  // ドライブ名はスキームとみなさずに通す（テストを動かす macOS では作業ディレクトリ基準の相対パスとして解決される）
  expect(statted.length).toBe(1)
  expect(statted[0]?.endsWith('C:\\work\\a.md')).toBe(true)
})

test('利用者以外から届いた /preview では URL を取得しない', async ($, on) => {
  let fetched = 0
  on('http.fetch', async () => {
    fetched++
    return { value: { ok: true, status: 200, headers: {}, text: '<p>x</p>' } }
  })
  const ran = await $.command.run({
    command: 'preview',
    args: 'https://example.com/',
    origin: { kind: 'peer-send-message' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('利用者が入力した /preview')
  expect(fetched).toBe(0)
})

test('制御文字を含むパスや長い URL でもペインを描く', async ($, on) => {
  on('fs.stat', async () => ({
    value: { kind: 'file', size: 3, mtimeMs: 10, isLink: false, realPath: '/work/a\u001b[31m.md' },
  }))
  on('fs.read', async () => ({ value: '# a' }))
  on('http.fetch', async () => ({ value: { ok: true, status: 200, headers: {}, text: '<p>x</p>' } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const mount = () =>
    $.ui.mount({ plugin: 'file-preview', surface: 'terminal', component: 'Pane', requestId: 'file-preview', props: PANE_PROPS })
  const run = (args: string) =>
    $.command.run({ command: 'preview', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  await run('a.md')
  const local = await mount()
  expect(await local.find({ type: 'Markdown' })).toBeDefined()
  await local.unmount()

  await run(`https://example.com/?q=${'a'.repeat(2100)}`)
  const remote = await mount()
  expect(await remote.find({ type: 'Markdown' })).toBeDefined()
  expect(await remote.find({ type: 'Link' })).toBeUndefined()
  await remote.unmount()
})

test('閉じるボタン（q）でペインを閉じる', async ($, on) => {
  on('fs.stat', async () => ({
    value: { kind: 'file', size: 3, mtimeMs: 10, isLink: false, realPath: '/work/readme.md' },
  }))
  on('fs.read', async () => ({ value: '# タイトル' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const closed: string[] = []
  on('ui.close', async (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })

  await $.command.run({
    command: 'preview',
    args: 'readme.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'file-preview',
      surface,
      component: 'Pane',
      requestId: 'file-preview',
      props: PANE_PROPS,
    })
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(closed).toEqual(['file-preview', 'file-preview'])
})
