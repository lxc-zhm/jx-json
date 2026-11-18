/**
 * 字节级单遍 JSON 宽松语法修复器（自动补全）。
 *
 * 仅在解析失败且用户开启「自动补全」时由 Worker 调用：扫描原始字节流，
 * 按宽松语法规则产出规范化 JSON 字节流（紧凑单行、不排版），随后交回
 * 现有 WASM 优先 / JS 回退管线重新解析。不回写输入编辑器。
 *
 * 修复规则：
 * - 空白、// 与 [>!--...-->]（块注释）、UTF-8 BOM：跳过
 * - 字符串：'…' / 中文智能引号统一为 "…"；非法转义反斜杠双写；裸 LF/CR/TAB
 *   与其余控制字符转义；EOF 未闭合补 "
 * - 字面量：True/False/None（忽略大小写）、NaN/Infinity → true/false/null；
 *   截断前缀（tru/fals/nul/non…，≥2 字符）按目标补全
 * - 裸词值/裸键（含 CJK）：加双引号
 * - 数字：按 JSON 数字语法裁剪到最长合法前缀（12.→12、1e→1），无合法前缀丢弃
 * - 缺失冒号/逗号补齐；尾随/冗余/悬挂逗号丢弃；空值位补 null
 * - EOF：按容器栈补 } / ]（值位先补 null）；首个顶层值完成后截断多余内容
 *
 * 性能：热循环零闭包（全部热状态为函数内局部变量，避免 V8 Context 分配）；
 * 输出缓冲倍增扩容；摊还 O(n) 单遍。结构同 reformat.ts（S_VALUE/S_KEY/S_AFTER
 * + OBJ/ARR 栈）。
 */

export interface RepairResult {
  /** 规范化后的 JSON 字节流（长度即有效字节数） */
  output: Uint8Array
  /** 修复处数（状态栏提示用） */
  fixes: number
}

const QUOTE = 34 // "
const APOS = 39 // '
const BACKSLASH = 92
const LF = 10
const CR = 13
const TAB = 9
const SPACE = 32
const COLON = 58
const COMMA = 44
const SLASH = 47
const LBRACK = 91
const RBRACK = 93
const LBRACE = 123
const RBRACE = 125
const SEMI = 59 // ;
const E2 = 0xe2 // 中文智能引号 UTF-8 首字节

const S_VALUE = 0
const S_KEY = 1
const S_AFTER = 2

const OBJ = 0
const ARR = 1

/** 模块级纯函数（无闭包），供热循环增长缓冲使用 */
function growU8(a: Uint8Array): Uint8Array<ArrayBuffer> {
  const nb = new Uint8Array(a.length * 2)
  nb.set(a)
  return nb
}

function isHexDigit(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 97 && b <= 102) || (b >= 65 && b <= 70)
}

/** 数字候选字符（JSON 数字语法涉及的全部字符） */
function isNumChar(b: number): boolean {
  return (b >= 48 && b <= 57) || b === 46 || b === 101 || b === 69 || b === 43 || b === 45
}

/** 位置 k 处是否为中文智能引号（“ ” ‘ ’）三字节序列 */
function isSmartQuoteAt(b: Uint8Array, k: number, n: number): boolean {
  return k + 2 < n && b[k] === E2 && b[k + 1] === 0x80 && (b[k + 2] === 0x9c || b[k + 2] === 0x9d || b[k + 2] === 0x98 || b[k + 2] === 0x99)
}

/** 裸词终止判定：空白、结构符、引号（含中文智能引号） */
function isWordStop(b: Uint8Array, k: number, n: number): boolean {
  const c = b[k]
  if (c === SPACE || c === TAB || c === LF || c === CR) return true
  if (c === COLON || c === COMMA || c === RBRACE || c === RBRACK || c === LBRACE || c === LBRACK) return true
  if (c === QUOTE || c === APOS) return true
  return isSmartQuoteAt(b, k, n)
}

/** [from,to) 与 ASCII 词 case-insensitive 全等 */
function wordEq(b: Uint8Array, from: number, to: number, s: string): boolean {
  const len = to - from
  if (len !== s.length) return false
  for (let k = 0; k < len; k++) {
    let c = b[from + k]
    if (c >= 65 && c <= 90) c += 32
    if (c !== s.charCodeAt(k)) return false
  }
  return true
}

/** [from,to)（≥2 字符且严格短于 s）是否为 s 的 case-insensitive 前缀 */
function wordIsPrefix(b: Uint8Array, from: number, to: number, s: string): boolean {
  const len = to - from
  if (len < 2 || len >= s.length) return false
  for (let k = 0; k < len; k++) {
    let c = b[from + k]
    if (c >= 65 && c <= 90) c += 32
    if (c !== s.charCodeAt(k)) return false
  }
  return true
}

/** JSON 数字语法下 [from,to) 内最长合法前缀的字节长度；无合法前缀返回 -1 */
function numPrefixLen(b: Uint8Array, from: number, to: number): number {
  let k = from
  if (b[k] === 45) k++ // -
  if (k >= to) return -1
  if (b[k] === 48) k++ // 0 不允许前导零
  else if (b[k] >= 49 && b[k] <= 57) while (k < to && b[k] >= 48 && b[k] <= 57) k++
  else return -1
  let best = k
  if (k < to && b[k] === 46) {
    let k2 = k + 1
    if (k2 < to && b[k2] >= 48 && b[k2] <= 57) {
      while (k2 < to && b[k2] >= 48 && b[k2] <= 57) k2++
      best = k2
      k = k2
    }
  }
  if (k < to && (b[k] === 101 || b[k] === 69)) {
    let k2 = k + 1
    if (k2 < to && (b[k2] === 43 || b[k2] === 45)) k2++
    if (k2 < to && b[k2] >= 48 && b[k2] <= 57) {
      while (k2 < to && b[k2] >= 48 && b[k2] <= 57) k2++
      best = k2
    }
  }
  return best - from
}

export function repairJson(input: Uint8Array): RepairResult {
  const n = input.length

  // ---- 输出缓冲（规范化 JSON 字节流，紧凑单行）----
  let outArr = new Uint8Array(n + (n >> 1) + (1 << 16))
  let outCap = outArr.length
  let outPos = 0

  // ---- 容器栈（类型）----
  let stackType = new Uint8Array(64)
  let stackCap = 64
  let depth = 0

  let i = 0
  // 剥离 UTF-8 BOM（与解析管线一致，不计修复）
  if (n >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) i = 3

  let state = S_VALUE
  let pendingComma = false // 下一个输出 token 前需先写 ','
  let afterColon = false // S_VALUE 紧跟冒号之后（空值位判定）
  let colonPending = false // 键已输出，等待 ':'
  let fixes = 0

  for (;;) {
    // ---- 跳过空白与注释 ----
    for (;;) {
      while (i < n) {
        const w = input[i]
        if (w === SPACE || w === TAB || w === LF || w === CR) i++
        else break
      }
      if (i + 1 < n && input[i] === SLASH && input[i + 1] === SLASH) {
        while (i < n && input[i] !== LF) i++ // 行注释：跳到行尾
        fixes++
        continue
      }
      if (i + 1 < n && input[i] === SLASH && input[i + 1] === 42) {
        i += 2
        while (i < n && !(input[i] === 42 && i + 1 < n && input[i + 1] === SLASH)) i++ // 块注释：跳到 */
        if (i < n) i += 2
        fixes++
        continue
      }
      break
    }

    if (i >= n) {
      // ---- EOF：截断补全 ----
      if (state === S_AFTER && depth === 0) break // 首个顶层值已完整
      if (colonPending) {
        // 键后无冒号即 EOF：补 ": null"
        if (outPos + 6 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COLON
        outArr[outPos++] = SPACE
        outArr[outPos++] = 110
        outArr[outPos++] = 117
        outArr[outPos++] = 108
        outArr[outPos++] = 108
        fixes += 2
        colonPending = false
        afterColon = false
      }
      if (state === S_VALUE && depth > 0) {
        if (afterColon) {
          // {"a": <EOF> → 空值位补 null
          if (outPos + 4 > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          outArr[outPos++] = 110
          outArr[outPos++] = 117
          outArr[outPos++] = 108
          outArr[outPos++] = 108
          fixes++
          afterColon = false
        } else if (pendingComma) {
          fixes++ // 尾随逗号丢弃
          pendingComma = false
        }
        // 其余（空容器 / 值已完整）直接闭合
      } else if (state === S_KEY && pendingComma) {
        fixes++ // 尾随逗号丢弃
        pendingComma = false
      }
      while (depth > 0) {
        // 按栈补 } / ]
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = stackType[depth - 1] === OBJ ? RBRACE : RBRACK
        depth--
        fixes++
      }
      break
    }

    const b0 = input[i]

    if (state === S_AFTER) {
      if (depth === 0) {
        fixes++ // 文档结束后多余内容 → 截断
        break
      }
      if (b0 === COMMA) {
        pendingComma = true
        afterColon = false
        state = stackType[depth - 1] === OBJ ? S_KEY : S_VALUE
        i++
        continue
      }
      if (b0 === RBRACE || b0 === RBRACK) {
        // 容器闭合（宽松：闭合符按栈顶类型规范化输出）
        i++
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = stackType[depth - 1] === OBJ ? RBRACE : RBRACK
        depth--
        state = S_AFTER
        pendingComma = false
        afterColon = false
        continue
      }
      // 其他 token：成员/元素之间缺逗号 → 补（交由 S_KEY/S_VALUE 分发同一 token）
      pendingComma = true
      fixes++
      afterColon = false
      state = stackType[depth - 1] === OBJ ? S_KEY : S_VALUE
    }

    if (colonPending) {
      // 键已输出：期待 ':'
      if (b0 === COLON) {
        i++
        colonPending = false
        if (outPos + 2 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COLON
        outArr[outPos++] = SPACE
        state = S_VALUE
        afterColon = true
        continue
      }
      // 缺失冒号 → 补 ': '，当前 token 留给 S_VALUE 分发
      colonPending = false
      if (outPos + 2 > outCap) {
        const grown = new Uint8Array(outArr.length * 2)
        grown.set(outArr.subarray(0, outPos))
        outArr = grown
        outCap = grown.length
      }
      outArr[outPos++] = COLON
      outArr[outPos++] = SPACE
      fixes++
      state = S_VALUE
      afterColon = true
    }

    if (state === S_KEY) {
      if (b0 === RBRACE) {
        if (pendingComma) fixes++ // 尾随逗号丢弃
        pendingComma = false
        i++
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = RBRACE
        depth--
        state = S_AFTER
        afterColon = false
        continue
      }
      if (b0 === COMMA) {
        if (pendingComma) fixes++ // 冗余逗号丢弃
        pendingComma = true
        afterColon = false
        i++
        continue
      }
      if (b0 === COLON || b0 === RBRACK || b0 === SEMI) {
        fixes++ // 键位的非法结构符丢弃
        i++
        continue
      }
      if (b0 === QUOTE || b0 === APOS || (b0 === E2 && isSmartQuoteAt(input, i, n))) {
        // ---- 键字符串（修复式扫描，见 S_VALUE 同型块）----
        if (pendingComma) {
          if (outPos + 1 > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          outArr[outPos++] = COMMA
          pendingComma = false
        }
        {
          let qKind: number
          if (b0 === QUOTE) {
            qKind = 0
            i++
          } else if (b0 === APOS) {
            qKind = 1
            i++
            fixes++ // 单引号 → 双引号
          } else {
            const t = input[i + 2]
            qKind = t === 0x98 || t === 0x99 ? 3 : 2
            i += 3
            fixes++ // 中文智能引号 → 双引号
          }
          let strFix = 0
          if (outPos + 1 > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          outArr[outPos++] = QUOTE
          for (;;) {
            if (outPos + 6 > outCap) {
              const grown = new Uint8Array(outArr.length * 2)
              grown.set(outArr.subarray(0, outPos))
              outArr = grown
              outCap = grown.length
            }
            if (i >= n) {
              outArr[outPos++] = QUOTE // EOF 未闭合补 "
              strFix++
              break
            }
            const c = input[i]
            if (qKind === 0 && c === QUOTE) {
              i++
              outArr[outPos++] = QUOTE
              break
            }
            if (qKind === 1 && c === APOS) {
              i++
              outArr[outPos++] = QUOTE
              break
            }
            if (qKind >= 2 && isSmartQuoteAt(input, i, n)) {
              const t3 = input[i + 2]
              if (qKind === 2 ? t3 === 0x9d || t3 === 0x9c : t3 === 0x99 || t3 === 0x98) {
                i += 3
                outArr[outPos++] = QUOTE
                break
              }
            }
            if (c === QUOTE && qKind !== 0) {
              // 单引号/智能引号串内的 " 转义
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = QUOTE
              strFix++
              i++
              continue
            }
            if (c === BACKSLASH) {
              const nx = i + 1 < n ? input[i + 1] : -1
              if (nx === QUOTE || nx === BACKSLASH || nx === SLASH || nx === 98 || nx === 102 || nx === 110 || nx === 114 || nx === 116) {
                // 合法转义 " \ / b f n r t 原样保留
                outArr[outPos++] = BACKSLASH
                outArr[outPos++] = nx
                i += 2
                continue
              }
              if (nx === 117 && i + 5 < n && isHexDigit(input[i + 2]) && isHexDigit(input[i + 3]) && isHexDigit(input[i + 4]) && isHexDigit(input[i + 5])) {
                // \uXXXX 原样保留
                outArr[outPos] = BACKSLASH
                outArr[outPos + 1] = 117
                outArr[outPos + 2] = input[i + 2]
                outArr[outPos + 3] = input[i + 3]
                outArr[outPos + 4] = input[i + 4]
                outArr[outPos + 5] = input[i + 5]
                outPos += 6
                i += 6
                continue
              }
              if (nx === -1) {
                // EOF 前孤立反斜杠：双写，随后由 EOF 分支补 "
                outArr[outPos++] = BACKSLASH
                outArr[outPos++] = BACKSLASH
                strFix++
                i++
                continue
              }
              // 非法转义 → 反斜杠双写
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = nx
              strFix++
              i += 2
              continue
            }
            if (c === LF) {
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = 110 // \n
              strFix++
              i++
              continue
            }
            if (c === CR) {
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = 114 // \r
              strFix++
              i++
              continue
            }
            if (c === TAB) {
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = 116 // \t
              strFix++
              i++
              continue
            }
            if (c < 0x20) {
              // 其余控制字符 → \u00XX
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = 117
              outArr[outPos++] = 48
              outArr[outPos++] = 48
              outArr[outPos++] = 48 + (c >> 4)
              const lo = c & 15
              outArr[outPos++] = lo < 10 ? 48 + lo : 87 + lo
              strFix++
              i++
              continue
            }
            outArr[outPos++] = c // 普通字节（含 UTF-8 多字节序列）原样复制
            i++
          }
          if (strFix) fixes++
        }
        colonPending = true
        continue
      }
      // ---- 裸键：读到 : , } ] { [ " ' 智能引号 或空白 ----
      let wj = i
      while (wj < n && !isWordStop(input, wj, n)) wj++
      if (wj === i) {
        fixes++ // 防御：停集字节开头，丢弃
        i++
        continue
      }
      if (pendingComma) {
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COMMA
        pendingComma = false
      }
      fixes++ // 裸键加引号
      {
        const worst = 2 + 6 * (wj - i)
        if (outPos + worst > outCap) {
          let size = outArr.length * 2
          if (size < outPos + worst) size = outPos + worst
          const grown = new Uint8Array(size)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = QUOTE
        let k = i
        while (k < wj) {
          const c = input[k]
          if (c === BACKSLASH) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = BACKSLASH
            k++
            continue
          }
          if (c === LF) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 110
            k++
            continue
          }
          if (c === CR) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 114
            k++
            continue
          }
          if (c === TAB) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 116
            k++
            continue
          }
          if (c < 0x20) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 117
            outArr[outPos++] = 48
            outArr[outPos++] = 48
            outArr[outPos++] = 48 + (c >> 4)
            const lo = c & 15
            outArr[outPos++] = lo < 10 ? 48 + lo : 87 + lo
            k++
            continue
          }
          outArr[outPos++] = c
          k++
        }
        outArr[outPos++] = QUOTE
      }
      i = wj
      colonPending = true
      continue
    }

    // ---- S_VALUE ----
    if (b0 === RBRACE || b0 === RBRACK) {
      if (depth > 0) {
        // 值位闭合符：空值位补 null / 尾随逗号丢弃后闭合（宽松：按栈顶类型输出）
        if (afterColon) {
          if (outPos + 4 > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          outArr[outPos++] = 110
          outArr[outPos++] = 117
          outArr[outPos++] = 108
          outArr[outPos++] = 108
          fixes++
          afterColon = false
        } else if (pendingComma) {
          fixes++
          pendingComma = false
        }
        i++
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = stackType[depth - 1] === OBJ ? RBRACE : RBRACK
        depth--
        state = S_AFTER
        pendingComma = false
        afterColon = false
        continue
      }
      fixes++ // 顶层游离闭合符丢弃
      i++
      continue
    }
    if (b0 === COMMA) {
      if (depth > 0) {
        // 值位逗号：空值位补 null（悬空的 ',' 视为分隔符）
        if (pendingComma) {
          if (outPos + 1 > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          outArr[outPos++] = COMMA
          pendingComma = false
        }
        if (outPos + 4 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = 110
        outArr[outPos++] = 117
        outArr[outPos++] = 108
        outArr[outPos++] = 108
        fixes++
        pendingComma = true
        state = stackType[depth - 1] === OBJ ? S_KEY : S_VALUE
      } else {
        fixes++ // 顶层悬挂逗号丢弃
      }
      afterColon = false
      i++
      continue
    }
    if (b0 === COLON || b0 === SEMI) {
      fixes++ // 值位的非法结构符丢弃
      i++
      continue
    }
    if (b0 === LBRACE || b0 === LBRACK) {
      if (pendingComma) {
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COMMA
        pendingComma = false
      }
      if (depth >= stackCap) {
        stackType = growU8(stackType)
        stackCap = stackType.length
      }
      if (outPos + 1 > outCap) {
        const grown = new Uint8Array(outArr.length * 2)
        grown.set(outArr.subarray(0, outPos))
        outArr = grown
        outCap = grown.length
      }
      outArr[outPos++] = b0
      stackType[depth] = b0 === LBRACE ? OBJ : ARR
      depth++
      state = b0 === LBRACE ? S_KEY : S_VALUE
      pendingComma = false
      afterColon = false
      i++
      continue
    }
    if (b0 === QUOTE || b0 === APOS || (b0 === E2 && isSmartQuoteAt(input, i, n))) {
      // ---- 值字符串（修复式扫描；逻辑与 S_KEY 键字符串块一致）----
      if (pendingComma) {
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COMMA
        pendingComma = false
      }
      {
        let qKind: number
        if (b0 === QUOTE) {
          qKind = 0
          i++
        } else if (b0 === APOS) {
          qKind = 1
          i++
          fixes++ // 单引号 → 双引号
        } else {
          const t = input[i + 2]
          qKind = t === 0x98 || t === 0x99 ? 3 : 2
          i += 3
          fixes++ // 中文智能引号 → 双引号
        }
        let strFix = 0
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = QUOTE
        for (;;) {
          if (outPos + 6 > outCap) {
            const grown = new Uint8Array(outArr.length * 2)
            grown.set(outArr.subarray(0, outPos))
            outArr = grown
            outCap = grown.length
          }
          if (i >= n) {
            outArr[outPos++] = QUOTE // EOF 未闭合补 "
            strFix++
            break
          }
          const c = input[i]
          if (qKind === 0 && c === QUOTE) {
            i++
            outArr[outPos++] = QUOTE
            break
          }
          if (qKind === 1 && c === APOS) {
            i++
            outArr[outPos++] = QUOTE
            break
          }
          if (qKind >= 2 && isSmartQuoteAt(input, i, n)) {
            const t3 = input[i + 2]
            if (qKind === 2 ? t3 === 0x9d || t3 === 0x9c : t3 === 0x99 || t3 === 0x98) {
              i += 3
              outArr[outPos++] = QUOTE
              break
            }
          }
          if (c === QUOTE && qKind !== 0) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = QUOTE
            strFix++
            i++
            continue
          }
          if (c === BACKSLASH) {
            const nx = i + 1 < n ? input[i + 1] : -1
            if (nx === QUOTE || nx === BACKSLASH || nx === SLASH || nx === 98 || nx === 102 || nx === 110 || nx === 114 || nx === 116) {
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = nx
              i += 2
              continue
            }
            if (nx === 117 && i + 5 < n && isHexDigit(input[i + 2]) && isHexDigit(input[i + 3]) && isHexDigit(input[i + 4]) && isHexDigit(input[i + 5])) {
              outArr[outPos] = BACKSLASH
              outArr[outPos + 1] = 117
              outArr[outPos + 2] = input[i + 2]
              outArr[outPos + 3] = input[i + 3]
              outArr[outPos + 4] = input[i + 4]
              outArr[outPos + 5] = input[i + 5]
              outPos += 6
              i += 6
              continue
            }
            if (nx === -1) {
              outArr[outPos++] = BACKSLASH
              outArr[outPos++] = BACKSLASH
              strFix++
              i++
              continue
            }
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = nx
            strFix++
            i += 2
            continue
          }
          if (c === LF) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 110
            strFix++
            i++
            continue
          }
          if (c === CR) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 114
            strFix++
            i++
            continue
          }
          if (c === TAB) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 116
            strFix++
            i++
            continue
          }
          if (c < 0x20) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 117
            outArr[outPos++] = 48
            outArr[outPos++] = 48
            outArr[outPos++] = 48 + (c >> 4)
            const lo = c & 15
            outArr[outPos++] = lo < 10 ? 48 + lo : 87 + lo
            strFix++
            i++
            continue
          }
          outArr[outPos++] = c
          i++
        }
        if (strFix) fixes++
      }
      state = S_AFTER
      pendingComma = false
      afterColon = false
      continue
    }
    if (b0 === 45 || (b0 >= 48 && b0 <= 57)) {
      // ---- 数字：扫描候选段后裁剪到最长合法前缀 ----
      let j = i
      while (j < n && isNumChar(input[j])) j++
      const plen = numPrefixLen(input, i, j)
      if (plen <= 0) {
        fixes++ // 残缺数字（如孤立的 -）整段丢弃
        i = j
        continue
      }
      // 裁剪残留判定：残留若能独立开启一个新数字（数字或 -数字）则留在输入流
      // （如 2-3 → 2,-3）；否则作为残缺尾部一并丢弃（如 12. 的 '.'、1e 的 'e'）
      let next = i + plen
      if (next < j) {
        const c = input[next]
        const startsNum = c >= 48 && c <= 57
        const startsNegNum = c === 45 && next + 1 < j && input[next + 1] >= 48 && input[next + 1] <= 57
        if (!startsNum && !startsNegNum) next = j
      }
      if (next > i + plen) fixes++ // 裁剪（12.→12、1e→1、1.2.3→1.2）
      if (pendingComma) {
        if (outPos + 1 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = COMMA
        pendingComma = false
      }
      if (outPos + plen > outCap) {
        let size = outArr.length * 2
        if (size < outPos + plen) size = outPos + plen
        const grown = new Uint8Array(size)
        grown.set(outArr.subarray(0, outPos))
        outArr = grown
        outCap = grown.length
      }
      let p = outPos
      for (let k = i; k < i + plen; k++) outArr[p++] = input[k]
      outPos = p
      i = next
      state = S_AFTER
      pendingComma = false
      afterColon = false
      continue
    }
    // ---- 裸词值：字面量识别 / 前缀补全 / 字符串化 ----
    let wj = i
    while (wj < n && !isWordStop(input, wj, n)) wj++
    if (wj === i) {
      fixes++ // 防御：停集字节开头，丢弃
      i++
      continue
    }
    if (pendingComma) {
      if (outPos + 1 > outCap) {
        const grown = new Uint8Array(outArr.length * 2)
        grown.set(outArr.subarray(0, outPos))
        outArr = grown
        outCap = grown.length
      }
      outArr[outPos++] = COMMA
      pendingComma = false
    }
    let lit = -1
    if (wordEq(input, i, wj, 'true')) lit = 0
    else if (wordEq(input, i, wj, 'false')) lit = 1
    else if (wordEq(input, i, wj, 'null') || wordEq(input, i, wj, 'none') || wordEq(input, i, wj, 'nan') || wordEq(input, i, wj, 'infinity')) lit = 2
    else if (wordIsPrefix(input, i, wj, 'true')) lit = 0
    else if (wordIsPrefix(input, i, wj, 'false')) lit = 1
    else if (wordIsPrefix(input, i, wj, 'null') || wordIsPrefix(input, i, wj, 'none')) lit = 2
    if (lit >= 0) {
      const exact = (lit === 0 && wordEq(input, i, wj, 'true')) || (lit === 1 && wordEq(input, i, wj, 'false')) || (lit === 2 && wordEq(input, i, wj, 'null'))
      if (!exact) fixes++ // 大小写规范化 / None、NaN、Infinity 映射 / 前缀补全
      if (lit === 0) {
        if (outPos + 4 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = 116
        outArr[outPos++] = 114
        outArr[outPos++] = 117
        outArr[outPos++] = 101
      } else if (lit === 1) {
        if (outPos + 5 > outCap) {
          let size = outArr.length * 2
          if (size < outPos + 5) size = outPos + 5
          const grown = new Uint8Array(size)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = 102
        outArr[outPos++] = 97
        outArr[outPos++] = 108
        outArr[outPos++] = 115
        outArr[outPos++] = 101
      } else {
        if (outPos + 4 > outCap) {
          const grown = new Uint8Array(outArr.length * 2)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = 110
        outArr[outPos++] = 117
        outArr[outPos++] = 108
        outArr[outPos++] = 108
      }
    } else {
      fixes++ // 裸词值 → 字符串
      {
        const worst = 2 + 6 * (wj - i)
        if (outPos + worst > outCap) {
          let size = outArr.length * 2
          if (size < outPos + worst) size = outPos + worst
          const grown = new Uint8Array(size)
          grown.set(outArr.subarray(0, outPos))
          outArr = grown
          outCap = grown.length
        }
        outArr[outPos++] = QUOTE
        let k = i
        while (k < wj) {
          const c = input[k]
          if (c === BACKSLASH) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = BACKSLASH
            k++
            continue
          }
          if (c === LF) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 110
            k++
            continue
          }
          if (c === CR) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 114
            k++
            continue
          }
          if (c === TAB) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 116
            k++
            continue
          }
          if (c < 0x20) {
            outArr[outPos++] = BACKSLASH
            outArr[outPos++] = 117
            outArr[outPos++] = 48
            outArr[outPos++] = 48
            outArr[outPos++] = 48 + (c >> 4)
            const lo = c & 15
            outArr[outPos++] = lo < 10 ? 48 + lo : 87 + lo
            k++
            continue
          }
          outArr[outPos++] = c
          k++
        }
        outArr[outPos++] = QUOTE
      }
    }
    state = S_AFTER
    pendingComma = false
    afterColon = false
    i = wj
  }

  return { output: outArr.subarray(0, outPos), fixes }
}
