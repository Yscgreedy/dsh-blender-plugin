import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AUDIT_PATH, PATH_HELPERS, pyModuleFile, pyModuleNames } from '../../../runtime/paths.js'
import {
  injectModule,
  preloadChunk,
  runtimeModuleFiles,
  runtimeModuleFingerprint,
  runtimeModulePrefixes,
} from '../../../runtime/core/kernel/api.js'

describe('kernel module injection', () => {
  it('gives preloaded modules their real __file__ path', () => {
    const code = preloadChunk('audit')
    expect(code).toContain('"__file__": ' + JSON.stringify(AUDIT_PATH))
    expect(pyModuleFile('audit')).toBe(AUDIT_PATH)
    expect(code).toContain('"__name__": "audit"')
  })

  it('gives every registered preload module its real __file__', () => {
    for (const name of pyModuleNames()) {
      const code = preloadChunk(name)
      expect(code).toContain('"__file__": ' + JSON.stringify(pyModuleFile(name)))
    }
  })

  it('accepts a single string prefix in K.reload_modules', () => {
    expect(PATH_HELPERS).toContain('if isinstance(prefixes, str):')
    expect(PATH_HELPERS).toContain('pre = [prefixes] if prefixes else []')
    expect(PATH_HELPERS).toContain('K.runtime_modules_status = _dsh_runtime_modules_status')
  })

  it('fingerprints the facade plus its impl tree, not only the facade mtime', () => {
    const tree = runtimeModuleFiles(AUDIT_PATH)
    expect(tree.files.map((x) => x.path)).toContain('audit.py')
    expect(tree.files.some((x) => x.path.startsWith('audit_impl/'))).toBe(true)
    expect(runtimeModuleFingerprint(tree.files)).toContain('audit_impl/')
    expect(runtimeModulePrefixes(AUDIT_PATH)).toEqual([
      'runtime.py.core.audit',
      'runtime.py.core.audit_impl',
    ])
  })

  it('changes the tree fingerprint when only an impl file changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-fp-'))
    try {
      fs.writeFileSync(path.join(dir, 'foo.py'), 'x = 1\n')
      fs.mkdirSync(path.join(dir, 'foo_impl'))
      const impl = path.join(dir, 'foo_impl', 'bar.py')
      fs.writeFileSync(impl, 'y = 1\n')
      const first = runtimeModuleFingerprint(runtimeModuleFiles(path.join(dir, 'foo.py')).files)
      fs.writeFileSync(impl, 'y = 2\n')
      const second = runtimeModuleFingerprint(runtimeModuleFiles(path.join(dir, 'foo.py')).files)
      expect(second).not.toBe(first)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sets __file__ before injecting a module into the kernel globals', async () => {
    const calls: string[] = []
    const deps = {
      injected: new Set<string>(),
      addon: {
        send: async (_command: string, args: { code: string }) => {
          calls.push(args.code)
          return { result: calls.length === 1 ? 'HAVE False FP none' : 'AUDIT_READY' }
        },
      },
    } as unknown as Parameters<typeof injectModule>[0]

    await injectModule(deps, AUDIT_PATH, 'AUDIT_READY', 'AUDIT_VERSION')

    expect(calls).toHaveLength(2)
    const injected = calls[1]
    const fileLine = injected.indexOf('__file__ = ' + JSON.stringify(AUDIT_PATH))
    expect(fileLine).toBeGreaterThanOrEqual(0)
    expect(fileLine).toBeLessThan(injected.indexOf('"""网格体检 public facade'))
    expect(injected).toContain('K.reload_modules(')
    expect(injected).toContain('runtime_module_fps')
    expect(injected).toContain('AUDIT_READY')
  })
})
