/**
 * 折叠状态：把「已折叠容器集合」换算为虚拟滚动所需的可见行映射。
 *
 * 区间可能嵌套（先折叠子节点、再折叠其祖先）：只有最外层折叠区间对可见行
 * 有贡献——被已选祖先包含的子区间整段不可见，不得重复计入 hidden，
 * 否则 totalRows 会少算乃至归零（输出区白屏）。rebuild 因此只保留
 * 「互不包含」的最外层区间集合，lineAt 依赖该不变量做顺序累加。
 */
import type { FoldData } from '../worker/protocol'

interface Interval {
  start: number
  end: number
  hidden: number
}

export function foldIndexAt(folds: FoldData, line: number): number {
  let lo = 0
  let hi = folds.count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = folds.starts[mid]
    if (v === line) return mid
    if (v < line) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export class FoldState {
  private folds: FoldData | null = null
  private collapsed = new Set<number>()
  private intervals: Interval[] = []
  private hiddenTotal = 0

  /** 绑定新文档的折叠区间；清理在新文档中已失效的折叠行（行号尽力保持）。 */
  bind(folds: FoldData): void {
    this.folds = folds
    for (const s of [...this.collapsed]) {
      if (foldIndexAt(folds, s) < 0) this.collapsed.delete(s)
    }
    this.rebuild()
  }

  isCollapsed(line: number): boolean {
    return this.collapsed.has(line)
  }

  toggle(line: number): void {
    if (!this.folds) return
    if (this.collapsed.has(line)) this.collapsed.delete(line)
    else this.collapsed.add(line)
    this.rebuild()
  }

  private rebuild(): void {
    this.intervals = []
    this.hiddenTotal = 0
    if (!this.folds) return
    const starts = [...this.collapsed].sort((a, b) => a - b)
    let cur: Interval | null = null
    for (const s of starts) {
      const idx = foldIndexAt(this.folds, s)
      if (idx < 0) continue
      const e = this.folds.ends[idx]
      const hidden = Math.max(0, e - s)
      if (cur && e <= cur.end) {
        // 被当前最外层区间完全包含（或相同）：子节点整段已不可见，跳过
        continue
      }
      // 与当前区间部分重叠（折叠集合上不应出现，防御性截断）
      const it: Interval =
        cur && s <= cur.end ? { start: cur.end + 1, end: e, hidden: Math.max(0, e - cur.end - 1) } : { start: s, end: e, hidden }
      this.intervals.push(it)
      this.hiddenTotal += it.hidden
      cur = it
    }
  }

  totalRows(lineCount: number): number {
    return Math.max(0, lineCount - this.hiddenTotal)
  }

  /** 可见行号 → 真实行号 */
  lineAt(row: number): number {
    let line = row
    for (const it of this.intervals) {
      if (line > it.start) line += it.hidden
      else break
    }
    return line
  }
}
