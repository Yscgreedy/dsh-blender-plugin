import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { pkgPath } from '../../../helpers/pkg'

// 渲染通道词表 parity 门（render channel vocabulary）。
//
// 'render | alpha | mask | ink' 现在写在三份文件里：
//   · src/tools/run/execute.ts            —— 模型面允许列表（invalid_params 的 allowed 名单）
//   · runtime/execution/render-channels.ts —— 命令尾段与三态回执
//   · runtime/py/render/channels_impl/metrics.py —— numpy 指标侧
// 任一处增删都会静默漂移：只改 JS 侧 → Python 收到未知通道名按 skipped 处理；只改 Python →
// 模型面允许列表先拒掉合法通道。这里用 fs 静态解析三处 CHANNEL_NAMES 并断言集合完全相等且无重复。
//
// 全是源码读取（正则取赋值字面量）：不 import Python、不起 Blender、不写临时文件。

interface Vocabulary {
  /** 相对仓库根的正斜杠路径 */
  file: string
  /** CHANNEL_NAMES 赋值所在行 */
  line: number
  names: string[]
  /** 名字 → 它在源文件里的行号 */
  lines: Map<string, number>
}

interface Source {
  file: string
  pattern: RegExp
}

const SOURCES: Source[] = [
  { file: 'src/tools/run/execute.ts', pattern: /export const CHANNEL_NAMES\s*=\s*\[([\s\S]*?)\]/ },
  {
    file: 'runtime/execution/render-channels.ts',
    pattern: /export const CHANNEL_NAMES\s*=\s*\[([\s\S]*?)\]/,
  },
  {
    file: 'runtime/py/render/channels_impl/metrics.py',
    pattern: /^CHANNEL_NAMES\s*=\s*\(([\s\S]*?)\)/m,
  },
]

/** 单/双引号都收（TS 用单引号，Python 用双引号）。 */
const QUOTED = /'([^'\n]+)'|"([^"\n]+)"/g

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line += 1
  return line
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))].length
}

function readVocabulary(source: Source): Vocabulary {
  const text = fs.readFileSync(pkgPath(source.file), 'utf8')
  const found = countMatches(text, source.pattern)
  if (found !== 1)
    throw new Error(source.file + ': 期望 1 处 CHANNEL_NAMES 赋值，实际 ' + found + ' 处')
  const match = text.match(source.pattern)
  if (!match || match.index === undefined) throw new Error(source.file + ': 读不到 CHANNEL_NAMES')
  const body = match[1]
  const bodyStart = match.index + match[0].indexOf(body)
  const names: string[] = []
  const lines = new Map<string, number>()
  for (const item of body.matchAll(QUOTED)) {
    const name = item[1] ?? item[2] ?? ''
    if (!name) continue
    names.push(name)
    lines.set(name, lineOf(text, bodyStart + (item.index ?? 0)))
  }
  return { file: source.file, line: lineOf(text, match.index), names, lines }
}

const vocabularies = SOURCES.map(readVocabulary)
const reference = vocabularies[0]

function duplicates(vocabulary: Vocabulary): string[] {
  return vocabulary.names
    .filter((name, index) => vocabulary.names.indexOf(name) !== index)
    .map((name) => vocabulary.file + ':' + vocabulary.lines.get(name) + ': ' + name)
}

/** 相对 reference 的差异，逐条带 `文件:行`。 */
function drift(vocabulary: Vocabulary): string[] {
  const problems: string[] = []
  for (const name of vocabulary.names) {
    if (!reference.names.includes(name)) {
      problems.push(
        vocabulary.file +
          ':' +
          vocabulary.lines.get(name) +
          ": 多出 '" +
          name +
          "'（" +
          reference.file +
          ' 没有）',
      )
    }
  }
  for (const name of reference.names) {
    if (!vocabulary.names.includes(name)) {
      problems.push(
        vocabulary.file +
          ':' +
          vocabulary.line +
          ": CHANNEL_NAMES 缺少 '" +
          name +
          "'（" +
          reference.file +
          ':' +
          reference.lines.get(name) +
          ' 有）',
      )
    }
  }
  return problems
}

describe('render channel vocabulary', () => {
  it('parses one non-empty CHANNEL_NAMES list from each source', () => {
    for (const vocabulary of vocabularies) {
      expect(vocabulary.names.length, vocabulary.file + ' 的 CHANNEL_NAMES 是空的').toBeGreaterThan(
        0,
      )
    }
  })

  it('keeps every vocabulary duplicate-free', () => {
    for (const vocabulary of vocabularies) {
      const dup = duplicates(vocabulary)
      expect(dup, vocabulary.file + ' 的 CHANNEL_NAMES 有重复项：\n' + dup.join('\n')).toEqual([])
    }
  })

  it('keeps the three vocabularies equal as sets', () => {
    const problems = vocabularies.slice(1).flatMap(drift)
    expect(problems, '三处 CHANNEL_NAMES 已经漂移：\n' + problems.join('\n')).toEqual([])
    for (const vocabulary of vocabularies) {
      expect(new Set(vocabulary.names), vocabulary.file).toEqual(new Set(reference.names))
    }
  })
})
