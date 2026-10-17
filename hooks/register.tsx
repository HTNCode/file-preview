import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsStat, Register } from 'claude-code'

import type { PreviewDoc, PreviewShot } from '../types'
import { toDisplayBlocks } from './display'
import { MAX_HREF_CHARS } from './html-to-markdown'
import {
  docFromFile,
  docFromUrl,
  isDocumentPath,
  isInsideRoot,
  isWebUrl,
  oneLine,
  redactSource,
  toFileUrl,
} from './load'
import {
  MAC_BROWSERS,
  VIEWPORT,
  hardenHtmlForScreenshot,
  isNetworkPath,
  screenshotArgv,
  shotKey,
  windowsBrowsers,
} from './screenshot'

// `$` は同じファイル内の関数にしか渡せないため、I/O を伴う処理はすべてこのファイルに置く
const PANE = 'file-preview'
const WATCH_INTERVAL_MS = 1500
const USAGE = '使い方: /preview <ファイルパス | http(s) URL>（.md / .html / その他テキスト）'
const MISSING_NOTICE = 'ファイルを読めません（削除・移動・権限変更の可能性）。表示は最後に読めた内容です'
// 撮影画像とブラウザプロファイルをセッションごとに分け、別セッションの撮影と衝突させない
const SESSION_TAG = crypto.randomUUID().slice(0, 8)

const docAtom = atom({ plugin: 'file-preview', key: 'doc' } as const, null)
const noticeAtom = atom({ plugin: 'file-preview', key: 'notice' } as const, '')
let isShooting = false
let isReloading = false
// 表示対象を開いた回数。遅れて終わった古い読み込みが、後から開いた対象の表示を上書きしないようにする。
// 再読み込みはこれを進めない（進めると、旧対象の自動更新が開きかけの新しい対象を取り消してしまう）
let openGeneration = 0
// $.fs.read が受け付ける上限（4 MiB）。読む前に弾いて、分かりやすい理由を返す
const MAX_FILE_BYTES = 4 * 1024 * 1024
// 利用者自身の入力にあたるコマンドの呼び出し元（端末、Remote Control、SDK のホスト）。これ以外（通知・別セッション・
// チャンネルなど）から届いた /preview は、モデルのツールと同じく作業ディレクトリの配下のファイルだけを開く
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
// 許可確認を通らない呼び出し元（モデルのツール、利用者以外の /preview）へ返す、失敗の文言。
// 理由ごとに変えると、応答からファイルの有無・種類・大きさを調べられる
const COULD_NOT_PREVIEW = 'Could not preview it.'
const COULD_NOT_PREVIEW_JA =
  'プレビューできませんでした。作業ディレクトリの外のファイルや URL は、利用者が入力した /preview で開いてください。'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unquote(args: string): string {
  return args.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
}

/**
 * モデルのツールで開けるのはローカルのパスだけにする。ネットワークパス（`\\host\share`、`//host/share`、
 * `\\?\UNC\...`）、NT の `\??\` 形式、スキーム付きの文字列（file: など）は拒否する。
 * Windows ではファイルの情報を読むだけで名前解決と SMB 接続が走り、DNS の問い合わせや認証情報の送信で値を持ち出せる。
 * スキームは 2 文字以上に限り、`C:\` のようなドライブ名は通す
 */
function isLocalPathSpelling(target: string): boolean {
  return !isNetworkPath(target) && !/^[\\/]\?\?[\\/]/.test(target) && !/^[a-z][a-z0-9+.-]+:/i.test(target)
}

async function loadUrl($: EngineInterface, target: string): Promise<PreviewDoc> {
  // 取得失敗の例外文には URL（クエリの秘密値を含み得る）が入り得るので、そのまま使わずに言い換える
  const response = await $.http.fetch(target).catch(() => {
    throw new Error('URL を取得できませんでした（ネットワークエラー、または取得ポリシーによる拒否）')
  })
  if (!response.ok) throw new Error(`URL の取得に失敗しました（HTTP ${response.status}）`)
  return docFromUrl(target, response.text)
}

/**
 * 対象を stat する。within（作業ディレクトリの実体）を渡したときは、許可確認を通らない呼び出し元が開いた
 * ものとして、実体が within の配下にある文書（Markdown・HTML・.txt）だけを通す。拡張子も実体のパスで見るので、
 * `a.md` という名前のリンクで設定ファイルや鍵を指しても開かない。
 * stat の時点で存在の確認とリンクの解決は済むが、呼び出し元への応答はどの失敗も同じ文言なので、外について分かることはない
 */
async function statForPreview($: EngineInterface, target: string, within?: string): Promise<FsStat> {
  const stat = await $.fs.stat(target, { resolve: true })
  if (within === undefined) return stat
  if (stat.realPath === undefined || !isInsideRoot(stat.realPath, within)) {
    throw new Error(`実体が作業ディレクトリの外です: ${target}`)
  }
  if (!isDocumentPath(stat.realPath)) throw new Error(`Markdown・HTML・.txt 以外は開けません: ${target}`)
  return stat
}

/** URL かローカルのファイルを読み込む。within は statForPreview を参照 */
async function loadPreview($: EngineInterface, target: string, within?: string): Promise<PreviewDoc> {
  if (isWebUrl(target)) return loadUrl($, target)
  const stat = await statForPreview($, target, within)
  if (stat.kind !== 'file') throw new Error(`ファイルではありません: ${target}`)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`ファイルが大きすぎます（4 MiB まで）: ${target}`)
  const absolute = stat.realPath ?? target
  const doc = docFromFile(absolute, await $.fs.read(absolute), stat.mtimeMs)
  return within === undefined ? doc : { ...doc, within }
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function findBrowser($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('FILE_PREVIEW_BROWSER')
  if (custom !== undefined && custom !== '') return custom
  const roots = [await $.env.get('ProgramFiles(x86)'), await $.env.get('ProgramFiles'), await $.env.get('LOCALAPPDATA')]
  const candidates = (await isWindows($))
    ? windowsBrowsers(roots.filter((root): root is string => root !== undefined && root !== ''))
    : MAC_BROWSERS
  for (const candidate of candidates) {
    if (await $.fs.exists(candidate)) return candidate
  }
  return undefined
}

async function takeScreenshot($: EngineInterface, source: string, within?: string): Promise<PreviewShot> {
  // 開いた後に対象が外を指すシンボリックリンクへ差し替えられても、開いたときと同じ範囲でしか読まない
  await statForPreview($, source, within)
  const browser = await findBrowser($)
  if (browser === undefined) {
    throw new Error('Chrome / Edge が見つかりません。環境変数 FILE_PREVIEW_BROWSER にブラウザのパスを設定してください')
  }
  const windows = await isWindows($)
  const sep = windows ? '\\' : '/'
  const dir = ((windows ? await $.env.get('TEMP') : await $.env.get('TMPDIR')) ?? '/tmp').replace(/[\\/]+$/, '')
  if (isNetworkPath(source)) throw new Error('ネットワーク上のファイルはスクリーンショットの対象外です')
  // 画像は対象ファイルごとに分ける。共通の 1 枚だと、別ファイルの撮影で表示中の画像が差し替わる
  const file = `${dir}${sep}file-preview-${SESSION_TAG}-${shotKey(source)}.png`
  // 元の HTML は直接開かず、外部読み込みを止めたコピーを撮る（理由は hardenHtmlForScreenshot を参照）
  const hardenedCopy = `${dir}${sep}file-preview-${SESSION_TAG}.html`
  await $.fs.write(hardenedCopy, hardenHtmlForScreenshot(await $.fs.read(source)))
  const argv = screenshotArgv(browser, hardenedCopy, file, `${dir}${sep}file-preview-profile-${SESSION_TAG}`)
  // 前回の撮影画像が残っていても今回の成功と取り違えないよう、撮影前後の更新日時を比べる
  const before = await $.fs.stat(file).catch(() => undefined)
  // ブラウザの stderr にはローカルパスや URL が混ざるため、利用者への表示には使わない
  const { exitCode } = await $.process.run(argv, { timeoutMs: 60_000 }).finally(() =>
    // 文書の写しを一時フォルダに残さない。$.fs に削除が無いので空にする
    $.fs.write(hardenedCopy, '').catch(() => undefined),
  )
  const written = await $.fs.stat(file).catch(() => undefined)
  const isFresh = written !== undefined && (before === undefined || written.mtimeMs > before.mtimeMs)
  if (exitCode !== 0 || !isFresh) {
    throw new Error(`スクリーンショットに失敗しました（ブラウザの終了コード ${exitCode}）`)
  }
  return { file, generation: await $.clock.now() }
}

async function setNotice($: EngineInterface, text: string): Promise<void> {
  await update($, noticeAtom, () => text)
}

/**
 * 作業ディレクトリ（セッションのプロジェクトのルート）の配下にあるファイルだけを開く。許可確認を通らない
 * 呼び出し元に使う（プロンプトインジェクションで外の鍵や設定ファイルをペインに出させない）。
 * シンボリックリンクで外へ出られないよう、対象もルートも実体のパスで比べる。
 * `$.session.cwd()` はシェルの cd で動くので使わない（cd 先へ範囲が移ったり、ルート直下が開けなくなったりする）
 */
async function showInsideRoot($: EngineInterface, target: string): Promise<void> {
  const root = (await $.fs.stat(await $.session.root(), { resolve: true })).realPath
  if (root === undefined) throw new Error('作業ディレクトリの実体を解決できません')
  await show($, target, root)
}

/**
 * 利用者以外から届いた /preview。応答は呼び出し元（別セッションのモデルなど）に返り、許可確認も通らないので、
 * モデルのツールと同じく開ける範囲を作業ディレクトリの配下に限り、失敗の理由と実体のパスを返さない
 */
async function previewForOthers($: EngineInterface, target: string): Promise<{ text: string }> {
  // ネットワークパスも、ファイルの情報を読むだけで外部へ接続しうるので URL と同じく利用者の入力に限る
  if (isWebUrl(target) || !isLocalPathSpelling(target)) {
    return { text: 'URL やネットワーク上のパスのプレビューは、利用者が入力した /preview だけで受け付けます。' }
  }
  try {
    await showInsideRoot($, target)
    return { text: `プレビュー: ${target}` }
  } catch (error) {
    $.ui.log(`file-preview: preview: ${errorText(error)}`, { to: 'debug' })
    return { text: COULD_NOT_PREVIEW_JA }
  }
}

async function show($: EngineInterface, target: string, within?: string): Promise<PreviewDoc> {
  const generation = ++openGeneration
  const doc = await loadPreview($, target, within)
  if (generation !== openGeneration) throw new Error('後から別の対象が開かれたため、この表示は取りやめました')
  await update($, docAtom, () => doc)
  await setNotice($, '')
  await $.ui.open({ id: PANE, title: doc.title.slice(0, 80) })
  return doc
}

async function reload($: EngineInterface): Promise<void> {
  // 読み込みが監視の周期より長引いても次を重ねない。重ねると先の結果が毎回捨てられ、表示が更新されなくなる。
  // 読み込み中にさらに保存されていれば、完了後の監視で更新日時の差を見て読み直す
  if (isReloading) return
  // 最初の await より前に立てる。後に立てると、同時に呼ばれた 2 件がどちらもこの検査を通ってしまう
  isReloading = true
  const generation = openGeneration
  try {
    const current = await read($, docAtom)
    if (current === null) return
    // 開いた後に対象が外を指すシンボリックリンクへ差し替えられても、開いたときと同じ範囲でしか読まない
    const next = await loadPreview($, current.source, current.within)
    // 読み込み中に別の対象が開かれていたら、旧対象の結果は捨てる
    if (generation !== openGeneration) return
    await update($, docAtom, (doc) => (doc?.source === current.source ? next : doc))
    await setNotice($, '')
  } catch (error) {
    if (generation === openGeneration) await setNotice($, `再読み込みに失敗: ${errorText(error)}`)
  } finally {
    isReloading = false
  }
}

async function shoot($: EngineInterface): Promise<void> {
  if (isShooting) return
  isShooting = true
  const generation = openGeneration
  try {
    const current = await read($, docAtom)
    if (current === null || current.kind !== 'html') return
    await setNotice($, 'スクリーンショットを撮影中...')
    try {
      const shot = await takeScreenshot($, current.source, current.within)
      // 撮影中に別の対象が開かれていたら（同じファイルを開き直した場合も含む）、古い撮影の結果を付けない
      if (generation !== openGeneration) return
      await update($, docAtom, (doc) => (doc === null || doc.source !== current.source ? doc : { ...doc, shot }))
      await setNotice($, '')
    } catch (error) {
      if (generation === openGeneration) await setNotice($, errorText(error))
    }
  } finally {
    isShooting = false
  }
}

/**
 * ボタンや監視の周期から待たずに走らせる処理の失敗を、未処理の reject にせず記録する。
 * 失敗の理由はペインの通知にも出しているので、ここではログに残すだけにする
 */
function runInBackground($: EngineInterface, task: Promise<void>): void {
  task.catch((error: unknown) => {
    $.ui.log(`file-preview: ${errorText(error)}`)
  })
}

/** ローカルファイルは更新日時を見て自動で再読み込みする（URL は対象外） */
async function watch($: EngineInterface): Promise<void> {
  const generation = openGeneration
  const current = await read($, docAtom)
  if (current === null || isWebUrl(current.source)) return
  try {
    const stat = await $.fs.stat(current.source)
    // stat を待つ間に別の対象が開かれていたら、旧対象の結果で通知を変えない
    if (generation !== openGeneration) return
    if (stat.mtimeMs !== current.mtimeMs) await reload($)
    else if ((await read($, noticeAtom)) === MISSING_NOTICE) await setNotice($, '')
  } catch {
    // 保存処理の一瞬の不在でも出るが、次の周期で読めれば上の分岐で消える
    if (generation !== openGeneration) return
    if ((await read($, noticeAtom)) !== MISSING_NOTICE) await setNotice($, MISSING_NOTICE)
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'preview',
      description: 'Markdown / HTML ファイルや URL をペインでプレビューする',
      argumentHint: '<path | url>',
    })
    await $.tool.register({
      name: 'open',
      description:
        'Show a local Markdown, HTML or .txt document in the preview pane of the user. ' +
        'Use when the user asks to preview or view a document. ' +
        'Only documents inside the working directory can be opened. ' +
        'For other files, URLs, network paths and files elsewhere, ask the user to run /preview themselves.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Absolute or relative path of a file inside the working directory' },
        },
        required: ['target'],
      },
    })
    $.clock.every(WATCH_INTERVAL_MS, () => runInBackground($, watch($)))
    return next(e)
  })

  on('command.run', { command: 'preview' }, async ($, e) => {
    const target = unquote(e.args)
    if (target === '') {
      if ((await read($, docAtom)) === null) return { text: USAGE }
      await $.ui.open({ id: PANE, title: 'Preview' })
      return { text: 'プレビューを開きました。' }
    }
    if (!USER_ORIGINS.has(e.origin.kind)) return previewForOthers($, target)
    try {
      const doc = await show($, target)
      return { text: `プレビュー: ${redactSource(doc.source)}` }
    } catch (error) {
      return { text: `プレビューできませんでした: ${errorText(error)}\n${USAGE}` }
    }
  })

  // 拒否の判断を持つフックなので .catch を付ける。無いと、持ち時間の超過や例外でフックが飛ばされ、
  // エンジンの既定の処理に進んでしまう
  on('tool.call', { tool: 'mcp__file-preview__open' }, async ($, e) => {
    // モデルの引数は e.input ではなく、tool や tool_use_id と並んでイベントの最上位に入る
    if (typeof e.target !== 'string' || e.target.trim() === '') {
      return { deny: 'target (local file path) is required' }
    }
    const target = unquote(e.target)
    // このフックはツールの結果を自分で返すため、エンジンの許可確認を通らない。
    // URL を受け付けると、確認なしに任意の宛先へ GET を送れてしまう（クエリに秘密値を載せた持ち出し、
    // ループバックやメタデータ宛ての SSRF）。URL の取得は利用者が打つ /preview に限る
    if (isWebUrl(target)) {
      return { deny: 'URLs cannot be opened by the model. Ask the user to run /preview <url> themselves.' }
    }
    if (!isLocalPathSpelling(target)) {
      return { deny: 'Only local file paths can be opened by the model. Ask the user to run /preview themselves.' }
    }
    // 開ける範囲は作業ディレクトリの配下に限る。外のファイルは利用者が /preview で開く。
    // 失敗は 1 つの文言にまとめ、成功にはモデルが渡した target だけを返す。開けたかどうかは伝わるが、範囲が
    // 作業ディレクトリの中なので、モデルがほかのツールで分かること以上は分からない。失敗の理由はデバッグログにだけ残す
    try {
      await showInsideRoot($, target)
      return { result: `Opened ${target} in the preview pane.` }
    } catch (error) {
      $.ui.log(`file-preview: open: ${errorText(error)}`, { to: 'debug' })
      return { deny: COULD_NOT_PREVIEW }
    }
  }).catch(($, _e, next) => {
    // ここに届くのは、持ち時間の超過か、上の try の外で起きたエンジン内部の例外。例外文の中身を選べず、
    // モデルへの応答に出してよいか判断できないので、理由はデバッグログにだけ残す。re-entry のときは `$` の呼び出しが拒否されるので記録しない
    if (next.error.kind !== 're-entry') $.ui.log(`file-preview: open: ${next.error.kind} ${next.error.message ?? ''}`, { to: 'debug' })
    // 時間切れも同じ文言にする。分けると、応答の遅いパス（ネットワーク上を指すリンクなど）を見分けられる
    return { deny: COULD_NOT_PREVIEW }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const doc = await read($, docAtom)
    const notice = await read($, noticeAtom)
    if (doc === null) return <Text dimColor>{USAGE}</Text>

    const columns = Math.max(10, Math.min(255, e.props.bodyColumns))
    const href = isWebUrl(doc.source) ? doc.source : toFileUrl(doc.source)
    // 撮影はローカル HTML だけ（URL は通信を遮断した撮影ができないため。screenshot.ts の説明を参照）
    const canShoot = doc.kind === 'html'
    // ターミナルのセルは縦横比がおよそ 2:1 なので、行数は幅の半分の比率で見積もる
    const imageRows = Math.max(4, Math.min(255, Math.round((columns * VIEWPORT.height) / VIEWPORT.width / 2)))
    // Image 要素はターミナルの要素表にしか無い
    let shotImage = undefined
    if (doc.shot !== undefined && e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      shotImage = (
        <Image
          key="shot-image"
          source={{ file: doc.shot.file, format: 'png', generation: doc.shot.generation }}
          columns={columns}
          rows={imageRows}
          alt="(この端末は画像表示に未対応です。kitty / Ghostty で表示できます)"
        />
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>{doc.title}</Text>
        <Text dimColor>{oneLine(doc.source)}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="reload" hotkey="r" onPress={() => runInBackground($, reload($))}>
            再読み込み
          </Button>
          {canShoot && (
            <Button key="shot" hotkey="s" onPress={() => runInBackground($, shoot($))}>
              スクリーンショット
            </Button>
          )}
          {href.length <= MAX_HREF_CHARS && <Link href={href} label="ブラウザで開く" />}
          <Button key="close" hotkey="q" role="dismiss" onPress={() => runInBackground($, $.ui.close({ id: PANE }))}>
            閉じる
          </Button>
        </Box>
        {/* 通知にはエラー文が入り、エラー文にはパスが入りうる */}
        {notice !== '' && <Text color="yellow">{oneLine(notice)}</Text>}
        {shotImage}
        {doc.markdown === '' ? (
          <Markdown text="(本文なし)" />
        ) : e.surface !== 'terminal' ? (
          // 組み直しはターミナルの描画の弱点を補うためのもの。ほかの面は Markdown をそのまま描ける
          <Markdown text={doc.markdown} />
        ) : (
          toDisplayBlocks(doc.markdown).map((block, index) =>
            block.kind === 'code' ? (
              <Box key={`code-${index}`} borderStyle="round" paddingX={1}>
                <Markdown text={block.text} />
              </Box>
            ) : (
              <Markdown key={`text-${index}`} text={block.text} />
            ),
          )
        )}
      </Box>
    )
  })
}
