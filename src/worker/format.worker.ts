/// 格式化 Worker：优先使用 WASM 核心（jx_core），加载失败或异常时回退纯 JS 实现。
/// 两条路径产出相同的 ViewModel 数据（输出字节 + 行偏移 + 折叠区间 typed arrays）。
/// 解析失败且请求「自动补全」时，先用宽松语法修复器（repair.ts）重写字节流，再重跑一次管线。
import { reformat } from './reformat'
import { repairJson } from './repair'
import type { WorkerOut } from './protocol'

const wasmUrl = new URL('./jx_core.wasm', import.meta.url)

interface WasmCore {
  instance: WebAssembly.Instance
  arenaBase: number
}

let core: WasmCore | null = null
let coreError = ''

async function loadCore(): Promise<WasmCore | null> {
  try {
    const resp = await fetch(wasmUrl)
    if (!resp.ok) throw new Error(`fetch ${resp.status}`)
    const bytes = await resp.arrayBuffer()
    const module = await WebAssembly.compile(bytes)
    const instance = new WebAssembly.Instance(module)
    const arenaBase = (instance.exports.jx_arena_base as () => number)()
    coreError = 'ok'
    return { instance, arenaBase }
  } catch (e) {
    coreError = `wasm加载失败: ${(e as Error).message}`
    return null // 回退 JS
  }
}

/** 用 WASM 核心格式化。失败返回 null（调用方回退 JS）。 */
function formatWasm(core: WasmCore, input: Uint8Array) {
  const { instance, arenaBase } = core
  const { jx_format, memory } = instance.exports as Record<string, any>
  const stages: Record<string, number> = {}
  const mark = (k: string, t0: number) => (stages[k] = Math.round(performance.now() - t0))
  // 预扩容：竞技场基址 + 输入 + 3.5 倍余量（输出+索引），内部 bump 仍可自动增长兜底
  let t0 = performance.now()
  const needPages = Math.ceil((arenaBase + input.length * 3.5 + (1 << 20)) / 65536)
  const curPages = memory.buffer.byteLength / 65536
  if (needPages > curPages) memory.grow(needPages - curPages)
  mark('grow', t0)
  t0 = performance.now()
  new Uint8Array(memory.buffer).set(input, arenaBase)
  mark('copyIn', t0)
  t0 = performance.now()
  const header = jx_format(arenaBase, input.length) as number
  mark('format', t0)
  ;(globalThis as any).__stages = stages
  const h = new Uint32Array(memory.buffer, header, 16)
  if (h[0] !== 0) {
    // 错误码 → 与 JS 版一致的文案
    const messages: Record<number, string> = {
      1: '意外的字符',
      2: '字符串未闭合',
      3: '字符串内包含非法换行',
      4: '输入意外结束（括号未闭合或值不完整）',
      5: '不允许的尾随逗号',
      6: 'JSON 文档结束后存在多余内容',
      7: '输入为空',
      8: '内存不足',
      9: '非法的数字',
      10: '非法的字面量（应为 true/false/null）',
    }
    // 行列：从输入区扫描（错误位置在 h[11]/h[12] 已换算为输入内行列）
    return { err: { message: messages[h[0]] ?? `解析错误(${h[0]})`, line: h[11], column: h[12] } }
  }
  t0 = performance.now()
  const mem = new Uint8Array(memory.buffer)
  const r = {
    ok: {
      output: mem.slice(h[1], h[1] + h[2]),
      lineStarts: new Uint32Array(memory.buffer, h[3], h[4]).slice(),
      lineEnds: new Uint32Array(memory.buffer, h[5], h[4]).slice(),
      lineCount: h[4] - 1,
      fStart: new Uint32Array(memory.buffer, h[6], h[10]).slice(),
      fEnd: new Uint32Array(memory.buffer, h[7], h[10]).slice(),
      fDepth: new Uint8Array(memory.buffer, h[8], h[10]).slice(),
      fChild: new Uint32Array(memory.buffer, h[9], h[10]).slice(),
      foldCount: h[10],
    },
  }
  mark('copyOut', t0)
  ;(globalThis as any).__stages.copyOut = stages.copyOut
  return r
}

/** 两条引擎路径的统一结果（done 消息所需字段已对齐） */
interface PipeOk {
  output: Uint8Array
  /** 有效输出字节数（js 回退的 output 是整个扩容缓冲区，真实长度在 outLen） */
  outLen: number
  lineStarts: Uint32Array
  lineEnds: Uint32Array
  lineCount: number
  fStart: Uint32Array | Int32Array
  fEnd: Uint32Array | Int32Array
  fDepth: Uint8Array
  fChild: Uint32Array | Int32Array
  foldCount: number
  engine: string
  stages?: Record<string, number>
  /** 自动补全成功时的修复处数 */
  repairFixes?: number
}

interface PipeErr {
  message: string
  line: number
  column: number
  engine: string
}

type PipeResult = ({ ok: true } & PipeOk) | ({ ok: false } & PipeErr)

/** WASM 优先 → JS 回退的完整管线（保持原有引擎选择与进度语义）。 */
function runPipeline(input: Uint8Array, jobId: number): PipeResult {
  let w: ReturnType<typeof formatWasm> | null = null
  if (core) {
    try {
      w = formatWasm(core, input)
    } catch (e) {
      coreError = `wasm执行失败: ${(e as Error).message}`
      w = null
      ;(globalThis as any).__stages = undefined
    }
  }
  if (w && 'ok' in w) {
    const r = w.ok
    return {
      ok: true,
      output: r.output,
      outLen: r.output.length,
      lineStarts: r.lineStarts,
      lineEnds: r.lineEnds,
      lineCount: r.lineCount,
      fStart: r.fStart,
      fEnd: r.fEnd,
      fDepth: r.fDepth,
      fChild: r.fChild,
      foldCount: r.foldCount,
      engine: 'wasm',
      stages: (globalThis as any).__stages ?? undefined,
    }
  }
  if (w && 'err' in w) {
    // WASM 解析错误：保持原行为直接返回错误（修复入口由 onmessage 统一处理）
    return { ok: false, message: w.err.message, line: w.err.line, column: w.err.column, engine: 'wasm' }
  }
  // JS 回退
  const res = reformat(input, {
    onProgress: (ratio) => ctx.postMessage({ type: 'progress', id: jobId, ratio: 0.01 + ratio * 0.99 }),
  })
  if (!res.ok) {
    return { ok: false, message: res.message, line: res.line, column: res.column, engine: `js(${coreError})` }
  }
  return {
    ok: true,
    output: res.output,
    outLen: res.outLen,
    lineStarts: res.lineStarts,
    lineEnds: res.lineEnds,
    lineCount: res.lineCount,
    fStart: res.folds.starts,
    fEnd: res.folds.ends,
    fDepth: res.folds.depths,
    fChild: res.folds.childCounts,
    foldCount: res.folds.count,
    engine: `js(${coreError})`,
  }
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void
}

let ready = loadCore()

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: 'format'; id: number; bytes: ArrayBuffer; repair?: boolean }
  if (msg.type !== 'format') return
  core = await ready
  const input = new Uint8Array(msg.bytes)
  const t0 = performance.now()

  // 进度：WASM 路径整体原子执行（无中途进度）；JS 路径同。
  // 发一次起步进度让 UI 进入 running 态即可。
  ctx.postMessage({ type: 'progress', id: msg.id, ratio: 0.01 })

  let r = runPipeline(input, msg.id)
  if (!r.ok && msg.repair) {
    // 解析失败且开启自动补全：宽松语法修复后重跑一次管线
    const rep = repairJson(input)
    r = runPipeline(rep.output, msg.id)
    if (r.ok) {
      r.repairFixes = rep.fixes
    } else {
      r.message = `自动补全后仍无法解析：${r.message}`
    }
  }
  if (r.ok) {
    ctx.postMessage(
      {
        type: 'done',
        id: msg.id,
        elapsedMs: performance.now() - t0,
        stages: r.stages,
        engine: r.engine,
        repaired: r.repairFixes,
        output: r.output.buffer,
        outLen: r.outLen,
        lineStarts: r.lineStarts.buffer,
        lineEnds: r.lineEnds.buffer,
        lineCount: r.lineCount,
        fStart: r.fStart.buffer,
        fEnd: r.fEnd.buffer,
        fDepth: r.fDepth.buffer,
        fChild: r.fChild.buffer,
        foldCount: r.foldCount,
      },
      [
        r.output.buffer,
        r.lineStarts.buffer,
        r.lineEnds.buffer,
        r.fStart.buffer,
        r.fEnd.buffer,
        r.fDepth.buffer,
        r.fChild.buffer,
      ],
    )
    return
  }
  ctx.postMessage({
    type: 'error',
    id: msg.id,
    message: r.message,
    line: r.line,
    column: r.column,
    engine: r.engine,
  })
}
