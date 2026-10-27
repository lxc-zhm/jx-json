/** 格式化引擎：主线程侧的 Worker 编排（latest-wins 合并，避免任务排队堆积）。 */
import type { FormatDoneMsg, ViewModel, WorkerOut } from '../worker/protocol'

export interface FormatHandlers {
  onProgress: (ratio: number) => void
  onDone: (
    model: ViewModel,
    timing: {
      workerMs: number
      e2eMs: number
      inBytes: number
      stages?: Record<string, number>
      engine?: string
    },
  ) => void
  onError: (info: { message: string; line: number; column: number }) => void
}

interface Job {
  id: number
  t0: number
  inBytes: number
  buffer: ArrayBuffer
}

export class Formatter {
  private worker: Worker
  private busy = false
  private active: Job | null = null
  private pending: Job | null = null
  private seq = 0

  constructor(private h: FormatHandlers) {
    this.worker = new Worker(new URL('../worker/format.worker.ts?wasm1', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.handle(e.data)
  }

  format(text: string): void {
    const bytes = new TextEncoder().encode(text)
    const id = ++this.seq
    const job: Job = { id, t0: performance.now(), inBytes: bytes.length, buffer: bytes.buffer }
    if (this.busy) {
      this.pending = job // latest-wins：忙时只保留最新任务
    } else {
      this.send(job)
    }
  }

  private send(job: Job): void {
    this.busy = true
    this.active = job
    this.worker.postMessage({ type: 'format', id: job.id, bytes: job.buffer }, [job.buffer])
  }

  private handle(m: WorkerOut): void {
    if (m.type === 'progress') {
      if (this.active && m.id === this.active.id) this.h.onProgress(m.ratio)
      return
    }
    if (!this.active || m.id !== this.active.id) return
    const job = this.active
    this.busy = false
    this.active = null
    if (m.type === 'error') {
      this.h.onError({ message: m.message, line: m.line, column: m.column })
    } else {
      const done = m as FormatDoneMsg
      const model: ViewModel = {
        output: new Uint8Array(done.output, 0, done.outLen),
        outLen: done.outLen,
        lineStarts: new Uint32Array(done.lineStarts, 0, done.lineCount + 1),
        lineEnds: new Uint32Array(done.lineEnds, 0, done.lineCount + 1),
        lineCount: done.lineCount,
        folds: {
          starts: new Int32Array(done.fStart, 0, done.foldCount),
          ends: new Int32Array(done.fEnd, 0, done.foldCount),
          depths: new Uint8Array(done.fDepth, 0, done.foldCount),
          childCounts: new Int32Array(done.fChild, 0, done.foldCount),
          count: done.foldCount,
        },
        lineCache: new Map(),
      }
      this.h.onDone(model, {
        workerMs: done.elapsedMs,
        e2eMs: performance.now() - job.t0,
        inBytes: job.inBytes,
        stages: done.stages,
        engine: done.engine,
      })
    }
    const p = this.pending
    if (p) {
      this.pending = null
      this.send(p)
    }
  }

  dispose(): void {
    this.worker.terminate()
  }
}
