/** 把一行美化后的 JSON 文本切成带类名的 token，用于语法着色。 */

export interface Tok {
  text: string
  cls: 'plain' | 'key' | 'string' | 'number' | 'keyword' | 'punct' | 'comment'
}

export function tokenizeLine(s: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < s.length && s.charCodeAt(i) === 32) i++
  if (i > 0) toks.push({ text: s.slice(0, i), cls: 'plain' })
  const rest = s.slice(i)
  if (rest) pushRest(rest, toks)
  return toks
}

function pushRest(rest: string, toks: Tok[]): void {
  if (rest.charCodeAt(0) === 34) {
    const m = /^"(?:[^"\\]|\\.)*"/.exec(rest)
    if (m) {
      const after = rest.slice(m[0].length)
      if (after.startsWith(':')) {
        toks.push({ text: m[0], cls: 'key' })
        toks.push({ text: ': ', cls: 'punct' })
        pushValue(after.slice(2), toks) // 格式化器恒定输出 ': '
        return
      }
      toks.push({ text: m[0], cls: 'string' })
      if (after) toks.push({ text: after, cls: 'punct' })
      return
    }
  }
  pushValue(rest, toks)
}

function pushValue(v: string, toks: Tok[]): void {
  if (!v) return
  const c = v.charCodeAt(0)
  if (c === 34) toks.push({ text: v, cls: 'string' })
  else if (c === 45 || (c >= 48 && c <= 57)) toks.push({ text: v, cls: 'number' })
  else if (c === 116 || c === 102 || c === 110) toks.push({ text: v, cls: 'keyword' })
  else toks.push({ text: v, cls: 'punct' })
}
