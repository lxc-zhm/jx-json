import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import type { ViewModel } from '../worker/protocol'
import { foldIndexAt, type FoldState } from './FoldState'
import { tokenizeLine, type Tok } from './tokens'

const ROW_H = 20
const OVERSCAN = 12
const ARROW_STEP = 10
const CONTENT_PAD = 18 // 首字符起点；保证各深度箭头 (d*10+2..+16) 均落在缩进区内不压正文

const decoder = new TextDecoder()

function getLine(model: ViewModel, i: number): string {
  let s = model.lineCache.get(i)
  if (s === undefined) {
    s = decoder.decode(model.output.subarray(model.lineStarts[i], model.lineEnds[i]))
    if (model.lineCache.size > 200_000) model.lineCache.clear() // 防重度滚动累积数百 MB
    model.lineCache.set(i, s)
  }
  return s
}

interface RowProps {
  row: number
  line: number
  model: ViewModel
  foldState: FoldState
  onToggle: (line: number) => void
}

function Row({ row, line, model, foldState, onToggle }: RowProps) {
  const fi = foldIndexAt(model.folds, line)
  const collapsed = fi >= 0 && foldState.isCollapsed(line)

  let toks: Tok[]
  if (fi >= 0 && collapsed) {
    const full = getLine(model, line)
    const opener = full.slice(-1) // '{' 或 '['（行末字符）
    const closer = opener === '{' ? '}' : ']'
    toks = tokenizeLine(full.slice(0, -1))
    toks.push(
      { text: opener, cls: 'punct' },
      { text: ' … ', cls: 'punct' },
      { text: closer, cls: 'punct' },
      { text: ` // ${model.folds.childCounts[fi]} 项`, cls: 'comment' },
    )
  } else {
    toks = tokenizeLine(getLine(model, line))
  }

  return (
    <div className="row" style={{ top: row * ROW_H }}>
      {fi >= 0 && (
        <button
          type="button"
          className="fold"
          style={{ left: Math.min(model.folds.depths[fi] * ARROW_STEP, CONTENT_PAD - 2) + 2 }}
          onClick={() => onToggle(line)}
          aria-label={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      )}
      <span className="line">
        {toks.map((t, k) => (
          <span key={k} className={`t-${t.cls}`}>
            {t.text}
          </span>
        ))}
      </span>
    </div>
  )
}

export function JsonViewer(props: {
  model: ViewModel | null
  foldState: FoldState
  onToggle: (line: number) => void
}) {
  const { model, foldState, onToggle } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(480)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // 折叠收起后总行数骤减：滚动位置可能超出内容高度，钳回可视范围（否则渲染空白）。
  // foldState 是可变对象（折叠切换靠 App 触发重渲染），故 effect 不设依赖、每次渲染后执行，成本可忽略。
  useEffect(() => {
    const el = containerRef.current
    if (!el || !model) return
    const contentH = foldState.totalRows(model.lineCount + 1) * ROW_H
    const maxScroll = Math.max(0, contentH - el.clientHeight)
    if (el.scrollTop > maxScroll) {
      el.scrollTop = maxScroll
      setScrollTop(el.scrollTop)
    }
  })

  if (!model) {
    return (
      <div className="viewer empty" ref={containerRef}>
        <span>等待输入…</span>
      </div>
    )
  }

  const totalRows = foldState.totalRows(model.lineCount + 1)
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)

  const rows = []
  for (let r = startRow; r < endRow; r++) {
    const line = foldState.lineAt(r)
    rows.push(<Row key={r} row={r} line={line} model={model} foldState={foldState} onToggle={onToggle} />)
  }

  return (
    <div className="viewer" ref={containerRef} onScroll={onScroll}>
      <div className="viewer-inner" style={{ height: totalRows * ROW_H }}>
        {rows}
      </div>
    </div>
  )
}
