import { useCallback, useEffect, useRef, useState } from 'react'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { Formatter } from './engine/formatController'
import type { ViewModel } from './worker/protocol'
import { FoldState } from './viewer/FoldState'
import { JsonViewer } from './viewer/JsonViewer'
import './app.css'

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; ratio: number }
  | { kind: 'done'; workerMs: number; e2eMs: number; inBytes: number; outBytes: number; lines: number; stages?: string }
  | { kind: 'error'; message: string; line: number; column: number }

const SAMPLE = `{
  "app": "jx-json",
  "version": 1,
  "tags": ["json", "formatter", "viewer"],
  "nested": { "list": [1, 2, 3], "ok": true, "none": null, "ratio": -2.5 }
}`

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/** 统计 benchmark 样本行数 */
function countLines(text: string): number {
  let n = 1
  let i = text.indexOf('\n')
  while (i !== -1) {
    n++
    i = text.indexOf('\n', i + 1)
  }
  return n
}

export default function App() {
  const inputRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<EditorView | null>(null)
  const fmtRef = useRef<Formatter | null>(null)
  const debounceRef = useRef(0)
  const foldRef = useRef<FoldState>(new FoldState())
  const [model, setModel] = useState<ViewModel | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [inChars, setInChars] = useState(0)
  const [inLines, setInLines] = useState(1)

  useEffect(() => {
    const fmt = new Formatter({
      onProgress: (ratio) => setStatus({ kind: 'running', ratio }),
      onDone: (m, t) => {
        foldRef.current.bind(m.folds)
        setModel(m)
        const stages = t.stages
          ? `${t.engine ?? '?'} 核心 ${t.stages.format ?? 0}ms（扩容 ${t.stages.grow ?? 0} 拷入 ${t.stages.copyIn ?? 0} 拷出 ${t.stages.copyOut ?? 0}）`
          : (t.engine ? t.engine : undefined)
        setStatus({
          kind: 'done',
          workerMs: t.workerMs,
          e2eMs: t.e2eMs,
          inBytes: t.inBytes,
          outBytes: m.outLen,
          lines: m.lineCount + 1,
          stages,
        })
      },
      onError: (e) => {
        setModel(null)
        setStatus({ kind: 'error', message: e.message, line: e.line, column: e.column })
      },
    })
    fmtRef.current = fmt

    // 性能测试钩子：#bench=<url> 直接对 Worker 管线灌入样本（绕过 textarea 粘贴路径）
    const m = window.location.hash.match(/^#bench=(.+)$/)
    if (m) {
      fetch(m[1])
        .then((r) => r.text())
        .then((t) => {
          setInChars(t.length)
          setInLines(countLines(t))
          setStatus({ kind: 'running', ratio: 0 })
          fmt.format(t)
        })
        .catch((e) => setStatus({ kind: 'error', message: `样本载入失败: ${e.message}`, line: 0, column: 0 }))
    }
    return () => {
      window.clearTimeout(debounceRef.current)
      fmt.dispose()
    }
  }, [])

  const runNow = useCallback(() => {
    window.clearTimeout(debounceRef.current)
    const doc = editorRef.current?.state.doc
    const text = doc?.toString() ?? ''
    setInChars(text.length)
    setInLines(doc?.lines ?? 1)
    if (!text.trim()) {
      setModel(null)
      setStatus({ kind: 'idle' })
      return
    }
    setStatus({ kind: 'running', ratio: 0 })
    fmtRef.current?.format(text)
  }, [])

  const schedule = useCallback(() => {
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(runNow, 300)
  }, [runNow])

  useEffect(() => {
    const parent = inputRef.current
    if (!parent) return
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          placeholder('在此粘贴或输入 JSON 字符串，右侧自动美化…\n提示：大于 100MB 的文本建议使用文件方式载入（后续版本）。'),
          EditorView.contentAttributes.of({ 'aria-label': '输入（原始 JSON）', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            update.view.dom.classList.toggle('long-single-line', update.state.doc.lines === 1 && update.state.doc.length > 50000)
            setInChars(update.state.doc.length)
            schedule()
          }),
        ],
      }),
    })
    editorRef.current = editor
    return () => {
      editorRef.current = null
      editor.destroy()
    }
  }, [schedule])

  const onToggleFold = useCallback((line: number) => {
    foldRef.current.toggle(line)
    setStatus((s) => (s.kind === 'done' ? { ...s } : s)) // 触发重渲染
  }, [])

  const loadSample = useCallback(() => {
    const editor = editorRef.current
    if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: SAMPLE } })
    setInChars(SAMPLE.length)
    setInLines(countLines(SAMPLE))
    runNow()
  }, [runNow])

  const clearAll = useCallback(() => {
    const editor = editorRef.current
    if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } })
    window.clearTimeout(debounceRef.current)
    setInChars(0)
    setInLines(1)
    setModel(null)
    setStatus({ kind: 'idle' })
  }, [])

  const copyOut = useCallback(async () => {
    if (!model) return
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(model.output))
    } catch {
      window.alert('复制失败')
    }
  }, [model])

  return (
    <div className="app">
      <header>
        <h1>jx-json</h1>
        <span className="sub">JSON 格式化 · 折叠 · 虚拟滚动</span>
        <div className="toolbar">
          <button type="button" className="btn" onClick={runNow}>
            立即格式化
          </button>
          <button type="button" className="btn" onClick={loadSample}>
            载入示例
          </button>
          <button type="button" className="btn" onClick={copyOut} disabled={!model}>
            复制结果
          </button>
          <button type="button" className="btn" onClick={clearAll}>
            清空
          </button>
        </div>
      </header>

      <main className="main">
        <section className="pane">
          <div className="pane-head">
            <span>输入（原始 JSON）</span>
            <span className="dim">{inChars.toLocaleString()} 字符 · {inLines.toLocaleString()} 行</span>
          </div>
          <div className="input-wrap" ref={inputRef} />
        </section>

        <section className="pane">
          <div className="pane-head">
            <span>输出（只读 · 可折叠）</span>
          </div>
          {status.kind === 'error' ? (
            <div className="viewer empty error-box">
              <div>
                <p>✗ 解析失败：{status.message}</p>
                <p className="dim">
                  第 {status.line} 行，第 {status.column} 列
                </p>
              </div>
            </div>
          ) : (
            <JsonViewer model={model} foldState={foldRef.current} onToggle={onToggleFold} />
          )}
        </section>
      </main>

      <footer className="status">
        {status.kind === 'idle' && <span>等待输入</span>}
        {status.kind === 'running' && (
          <span>
            格式化中… {status.ratio > 0 ? `${Math.round(status.ratio * 100)}%` : ''}
          </span>
        )}
        {status.kind === 'done' && (
          <>
            <span className="ok">✓ 完成</span>
            <span>格式化 {status.workerMs.toFixed(0)} ms</span>
            <span>端到端 {status.e2eMs.toFixed(0)} ms</span>
            <span>
              {fmtBytes(status.inBytes)} → {fmtBytes(status.outBytes)}
            </span>
            <span>{status.lines.toLocaleString()} 行</span>
            {status.stages && <span className="dim">{status.stages}</span>}
          </>
        )}
        {status.kind === 'error' && (
          <span className="err">
            ✗ {status.message}（第 {status.line} 行，第 {status.column} 列）
          </span>
        )}
      </footer>
    </div>
  )
}
