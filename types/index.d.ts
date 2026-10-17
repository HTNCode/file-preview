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
  /** モデルのツールで開いたときの作業ディレクトリの実体。再読み込みでも、実体がこの配下にあるときだけ読む */
  within?: string
}

declare module 'claude-code' {
  interface PluginState {
    'file-preview': { doc: PreviewDoc | null; notice: string }
  }
}
