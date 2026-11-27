import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { jobSubmitBody, queueJobBody } from '../../../src/tools/shared/queue-job'
import { pkgPath } from '../../helpers/pkg'

// 队列传输单源门。
//
// /job 的提交体原来在 blender_run submit 与本地无头车道里各手写一遍：surface 写两次、
// op="submit" 写两次、Gateway 不可达的回执写两份。改一次 submit 语义要同改两处，漏一处
// 就是两个车道对同一个后端说不同的话。这里锁三件事：
//   1. 请求体的键序由构造器决定（宿主按固定键序序列化，键序也是契约）；
//   2. src/ 里只有 shared/queue-job.ts 直接 POST /job；
//   3. op="submit" 只在构造器里出现（车道里再写一次就是漂移的开始）。
// 断言只读源码与构造器，不依赖后端：改错了在单测阶段就红。

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (/\.(ts|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

const ROOT = pkgPath('.')
const toPosix = (value: string): string => value.split(path.sep).join('/')
const SRC_FILES = walkTs(pkgPath('src')).map((abs) => ({
  abs,
  rel: toPosix(path.relative(ROOT, abs)),
}))

/** backend* 调用开口后 240 字符内出现 '/job' 字面量的调用点。 */
function jobPosters(): string[] {
  const call = /\bbackend(?:Post|Json|Get)\s*\(/g
  const hits: string[] = []
  for (const { abs, rel } of SRC_FILES) {
    const text = fs.readFileSync(abs, 'utf8')
    call.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = call.exec(text))) {
      if (/['"]\/job['"]/.test(text.slice(match.index, match.index + 240))) hits.push(rel)
    }
  }
  return [...new Set(hits)]
}

/** 含 op: 'submit' 字面量的文件。 */
function submitLiteralFiles(): string[] {
  return SRC_FILES.filter(({ abs }) => /op:\s*'submit'/.test(fs.readFileSync(abs, 'utf8'))).map(
    ({ rel }) => rel,
  )
}

describe('queue job transport has one source', () => {
  it('builds the submit body with a fixed key order', () => {
    const body = jobSubmitBody({ kind: 'headless', file: 'a.blend' })
    expect(Object.keys(body)).toEqual(['surface', 'op', 'kind', 'file'])
    expect(body).toEqual({
      surface: 'queue',
      op: 'submit',
      kind: 'headless',
      file: 'a.blend',
    })
  })

  it('wraps non-submit actions on the same surface', () => {
    expect(queueJobBody({ op: 'list' })).toEqual({ surface: 'queue', op: 'list' })
  })

  it('posts to /job from exactly one module', () => {
    expect(jobPosters()).toEqual(['src/tools/shared/queue-job.ts'])
  })

  it('writes op="submit" only in the constructor', () => {
    expect(submitLiteralFiles()).toEqual(['src/tools/shared/queue-job.ts'])
  })

  it('has both lanes consume the constructor', () => {
    for (const rel of ['src/tools/op/local.ts', 'src/tools/run/execute.ts']) {
      const text = fs.readFileSync(pkgPath(rel), 'utf8')
      expect(text, rel).toContain("from '../shared/queue-job.js'")
      expect(text, rel).toContain('postJobSubmit(')
    }
  })
})
