/** Worker 与主线程之间的消息契约与查看器数据模型。 */

export interface FoldArrays {
  starts: Int32Array // 折叠起始行（容器开启行），升序
  ends: Int32Array // 折叠结束行（容器闭合行）
  depths: Uint8Array // 容器自身缩进层级（用于折叠箭头定位）
  childCounts: Int32Array // 直接子项数（对象成员数或数组元素数）
  count: number
}

export interface ReformatHooks {
  onProgress?: (ratio: number) => void
}

export type ReformatResult =
  | {
      ok: true
      output: Uint8Array
      outLen: number
      lineStarts: Uint32Array // 行 i 内容 = [lineStarts[i], lineEnds[i])
      lineEnds: Uint32Array
      lineCount: number // 最后一行的下标；总行数 = lineCount + 1
      folds: FoldArrays
    }
  | { ok: false; message: string; index: number; line: number; column: number }

// ---- Worker 消息 ----

export interface FormatRequest {
  type: 'format'
  id: number
  bytes: ArrayBuffer
}

export interface FormatProgressMsg {
  type: 'progress'
  id: number
  ratio: number
}

export interface FormatErrorMsg {
  type: 'error'
  id: number
  message: string
  line: number
  column: number
  engine?: string
}

export interface FormatDoneMsg {
  type: 'done'
  id: number
  elapsedMs: number
  stages?: Record<string, number>
  engine?: string
  output: ArrayBufferLike
  outLen: number
  lineStarts: ArrayBufferLike
  lineEnds: ArrayBufferLike
  lineCount: number
  fStart: ArrayBufferLike
  fEnd: ArrayBufferLike
  fDepth: ArrayBufferLike
  fChild: ArrayBufferLike
  foldCount: number
}

export type WorkerOut = FormatProgressMsg | FormatErrorMsg | FormatDoneMsg

// ---- 主线程查看器模型 ----

export interface FoldData {
  starts: Int32Array
  ends: Int32Array
  depths: Uint8Array
  childCounts: Int32Array
  count: number
}

export interface ViewModel {
  output: Uint8Array
  outLen: number
  lineStarts: Uint32Array // 行 i 内容 = [lineStarts[i], lineEnds[i])
  lineEnds: Uint32Array
  lineCount: number
  folds: FoldData
  /** 行文本按需解码缓存（可见行级） */
  lineCache: Map<number, string>
}
