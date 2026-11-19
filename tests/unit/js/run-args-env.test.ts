import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildJobArgs,
  normalizeArgs,
  normalizeEnv,
  splitArgs,
} from '../../../runtime/core/queue/spawn-executor.js'
import { normalizeSelftestReceipt } from '../../../runtime/core/selftest.js'
import type { JobRecord } from '../../../runtime/core/queue/types.js'

function record(kind: 'render' | 'headless', params: Record<string, unknown> = {}): JobRecord {
  return {
    id: 'job-args-env',
    kind,
    params,
    state: 'queued',
    priority: 0,
    slot: null,
    owner: { hostId: 'h', dshSessionId: 'd', agentId: 'a' },
    createdAt: 1,
    updatedAt: 1,
    assignedAt: null,
    startedAt: null,
    finishedAt: null,
    pid: null,
    decision: null,
    result: null,
    artifacts: [],
    logs: { stdout: '', stderr: '' },
    error: null,
    events: [],
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-run-args-'))
}

describe('blender_run args 分词（R4）', () => {
  it('按空白分词并把引号内的空格保留住', () => {
    expect(splitArgs('--alpha 1 --beta two')).toEqual(['--alpha', '1', '--beta', 'two'])
    expect(splitArgs('--msg "hello world" --x \'a b\'')).toEqual([
      '--msg',
      'hello world',
      '--x',
      'a b',
    ])
    expect(splitArgs('  --flag   ""  ')).toEqual(['--flag', ''])
  })

  it('双引号内反斜杠转义（Windows 路径）', () => {
    expect(splitArgs('--path "C:\\\\tmp\\\\x"')).toEqual(['--path', 'C:\\tmp\\x'])
  })

  it('数组原样收、其它类型明确报错', () => {
    expect(normalizeArgs(['--a', '1'])).toEqual(['--a', '1'])
    expect(normalizeArgs(undefined)).toEqual([])
    expect(() => normalizeArgs({ a: 1 })).toThrow(/args/)
  })

  it('env 只收对象，且值一律转字符串', () => {
    expect(normalizeEnv({ A: 'x', B: 2 })).toEqual({ A: 'x', B: '2' })
    expect(normalizeEnv(undefined)).toEqual({})
    expect(() => normalizeEnv(['A'])).toThrow(/env/)
  })
})

describe('headless 作业前导（R3）', () => {
  it('inline script 注入 KERNEL_BOOTSTRAP + preload + argv 尾', () => {
    const dir = tempDir()
    const built = buildJobArgs(
      record('headless', {
        script: 'print("SCRIPT_BODY")',
        preload: 'geo',
        args: '--alpha 1 --beta two',
        env: { PROBE_ENV: 'env-works' },
      }),
      dir,
    )
    const body = fs.readFileSync(path.join(dir, 'job.py'), 'utf8')
    expect(body).toContain('dsh_rt_kernel')
    expect(body).toContain('preload geo.py')
    expect(body).toContain('SCRIPT_BODY')
    expect(built.argsTail).toEqual(['--alpha', '1', '--beta', 'two'])
    expect(built.args.slice(built.args.indexOf('--') + 1)).toEqual([
      '--alpha',
      '1',
      '--beta',
      'two',
    ])
    expect(built.env.PROBE_ENV).toBe('env-works')
    expect(JSON.parse(built.env.DSH_ARGS)).toEqual(['--alpha', '1', '--beta', 'two'])
    expect(built.envKeys).toEqual(['PROBE_ENV'])
  })

  it('bootstrap=false 时不注入 K', () => {
    const dir = tempDir()
    buildJobArgs(record('headless', { script: 'print(1)', bootstrap: false }), dir)
    const body = fs.readFileSync(path.join(dir, 'job.py'), 'utf8')
    expect(body).not.toContain('dsh_rt_kernel')
  })

  it('script_file 合成 job.py（prelude + exec），__file__ 仍是用户的脚本', () => {
    const dir = tempDir()
    // 路径预检要求文件真实存在（提交前就校验，不再让 Blender 起来后才失败）
    const scriptPath = path.join(dir, 'probe.py').split(path.sep).join('/')
    fs.writeFileSync(scriptPath, 'print("probe")\n')
    const built = buildJobArgs(record('headless', { script_file: scriptPath, preload: 'geo' }), dir)
    const pythons = built.args.filter((a, i) => built.args[i - 1] === '--python')
    expect(pythons).toEqual([path.join(dir, 'job.py')])
    const body = fs.readFileSync(pythons[0], 'utf8')
    expect(body).toContain('dsh_rt_kernel')
    expect(body).toContain('preload geo.py')
    expect(body).toContain('exec(compile(_dsh_src, _dsh_target, "exec"), globals())')
    expect(body).toContain(scriptPath)
  })

  it('相对 script_file 按 workspace（会话工作区）解析，而不是 Gateway cwd', () => {
    // 3.2.0-alpha.1 复测：Gateway 进程里三个工作区 env 全空，相对路径静默落到 profile 目录。
    // 工具层现在把会话工作区当作 workspace 传进来，后端解析必须认这一档。
    const dir = tempDir()
    const ws = path.join(dir, 'ws')
    fs.mkdirSync(path.join(ws, 'out'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'out', 'step1.py'), 'print("ws")\n')
    const built = buildJobArgs(
      record('headless', { script_file: 'out/step1.py', workspace: ws }),
      dir,
    )
    const pythons = built.args.filter((a, i) => built.args[i - 1] === '--python')
    const body = fs.readFileSync(pythons[0], 'utf8')
    // job.py 里是 JSON 字面量（Windows 反斜杠成对），所以按 JSON 形态断言
    expect(body).toContain(JSON.stringify(path.join(ws, 'out', 'step1.py')))
  })

  it('script_file 指向不存在的文件时在准备阶段就报 input_missing（不起进程）', () => {
    const dir = tempDir()
    expect(() => buildJobArgs(record('headless', { script_file: 'C:/proj/nope.py' }), dir)).toThrow(
      /input_missing|不存在/,
    )
  })

  it('file= 的 .blend 不存在时在起进程前就报 input_missing（不再让 Blender 报 Cannot read file）', () => {
    const dir = tempDir()
    expect(() =>
      buildJobArgs(record('headless', { file: 'blends/nope.blend', script: 'print(1)' }), dir),
    ).toThrow(/file 不存在/)
    expect(() =>
      buildJobArgs(
        record('render', { file: 'blends/nope.blend', output: path.join(dir, 'f_####') }),
        dir,
      ),
    ).toThrow(/file 不存在/)
  })

  it('preload 名不存在时在准备阶段就报错（不是脚本跑到一半才 NameError）', () => {
    expect(() =>
      buildJobArgs(
        record('headless', { script: 'print(1)', preload: 'no_such_module_xyz' }),
        tempDir(),
      ),
    ).toThrow(/preload/)
  })
})

describe('selftest evidence 归一（R6.2）', () => {
  it('平坦 bool 表原样进 evidence_flat', () => {
    const out = normalizeSelftestReceipt('geo_selftest', {
      ok: true,
      evidence: { a: true, b: false },
    }) as any
    expect(out.evidence_shape).toBe('flat-bool')
    expect(out.evidence_flat).toEqual({ a: true, b: false })
    expect(out.evidence_failed).toEqual(['b'])
    expect(out.evidence_ok).toBe(false)
    expect(out.evidence.a).toBe(true)
  })

  it('嵌套对象/数组摊平成带路径的 bool 表', () => {
    const out = normalizeSelftestReceipt('face_selftest', {
      evidence: { good: { ok: true, score: 0.9 }, bad: [true, false] },
    }) as any
    expect(out.evidence_shape).toBe('nested')
    expect(out.evidence_flat).toEqual({ 'good.ok': true, 'bad[0]': true, 'bad[1]': false })
    expect(out.evidence_nonbool).toEqual({ 'good.score': 0.9 })
    expect(out.evidence_failed).toEqual(['bad[1]'])
  })

  it('非 selftest op 或没有 evidence 时不改回执', () => {
    const plain = { ok: true }
    expect(normalizeSelftestReceipt('geo_box', { evidence: { a: true } })).toEqual({
      evidence: { a: true },
    })
    expect(normalizeSelftestReceipt('geo_selftest', plain)).toBe(plain)
  })
})
