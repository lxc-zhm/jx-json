#!/usr/bin/env node
// 生成 JSON 测试样本：node scripts/gen-sample.mjs <mb> <typical|dense> [outfile]
//   typical：API 风格对象数组（长字符串为主，结构稀疏）
//   dense  ：短 token 密集型（数值小数组），重排器最坏情况
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const mb = Number(process.argv[2] ?? 50)
const shape = process.argv[3] ?? 'typical'
const file = process.argv[4] ?? `public/sample-${shape}-${mb}mb.json`

let seed = 0x2f6e2b1
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff)
const words =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore json formatter performance worker virtual scroll collapse pretty printer benchmark'.split(
    ' ',
  )
const str = (n) => {
  const a = []
  for (let k = 0; k < n; k++) a.push(words[(rnd() * words.length) | 0])
  return a.join(' ')
}

function item(i) {
  return {
    id: i,
    name: str(12),
    email: `user${i}@example.com`,
    active: rnd() > 0.5,
    score: Math.round(rnd() * 10000) / 100,
    tags: [str(2), str(3), str(2)],
    profile: { city: str(2), bio: str(40), level: (rnd() * 9) | 0 },
  }
}

const target = mb * 1024 * 1024
const parts = []
let size = 0

if (shape === 'typical') {
  parts.push('[')
  size += 1
  for (let i = 0; size < target; i++) {
    const s = (i ? ',' : '') + JSON.stringify(item(i))
    parts.push(s)
    size += s.length + 1
  }
  parts.push(']')
} else if (shape === 'dense') {
  parts.push('[')
  size += 1
  for (let i = 0; size < target; i++) {
    const s = (i ? ',' : '') + '[1,-2,3]'
    parts.push(s)
    size += s.length
  }
  parts.push(']')
} else {
  console.error(`unknown shape: ${shape}`)
  process.exit(1)
}

mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, parts.join(''))
console.log(`${file}: ${(size / 1048576).toFixed(1)} MB`)
