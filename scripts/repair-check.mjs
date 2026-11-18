#!/usr/bin/env node
// 自动补全修复器用例（Node 级，直连 TS 模块，同 differential.mjs 方式）：
// - PRD 验收 fixture：截断 / 宽松语法 / 注释与转义 / 中文引号 / 双文档截断
// - 失败例：,,, 修复后仍无法解析
// - 恒等例：合法 JSON 经 repairJson 语义不变
// 用法：npm run repair:check
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { repairJson } = await import(join(root, 'src/worker/repair.ts'))
const { reformat } = await import(join(root, 'src/worker/reformat.ts'))

const enc = new TextEncoder()
const dec = new TextDecoder()

const MUST_FAIL = Symbol('must-fail')

let fail = 0
let pass = 0

function parseOut(r) {
  return JSON.parse(dec.decode(r.output.subarray(0, r.outLen)))
}

/** 修复 → 现有管线（JS 参考实现）重解析 → 断言语义 */
function check(name, input, expect) {
  const rep = repairJson(enc.encode(input))
  const r = reformat(rep.output)
  if (expect === MUST_FAIL) {
    if (r.ok) {
      fail++
      console.log(`✗ ${name}: 预期修复后仍失败，却解析成功 → ${dec.decode(r.output.subarray(0, r.outLen))}`)
    } else {
      pass++
      console.log(`✓ ${name}: 修复 ${rep.fixes} 处后仍失败（${r.message}）`)
    }
    return
  }
  if (!r.ok) {
    fail++
    console.log(`✗ ${name}: 修复(${rep.fixes})后解析失败：${r.message} @${r.line}:${r.column}`)
    return
  }
  let v
  try {
    v = parseOut(r)
  } catch (e) {
    fail++
    console.log(`✗ ${name}: 修复输出非法 JSON：${e.message} → ${dec.decode(r.output.subarray(0, r.outLen))}`)
    return
  }
  const got = JSON.stringify(v)
  if (typeof expect === 'function') {
    if (!expect(v)) {
      fail++
      console.log(`✗ ${name}: 自定义断言不成立，得到 ${got}`)
    } else {
      pass++
      console.log(`✓ ${name}: 修复 ${rep.fixes} 处 → ${got}`)
    }
    return
  }
  const want = JSON.stringify(expect)
  if (got !== want) {
    fail++
    console.log(`✗ ${name}: 期望 ${want}，得到 ${got}`)
  } else {
    pass++
    console.log(`✓ ${name}: 修复 ${rep.fixes} 处 → ${got}`)
  }
}

console.log('--- 截断补全 ---')
check('截断·嵌套容器', '{"a": {"b": [1, 2', { a: { b: [1, 2] } })
check('截断·字符串', '{"name": "abc', { name: 'abc' })
check('截断·字面量 tru', '{"a": tru', { a: true })
check('截断·尾逗号', '[1, 2,', [1, 2])
check('截断·文档后拖尾文字', '{"a": 1, "b": 2}, 拖尾文字', { a: 1, b: 2 })
check('截断·空对象', '{', {})
check('截断·空数组', '[', [])
check('截断·空值位 EOF', '{"a":', { a: null })
check('截断·键后 EOF', '{"a"', { a: null })
check('截断·单引号+未闭合', "{'k': 'v", { k: 'v' })

console.log('--- 宽松语法 ---')
check('宽松·裸键', '{name: 1}', { name: 1 })
check('宽松·单引号值', `{a: 'x', b: "y"}`, { a: 'x', b: 'y' })
check('宽松·Python 字面量', `{'中文': True, "n": None}`, { 中文: true, n: null })
check('宽松·缺冒号', '{a 1, b 2}', { a: 1, b: 2 })
check('宽松·带引号键缺冒号', '{"a" 1}', { a: 1 })
check('宽松·缺逗号', '{a: 1 b: 2}', { a: 1, b: 2 })
check('宽松·尾随逗号', '[1, 2, 3,]', [1, 2, 3])
check('宽松·双逗号', '[1,,2]', [1, null, 2])
check('宽松·对象内双逗号', '{"a":1,,}', { a: 1 })
check('宽松·冒号后无值', '{"a":}', { a: null })
check('宽松·None 截断', '{"x": Non}', { x: null })
check('宽松·false 截断', '{"a": fals}', { a: false })
check('宽松·NaN', '{"a": NaN, "b": Infinity, "c": -Infinity}', { a: null, b: null, c: null })
check('宽松·数字裁剪 12.', '{"a": 12.}', { a: 12 })
check('宽松·数字裁剪 1e', '{"a": 1e}', { a: 1 })
check('宽松·宽松闭合符', '{"a": [1, 2}', { a: [1, 2] })

console.log('--- 注释与转义 ---')
check('注释·行+块', '{ // 注释\n "a": 1 /* 块 */ }', { a: 1 })
check('注释·仅注释前缀', '// c\n1', 1)
check('转义·Windows 路径', '{"path": "C:\\Users\\test"}', (v) => typeof v.path === 'string' && v.path.startsWith('C:\\Users') && v.path.includes('est'))
check('转义·字符串内裸换行', '{"t": "a\nb"}', { t: 'a\nb' })

console.log('--- 中文引号 ---')
check('中文引号·键值', '{“名”: “值”}', { 名: '值' })

console.log('--- 文档后冗余 ---')
check('冗余·双文档', '{"a": 1} {"b": 2}', { a: 1 })
check('冗余·标量+尾逗号', '1,', 1)
check('冗余·悬挂逗号顶层', ',,,', MUST_FAIL)

console.log('--- 恒等（合法 JSON 语义不变）---')
check('恒等·嵌套', '{"a":[1,{"b":null}],"e":{},"f":[]}', { a: [1, { b: null }], e: {}, f: [] })
check('恒等·嵌套容器', '[[],[{}],[[1]],[{"a":{}},[]],{}]', [[], [{}], [[1]], [{ a: {} }, []], {}])
check('恒等·字符串', '"s"', 's')
check('恒等·数字', '42', 42)
check('恒等·true', 'true', true)
check('恒等·null', 'null', null)
check('恒等·unicode', '{"u":"\\u00e9\\ud83d\\ude00"}', { u: 'é😀' })
check('恒等·CRLF 空白', '{\r\n  "crlf": true\r\n}', { crlf: true })
check('恒等·BOM', '﻿{"bom":true}', { bom: true })
check('恒等·转义串', '{"a":"x\\ny\\t\\"q\\"\\\\","n":[1,-2.5,0.1]}', { a: 'x\ny\t"q"\\', n: [1, -2.5, 0.1] })

// 合法输入修复后 fixes 应为 0（除 BOM 外零改动路径）
const idFix = repairJson(enc.encode('{"a":[1,2],"b":"x"}'))
if (idFix.fixes !== 0) {
  fail++
  console.log(`✗ 恒等·零修复计数: 合法输入 fixes=${idFix.fixes}`)
} else {
  pass++
  console.log('✓ 恒等·零修复计数: 合法输入 fixes=0')
}

console.log(fail === 0 ? `=== ALL PASS (${pass}) ===` : `=== ${fail} FAILURES, ${pass} PASS ===`)
process.exit(fail === 0 ? 0 : 1)
