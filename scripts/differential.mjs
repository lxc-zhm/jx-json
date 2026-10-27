#!/usr/bin/env node
// 双引擎差分验证：WASM 核心（src-wasm） vs JS 参考实现（src/worker/reformat.ts）。
// 比较：输出字节、行起点/行终点、折叠区间数量与 childCounts、ok/err 判定。
// 用法：node scripts/differential.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { reformat } = await import(join(root, 'src/worker/reformat.ts'))
const wasmBytes = readFileSync(join(root, 'src-wasm/target/wasm32-unknown-unknown/release/jx_core.wasm'))
const mod = new WebAssembly.Module(wasmBytes)
const dec = new TextDecoder()

function runWasm(input) {
  const inst = new WebAssembly.Instance(mod)
  const { jx_format, jx_arena_base, memory } = inst.exports
  const inOff = jx_arena_base()
  const needPages = Math.ceil((inOff + input.length * 4 + (1 << 20)) / 65536)
  const curPages = memory.buffer.byteLength / 65536
  if (needPages > curPages) memory.grow(needPages - curPages)
  new Uint8Array(memory.buffer).fill(0)
  new Uint8Array(memory.buffer).set(input, inOff)
  const t0 = performance.now()
  try {
    const header = jx_format(inOff, input.length)
    const ms = performance.now() - t0
    const h = new Uint32Array(memory.buffer, header, 16)
    if (h[0] !== 0) return { err: h[0], line: h[11], col: h[12] }
    const mem = new Uint8Array(memory.buffer)
    return {
      out: mem.slice(h[1], h[1] + h[2]),
      starts: new Uint32Array(memory.buffer, h[3], h[4]),
      ends: new Uint32Array(memory.buffer, h[5], h[4]),
      folds: h[10],
      childCounts: Array.from(new Uint32Array(memory.buffer, h[9], h[10])),
      ms,
    }
  } catch {
    return { trap: true }
  }
}

function compare(name, input) {
  const js = reformat(input)
  const w = runWasm(input)
  if (w.trap) return `${name}: WASM TRAP`
  if (!js.ok && !w.out) return `${name}: both error (js @${js.line}:${js.column} | wasm code ${w.err} @${w.line}:${w.col})`
  if (js.ok && !w.out) return `${name}: JS ok, WASM err ${w.err} @${w.line}:${w.col}`
  if (!js.ok && w.out) return `${name}: WASM ok, JS err @${js.line}:${js.column}`
  const sameOut = w.out.length === js.outLen && w.out.every((v, i) => v === js.output[i])
  const nLines = js.lineCount + 1
  let sameStarts = true
  let sameEnds = true
  for (let i = 0; i < nLines; i++) {
    if (w.starts[i] !== js.lineStarts[i]) { sameStarts = false; break }
  }
  for (let i = 0; i < nLines; i++) {
    if (w.ends[i] !== js.lineEnds[i]) { sameEnds = false; break }
  }
  const sameFolds = w.folds === js.folds.count
  const sameChildren = sameFolds && w.childCounts.every((v, i) => v === js.folds.childCounts[i])
  const ok = sameOut && sameStarts && sameEnds && sameFolds && sameChildren
  return `${name}: ${ok ? 'PASS' : 'FAIL'} (out=${sameOut ? 'OK' : 'DIFF'} starts=${sameStarts ? 'OK' : 'DIFF'} ends=${sameEnds ? 'OK' : 'DIFF'} folds=${sameFolds ? 'OK' : 'DIFF'} children=${sameChildren ? 'OK' : 'DIFF'}) ${w.ms.toFixed(0)}ms lines=${nLines.toLocaleString()}`
}

const edge = [
  '{"a":"x\\ny\\t\\"q\\"\\\\","n":[1,-2.5,0.1],"b":true,"z":null,"e":{},"f":[],"nest":{"deep":[{},[]]}}',
  '[[],[{}],[[1]],[{"a":{}},[]],{}]',
  '  {  "a" : 1 , "b":[ 2 , {"c":3} ]  }  ',
  '[]',
  '{}',
  '"s"',
  '42',
  'true',
  'null',
  '[[[[[[{"a":[1]}]]]]]]',
  '{"a":"\\u00e9\\ud83d\\ude00"}',
  '﻿{"bom":true}',
  '{\r\n  "crlf": true\r\n}',
]
let fail = 0
for (const doc of edge) {
  const r = compare('edge:' + doc.slice(0, 24), new TextEncoder().encode(doc))
  console.log(r)
  if (!r.includes('PASS')) fail++
}
for (const f of ['sample-typical-10.json', 'sample-typical-100.json', 'sample-dense-30.json']) {
  try {
    const input = new Uint8Array(readFileSync(join(root, 'public', f)))
    const r = compare(f, input)
    console.log(r)
    if (!r.includes('PASS')) fail++
  } catch {
    console.log(`${f}: 样本不存在（npm run gen-sample 生成），跳过`)
  }
}
for (const n of [2844, 5000, 20000, 100000]) {
  const items = []
  for (let k = 0; k < n; k++) items.push(`{"id":${k},"name":"item ${k}","score":${(k * 7) % 100}.5,"tags":["a","bb"]}`)
  const r = compare('synthetic-n=' + n, new TextEncoder().encode('[' + items.join(',') + ']'))
  console.log(r)
  if (!r.includes('PASS')) fail++
}
console.log(fail === 0 ? '=== ALL PASS ===' : `=== ${fail} FAILURES ===`)
process.exit(fail === 0 ? 0 : 1)
