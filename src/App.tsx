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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/** 分割线宽度 / 面板最小宽度 / 分割位置持久化 key */
const SPLIT_W = 6
const MIN_PANE_W = 280
const SPLIT_KEY = 'jx-split-ratio'

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
  const mainRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const editorRef = useRef<EditorView | null>(null)
  const fmtRef = useRef<Formatter | null>(null)
  const debounceRef = useRef(0)
  const foldRef = useRef<FoldState>(new FoldState())
  const [model, setModel] = useState<ViewModel | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [inChars, setInChars] = useState(0)
  const [inLines, setInLines] = useState(1)
  // 左侧输入面板占可用宽度的比例，随分割线拖动变化
  const [ratio, setRatio] = useState(() => {
    const saved = Number(window.localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(saved) && saved > 0.1 && saved < 0.9 ? saved : 0.5
  })

  /** 依据当前容器宽度把比例夹进两侧最小宽度允许的范围 */
  const clampRatio = useCallback((r: number) => {
    const rect = mainRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= SPLIT_W) return r
    const avail = rect.width - SPLIT_W
    const minPane = Math.min(MIN_PANE_W, rect.width * 0.45)
    const min = minPane / avail
    return Math.min(Math.max(r, min), 1 - min)
  }, [])

  const updateRatio = useCallback(
    (value: number | ((prev: number) => number)) => {
      setRatio((prev) => clampRatio(typeof value === 'function' ? value(prev) : value))
    },
    [clampRatio],
  )

  // 持久化分割位置；窗口变窄后把已保存比例夹回合法范围
  useEffect(() => {
    window.localStorage.setItem(SPLIT_KEY, String(ratio))
  }, [ratio])
  useEffect(() => {
    setRatio((r) => clampRatio(r))
  }, [clampRatio])

  const applySplit = useCallback(
    (clientX: number) => {
      const rect = mainRef.current?.getBoundingClientRect()
      if (rect) updateRatio((clientX - rect.left) / (rect.width - SPLIT_W))
    },
    [updateRatio],
  )

  const onSplitPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      draggingRef.current = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 指针已释放等场景下捕获失败可忽略 */
      }
      document.body.classList.add('splitting')
      applySplit(e.clientX)
    },
    [applySplit],
  )

  const onSplitPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) applySplit(e.clientX)
    },
    [applySplit],
  )

  const endSplitDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('splitting')
  }, [])

  const onSplitKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.05 : 0.02
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        updateRatio((r) => r - step)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        updateRatio((r) => r + step)
      } else if (e.key === 'Home') {
        e.preventDefault()
        updateRatio(0.5)
      }
    },
    [updateRatio],
  )

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
          placeholder('在此粘贴或输入 JSON 字符串，右侧自动美化…'),
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
        <span className="sub">JSON 美化</span>
        <div className="toolbar">
          <button type="button" className="btn" onClick={runNow}>
            立即格式化
          </button>
          <button type="button" className="btn" onClick={clearAll}>
            清空
          </button>
        </div>
      </header>

      <main className="main" ref={mainRef}>
        <section className="pane" style={{ flex: `0 0 calc((100% - ${SPLIT_W}px) * ${ratio})` }}>
          <div className="pane-head">
            <span>输入（原始 JSON）</span>
            <span className="dim">{inChars.toLocaleString()} 字符 · {inLines.toLocaleString()} 行</span>
          </div>
          <div className="input-wrap" ref={inputRef} />
        </section>

        <div
          className="split"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左右面板宽度"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          title="拖动调整宽度，双击恢复对半分"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={endSplitDrag}
          onPointerCancel={endSplitDrag}
          onKeyDown={onSplitKeyDown}
          onDoubleClick={() => updateRatio(0.5)}
        />

        <section className="pane">
          <div className="pane-head">
            <span>输出（只读 · 可折叠）</span>
            <button
              type="button"
              className="btn icon-btn"
              onClick={copyOut}
              disabled={!model}
              aria-label="复制结果"
              title="复制结果"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
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
