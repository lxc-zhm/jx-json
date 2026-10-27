/**
 * 字节级单遍 JSON 重排器（pretty-printer）。
 *
 * 不解析值：扫描 UTF-8 字节流，识别结构符与 token 边界，token 原样复制到输出
 * 缓冲，仅重排空白与缩进。数字保持原样（不丢精度），字符串不解码。
 * 校验覆盖结构（括号配对、token 边界、字符串闭合）与标量形状（数字语法、
 * true/false/null 精确匹配），与 WASM 核心（src-wasm）语义一致。
 *
 * 性能要点：热循环零闭包（所有热状态为函数内局部变量，避免 V8 Context
 * 分配导致无法寄存器化）；反斜杠/换行使用全文缓存指针，摊还 O(1)；
 * 短 token 手动拷贝，长 token 走 memcpy。
 */
import type { ReformatHooks, ReformatResult } from './protocol'

const QUOTE = 34
const BACKSLASH = 92
const LF = 10
const SPACE = 32
const COLON = 58
const COMMA = 44
const LBRACK = 91
const RBRACK = 93
const LBRACE = 123
const RBRACE = 125

const S_VALUE = 0
const S_KEY = 1
const S_AFTER = 2

const OBJ = 0
const ARR = 1

const PROGRESS_STEP = 4 << 20

/** JSON 数字语法：-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?；返回错误文案或 null */
function checkNumber(b: Uint8Array, from: number, to: number): string | null {
  let k = from
  if (b[k] === 45) k++ // -
  if (k >= to) return '非法的数字'
  if (b[k] === 48) k++ // 0 不允许前导零
  else if (b[k] >= 49 && b[k] <= 57) while (k < to && b[k] >= 48 && b[k] <= 57) k++
  else return '非法的数字'
  if (k < to && b[k] === 46) {
    k++
    if (k >= to || b[k] < 48 || b[k] > 57) return '非法的数字'
    while (k < to && b[k] >= 48 && b[k] <= 57) k++
  }
  if (k < to && (b[k] === 101 || b[k] === 69)) {
    k++
    if (k < to && (b[k] === 43 || b[k] === 45)) k++
    if (k >= to || b[k] < 48 || b[k] > 57) return '非法的数字'
    while (k < to && b[k] >= 48 && b[k] <= 57) k++
  }
  if (k !== to) return '非法的数字'
  return null
}

function isScalarStart(b: number): boolean {
  return (
    b === 45 || // -
    (b >= 48 && b <= 57) || // 0-9
    b === 116 || // t
    b === 102 || // f
    b === 110 // n
  )
}

function charDesc(b: number): string {
  const ch = String.fromCharCode(b)
  const code = b < 32 || b > 126 ? ` (U+${b.toString(16).padStart(4, '0')})` : ''
  return `'${ch}'${code}`
}

/** 模块级纯函数（无闭包），供热循环增长缓冲使用 */
function growU32(a: Uint32Array): Uint32Array<ArrayBuffer> {
  const nb = new Uint32Array(a.length * 2)
  nb.set(a)
  return nb
}

function growI32(a: Int32Array): Int32Array<ArrayBuffer> {
  const nb = new Int32Array(a.length * 2)
  nb.set(a)
  return nb
}

function growU8(a: Uint8Array): Uint8Array<ArrayBuffer> {
  const nb = new Uint8Array(a.length * 2)
  nb.set(a)
  return nb
}

export function reformat(input: Uint8Array, hooks?: ReformatHooks): ReformatResult {
  const n = input.length
  if (n === 0) return { ok: false, message: '输入为空', index: 0, line: 1, column: 1 }

  // ---- 输出缓冲 ----
  // 初始容量 = 1.5n + 64K，对典型输入免增长；增长时同步更新 outCap
  let outArr = new Uint8Array(n + (n >> 1) + (1 << 16))
  let outCap = outArr.length
  let outPos = 0

  // ---- 行内容字节范围：行 i = [starts[i], ends[i]) ----
  let starts = new Uint32Array(Math.max(4096, n >> 5))
  let ends = new Uint32Array(Math.max(4096, n >> 5))
  let lineCap = starts.length
  starts[0] = 0
  let lineCount = 0 // 当前行下标；总行数 = lineCount + 1

  // ---- 折叠区间：容器开启时追加（起始行天然升序），闭合时回填；单行容器作废并压缩 ----
  let fStart = new Int32Array(4096)
  let fEnd = new Int32Array(4096)
  let fDepth = new Uint8Array(4096)
  let fChild = new Int32Array(4096)
  let foldCap = 4096
  let foldCount = 0

  // ---- 容器栈 ----
  let stackType = new Uint8Array(256)
  let stackChild = new Int32Array(256)
  let stackOpenFold = new Int32Array(256)
  let stackCap = 256
  let depth = 0

  // ---- 反斜杠/换行全文缓存指针（摊还 O(1)）----
  let bsPos = -1
  let bsExhausted = false
  let lfPos = -1
  let lfExhausted = false

  let i = 0
  // 剥离 UTF-8 BOM
  if (n >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) i = 3

  let state = S_VALUE
  let pendingBreak = false // 下一个 token 前需先写换行+缩进（容器首子项或 ',' 之后）
  let afterComma = false

  let nextProgress = PROGRESS_STEP

  for (;;) {
    // 跳过空白（内联）
    while (i < n) {
      const w = input[i]
      if (w === 32 || w === 9 || w === 10 || w === 13) i++
      else break
    }

    if (i > nextProgress) {
      hooks?.onProgress?.(i / n)
      nextProgress = i + PROGRESS_STEP
    }

    if (i >= n) {
      if (state === S_AFTER && depth === 0) break
      return errAt(n, '输入意外结束（括号未闭合或值不完整）')
    }

    const b0 = input[i]

    if (state === S_AFTER) {
      if (b0 === COMMA && depth > 0) {
        // 逗号后必有子项：急切写逗号 + 换行缩进，省一轮循环
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COMMA
        if (lineCount + 1 >= lineCap) {
          starts = growU32(starts)
          ends = growU32(ends)
          lineCap = starts.length
        }
        ends[lineCount] = outPos
        const blen = 1 + depth * 2
        if (outPos + blen > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos] = LF
        for (let k = 1; k < blen; k++) outArr[outPos + k] = SPACE
        outPos += blen
        lineCount++
        starts[lineCount] = outPos - blen + 1
        afterComma = true
        pendingBreak = false
        state = stackType[depth - 1] === OBJ ? S_KEY : S_VALUE
        i++
      } else if ((b0 === RBRACE && depth > 0 && stackType[depth - 1] === OBJ) || (b0 === RBRACK && depth > 0 && stackType[depth - 1] === ARR)) {
        const lvl = depth - 1
        if (lineCount + 1 >= lineCap) {
          starts = growU32(starts)
          ends = growU32(ends)
          lineCap = starts.length
        }
        ends[lineCount] = outPos
        const blen = 1 + lvl * 2
        if (outPos + blen > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        const oarr = outArr
        oarr[outPos] = LF
        for (let k = 1; k < blen; k++) oarr[outPos + k] = SPACE
        outPos += blen
        lineCount++
        starts[lineCount] = outPos - blen + 1
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = b0
        // 回填折叠：多行容器记录结束行与子项数
        const fo = stackOpenFold[lvl]
        if (lineCount > fStart[fo]) {
          fEnd[fo] = lineCount
          fChild[fo] = stackChild[lvl]
        }
        depth--
        state = S_AFTER
        afterComma = false
        i++
      } else if (depth === 0) {
        return errAt(i, 'JSON 文档结束后存在多余内容')
      } else {
        return errAt(i, afterComma ? '不允许的尾随逗号' : `意外的字符 ${charDesc(b0)}`)
      }
    } else if (state === S_KEY) {
      if (b0 === RBRACE && !afterComma && depth > 0 && stackType[depth - 1] === OBJ) {
        // 空对象 {}：'{' 后直接闭合
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = RBRACE
        depth--
        const fo = stackOpenFold[depth]
        if (lineCount > fStart[fo]) {
          fEnd[fo] = lineCount
          fChild[fo] = stackChild[depth]
        }
        state = S_AFTER
        i++
      } else if (b0 === QUOTE) {
        // ---- 扫描键字符串（内联 scanStringEnd）----
        if (pendingBreak) {
          if (lineCount + 1 >= lineCap) {
            starts = growU32(starts)
            ends = growU32(ends)
            lineCap = starts.length
          }
          ends[lineCount] = outPos
          const blen = 1 + depth * 2
          if (outPos + blen > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          const oarr = outArr
          oarr[outPos] = LF
          for (let k = 1; k < blen; k++) oarr[outPos + k] = SPACE
          outPos += blen
          lineCount++
          starts[lineCount] = outPos - blen + 1
          pendingBreak = false
        }
        let end = -1
        {
          let j = i + 1
          for (;;) {
            const q = input.indexOf(QUOTE, j)
            if (lfExhausted) {
              // 无换行：只需处理转义
              const bs = bsExhausted ? -1 : bsPos >= j ? bsPos : ((bsPos = input.indexOf(BACKSLASH, j)), bsPos === -1 ? ((bsExhausted = true), -1) : bsPos)
              if (bs === -1 || (q !== -1 && bs > q)) {
                end = q
                break
              }
              j = bs + 2
              if (j > n) {
                end = -1
                break
              }
              continue
            }
            const lf = lfPos >= j ? lfPos : ((lfPos = input.indexOf(LF, j)), lfPos === -1 ? ((lfExhausted = true), -1) : lfPos)
            if (lf !== -1 && (q === -1 || lf < q)) {
              end = -2
              break
            }
            const bs = bsExhausted ? -1 : bsPos >= j ? bsPos : ((bsPos = input.indexOf(BACKSLASH, j)), bsPos === -1 ? ((bsExhausted = true), -1) : bsPos)
            if (bs === -1 || (q !== -1 && bs > q)) {
              end = q
              break
            }
            j = bs + 2
            if (j > n) {
              end = -1
              break
            }
          }
        }
        if (end === -1) return errAt(i, '字符串未闭合')
        if (end === -2) return errAt(i, '字符串内包含非法换行')
        {
          const from = i
          const to = end + 1
          const len = to - from
          if (outPos + len > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          if (len <= 16) {
            let p = outPos
            for (let k = from; k < to; k++) outArr[p++] = input[k]
            outPos = p
          } else {
            outArr.set(input.subarray(from, to), outPos)
            outPos += len
          }
        }
        stackChild[depth - 1]++
        i = end + 1
        while (i < n) {
          const w = input[i]
          if (w === 32 || w === 9 || w === 10 || w === 13) i++
          else break
        }
        if (i >= n || input[i] !== COLON) return errAt(i, "应为 ':'")
        if (outPos + 2 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos] = COLON
        outArr[outPos + 1] = SPACE
        outPos += 2
        i++
        state = S_VALUE
        afterComma = false
      } else {
        return errAt(i, afterComma ? '对象成员后缺少键（尾随逗号）' : `应为对象键，得到 ${charDesc(b0)}`)
      }
    } else {
      // S_VALUE
      if (b0 === RBRACK && !afterComma && depth > 0 && stackType[depth - 1] === ARR) {
        // 空数组 []：'[' 后直接闭合
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = RBRACK
        depth--
        const fo = stackOpenFold[depth]
        if (lineCount > fStart[fo]) {
          fEnd[fo] = lineCount
          fChild[fo] = stackChild[depth]
        }
        state = S_AFTER
        i++
      } else if (b0 === LBRACE || b0 === LBRACK) {
        if (pendingBreak) {
          if (lineCount + 1 >= lineCap) {
            starts = growU32(starts)
            ends = growU32(ends)
            lineCap = starts.length
          }
          ends[lineCount] = outPos
          const blen = 1 + depth * 2
          if (outPos + blen > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          const oarr = outArr
          oarr[outPos] = LF
          for (let k = 1; k < blen; k++) oarr[outPos + k] = SPACE
          outPos += blen
          lineCount++
          starts[lineCount] = outPos - blen + 1
          pendingBreak = false
        }
        afterComma = false
        if (depth >= stackCap) {
          stackType = growU8(stackType)
          stackChild = growI32(stackChild)
          stackOpenFold = growI32(stackOpenFold)
          stackCap = stackType.length
        }
        // 折叠占位（起始行 = 当前行）
        if (foldCount >= foldCap) {
          fStart = growI32(fStart)
          fEnd = growI32(fEnd)
          fDepth = growU8(fDepth)
          fChild = growI32(fChild)
          foldCap = fStart.length
        }
        fStart[foldCount] = lineCount
        fEnd[foldCount] = -1
        fDepth[foldCount] = depth < 255 ? depth : 255
        stackOpenFold[depth] = foldCount
        foldCount++

        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = b0
        stackType[depth] = b0 === LBRACE ? OBJ : ARR
        stackChild[depth] = 0
        depth++
        pendingBreak = true
        state = b0 === LBRACE ? S_KEY : S_VALUE
        i++
      } else if (b0 === QUOTE) {
        // ---- 值字符串（内联 scanStringEnd，同上）----
        if (pendingBreak) {
          if (lineCount + 1 >= lineCap) {
            starts = growU32(starts)
            ends = growU32(ends)
            lineCap = starts.length
          }
          ends[lineCount] = outPos
          const blen = 1 + depth * 2
          if (outPos + blen > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          const oarr = outArr
          oarr[outPos] = LF
          for (let k = 1; k < blen; k++) oarr[outPos + k] = SPACE
          outPos += blen
          lineCount++
          starts[lineCount] = outPos - blen + 1
          pendingBreak = false
        }
        let end = -1
        {
          let j = i + 1
          for (;;) {
            const q = input.indexOf(QUOTE, j)
            if (lfExhausted) {
              const bs = bsExhausted ? -1 : bsPos >= j ? bsPos : ((bsPos = input.indexOf(BACKSLASH, j)), bsPos === -1 ? ((bsExhausted = true), -1) : bsPos)
              if (bs === -1 || (q !== -1 && bs > q)) {
                end = q
                break
              }
              j = bs + 2
              if (j > n) {
                end = -1
                break
              }
              continue
            }
            const lf = lfPos >= j ? lfPos : ((lfPos = input.indexOf(LF, j)), lfPos === -1 ? ((lfExhausted = true), -1) : lfPos)
            if (lf !== -1 && (q === -1 || lf < q)) {
              end = -2
              break
            }
            const bs = bsExhausted ? -1 : bsPos >= j ? bsPos : ((bsPos = input.indexOf(BACKSLASH, j)), bsPos === -1 ? ((bsExhausted = true), -1) : bsPos)
            if (bs === -1 || (q !== -1 && bs > q)) {
              end = q
              break
            }
            j = bs + 2
            if (j > n) {
              end = -1
              break
            }
          }
        }
        if (end === -1) return errAt(i, '字符串未闭合')
        if (end === -2) return errAt(i, '字符串内包含非法换行')
        {
          const from = i
          const to = end + 1
          const len = to - from
          if (outPos + len > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          if (len <= 16) {
            let p = outPos
            for (let k = from; k < to; k++) outArr[p++] = input[k]
            outPos = p
          } else {
            outArr.set(input.subarray(from, to), outPos)
            outPos += len
          }
        }
        if (depth > 0 && stackType[depth - 1] === ARR) stackChild[depth - 1]++
        i = end + 1
        state = S_AFTER
        afterComma = false
      } else if (isScalarStart(b0)) {
        if (pendingBreak) {
          if (lineCount + 1 >= lineCap) {
            starts = growU32(starts)
            ends = growU32(ends)
            lineCap = starts.length
          }
          ends[lineCount] = outPos
          const blen = 1 + depth * 2
          if (outPos + blen > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          const oarr = outArr
          oarr[outPos] = LF
          for (let k = 1; k < blen; k++) oarr[outPos + k] = SPACE
          outPos += blen
          lineCount++
          starts[lineCount] = outPos - blen + 1
          pendingBreak = false
        }
        const from = i
        let j = i
        while (j < n) {
          const c = input[j]
          if (
            (c >= 48 && c <= 57) ||
            (c >= 97 && c <= 122) ||
            (c >= 65 && c <= 90) ||
            c === 45 ||
            c === 43 ||
            c === 46
          )
            j++
          else break
        }
        if (j === i) return errAt(i, afterComma ? '不允许的尾随逗号' : `意外的字符 ${charDesc(b0)}`)
        {
          const bad =
            b0 === 116 || b0 === 102 || b0 === 110
              ? !(
                (j - i === 4 && input[i] === 116 && input[i + 1] === 114 && input[i + 2] === 117 && input[i + 3] === 101) ||
                (j - i === 5 && input[i] === 102 && input[i + 1] === 97 && input[i + 2] === 108 && input[i + 3] === 115 && input[i + 4] === 101) ||
                (j - i === 4 && input[i] === 110 && input[i + 1] === 117 && input[i + 2] === 108 && input[i + 3] === 108)
              )
                ? '非法的字面量（应为 true/false/null）'
                : null
              : checkNumber(input, from, j)
          if (bad) return errAt(i, bad)
          const len = j - from
          if (outPos + len > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          let p = outPos
          for (let k = from; k < j; k++) outArr[p++] = input[k]
          outPos = p
        }
        if (depth > 0 && stackType[depth - 1] === ARR) stackChild[depth - 1]++
        i = j
        state = S_AFTER
        afterComma = false
      } else {
        return errAt(i, afterComma ? '不允许的尾随逗号' : `意外的字符 ${charDesc(b0)}`)
      }
    }
  }

  ends[lineCount] = outPos

  // 压缩无效折叠（单行容器），保持 starts 升序
  let w = 0
  for (let r = 0; r < foldCount; r++) {
    if (fEnd[r] < 0) continue
    if (w !== r) {
      fStart[w] = fStart[r]
      fEnd[w] = fEnd[r]
      fDepth[w] = fDepth[r]
      fChild[w] = fChild[r]
    }
    w++
  }

  return {
    ok: true,
    output: outArr,
    outLen: outPos,
    lineStarts: starts,
    lineEnds: ends,
    lineCount,
    folds: { starts: fStart, ends: fEnd, depths: fDepth, childCounts: fChild, count: w },
  }

  /** 错误位置换算（冷路径，允许闭包） */
  function errAt(at: number, message: string): ReformatResult {
    let line = 1
    let lineStart = 0
    const lim = Math.min(at, n)
    for (let k = 0; k < lim; k++) {
      if (input[k] === LF) {
        line++
        lineStart = k + 1
      }
    }
    return { ok: false, message, index: at, line, column: at - lineStart + 1 }
  }
}
