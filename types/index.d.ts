export type PreviewKind = 'markdown' | 'html' | 'url' | 'text'

export type PreviewShot = { file: string; generation: number }

export type PreviewDoc = {
  /** 絶対パス、または http(s) の URL */
  source: string
  kind: PreviewKind
  title: string
  /** Markdown 要素にそのまま渡す本文（HTML は変換済み） */
  markdown: string
  /** ローカルファイルの更新検知用。URL では 0 */
  mtimeMs: number
  shot?: PreviewShot
  /**
   * 許可確認を通らない呼び出し元（モデルのツール、利用者以外の /preview）が開いたときの、作業ディレクトリの実体。
   * 再読み込みと撮影でも、実体がこの配下にある文書のときだけ読む
   */
  within?: string
}

declare module 'claude-code' {
  interface PluginState {
    'file-preview': { doc: PreviewDoc | null; notice: string }
  }
}
