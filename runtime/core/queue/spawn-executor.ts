// Default queue executor: spawn one fresh Blender process per job.
//
// The queue never executes job work in the Gateway process. This module only
// turns declarative parameters into Blender CLI arguments, captures the logs,
// and terminates the exact process tree on cancel or timeout.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { IS_WIN } from '../../config.js'
import { BLENDER_EXE } from '../../paths.js'
import { isRecord } from '../json.js'
import { channelReceiptFor } from '../../execution/render-channels.js'
import { parseRenderDeviceMarker } from '../../execution/render-device.js'
import { buildJobArgs, ensureDir, workRoot } from './job-args.js'
import type { Prepared } from './job-args.js'
import type { JobExecutionResult, JobExecutor, JobHandle, JobRecord } from './types.js'

export interface SpawnExecutorOptions {
  blenderExe?: string
  now?: () => number
  tempRoot?: string
  spawnImpl?: typeof spawn
}

const MAX_LOG = 262144
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

function prepare(job: JobRecord, spawnOptions: SpawnExecutorOptions): Prepared {
  const tempRoot = spawnOptions.tempRoot || path.join(workRoot(), 'tmp')
  ensureDir(tempRoot)
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'dsh-job-'))
  const built = buildJobArgs(job, tempDir)
  return { ...built, tempDir }
}

function prepareFailure(
  e: unknown,
  blenderExe: string | null,
  code: 'blender_exe_missing' | 'job_prepare_failed' = 'blender_exe_missing',
): JobExecutionResult {
  const reason = e instanceof Error ? e.message : String(e)
  // input_missing 的 tried / bases 是"到底按哪些根找过"的唯一证据，不能在这里丢掉。
  const rawEvidence = (e as { evidence?: unknown } | null | undefined)?.evidence
  const detail = isRecord(rawEvidence) ? rawEvidence : {}
  const evidence = Object.keys(detail).length ? { blenderExe, ...detail } : { blenderExe }
  if (code === 'job_prepare_failed')
    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: reason,
      error: {
        ok: false,
        code,
        stage: 'spawn',
        root_cause: 'Could not prepare the Blender job: ' + reason,
        fix: 'Fix the reported cause (preload module name, args/env type), then resubmit.',
        fallback: { kind: 'unavailable', summary: 'fix the job parameters and resubmit' },
        evidence,
      },
    }
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: reason,
    error: {
      ok: false,
      code,
      stage: 'spawn',
      root_cause: 'Could not start Blender: ' + reason,
      fix: 'Set DSH_BLENDER_EXE or write dsh-blender.config.json with blenderExe.',
      fallback: { kind: 'unavailable', summary: 'install Blender or set DSH_BLENDER_EXE' },
      evidence: { blenderExe },
    },
  }
}

function artifactsIn(outdir: string | null, since: number): string[] {
  if (!outdir) return []
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length >= 100) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 100) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else {
        try {
          if (fs.statSync(full).mtimeMs >= since) found.push(full)
        } catch {
          /* a file may disappear while collecting */
        }
      }
    }
  }
  walk(outdir, 0)
  return found
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (IS_WIN) {
    try {
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already exited */
    }
  }
}

function spawnBlender(opts: SpawnExecutorOptions, prepared: Prepared, jobId: string): ChildProcess {
  return (opts.spawnImpl || spawn)(opts.blenderExe || (BLENDER_EXE as string), prepared.args, {
    env: { ...process.env, ...prepared.env, DSH_JOB_ID: jobId },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !IS_WIN,
  })
}

function captureLogs(child: ChildProcess): { stdout: string; stderr: string } {
  const logs = { stdout: '', stderr: '' }
  child.stdout?.on('data', (buf: Buffer) => {
    logs.stdout = (logs.stdout + buf.toString('utf8')).slice(-MAX_LOG)
  })
  child.stderr?.on('data', (buf: Buffer) => {
    logs.stderr = (logs.stderr + buf.toString('utf8')).slice(-MAX_LOG)
  })
  return logs
}

function armTimeout(child: ChildProcess, timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
  const timer = setTimeout(
    () => {
      onTimeout()
      killTree(child)
    },
    Math.max(1000, timeoutMs),
  )
  timer.unref?.()
  return timer
}

function parseHeadless(text: string): unknown {
  const matches = text.match(/^HEADLESS (\{.*\})$/gm)
  if (!matches || matches.length === 0) return undefined
  const last = matches[matches.length - 1].slice('HEADLESS '.length)
  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

export class SpawnJobExecutor implements JobExecutor {
  private readonly opts: SpawnExecutorOptions
  constructor(opts: SpawnExecutorOptions = {}) {
    this.opts = opts
  }

  start(job: JobRecord): JobHandle {
    let prepared: Prepared
    try {
      prepared = prepare(job, this.opts)
    } catch (e) {
      return {
        pid: null,
        cancel: () => {},
        done: Promise.resolve(
          prepareFailure(e, this.opts.blenderExe || BLENDER_EXE, 'job_prepare_failed'),
        ),
      }
    }
    let child: ChildProcess
    try {
      child = spawnBlender(this.opts, prepared, job.id)
    } catch (e) {
      return {
        pid: null,
        cancel: () => {},
        done: Promise.resolve(prepareFailure(e, this.opts.blenderExe || BLENDER_EXE)),
      }
    }
    const started = (this.opts.now || Date.now)()
    const logs = captureLogs(child)
    let timedOut = false
    const timeoutMs = Number(job.params.timeout_ms) || DEFAULT_TIMEOUT_MS
    const timer = armTimeout(child, timeoutMs, () => {
      timedOut = true
    })
    const done = new Promise<JobExecutionResult>((resolve) => {
      let settled = false
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (prepared.tempDir) {
          try {
            fs.rmSync(prepared.tempDir, { recursive: true, force: true })
          } catch {
            /* temp cleanup is best effort */
          }
        }
        const render = channelReceiptFor(job.params, logs.stdout)
        // C-9：headless 的前导也打 DSH_RENDER（设备枚举结果），与 render 同一解析器。
        const device = parseRenderDeviceMarker(logs.stdout)
        const headless = job.kind === 'headless' ? parseHeadless(logs.stdout) : null
        const parsed =
          job.kind === 'headless'
            ? headless === null && device === null
              ? undefined
              : {
                  ...((headless as Record<string, unknown> | null) || {}),
                  ...(device ? { applied: device } : {}),
                }
            : render || device
              ? { ...(render || {}), ...(device ? { applied: device } : {}) }
              : undefined
        resolve({
          exitCode,
          signal,
          stdout: logs.stdout,
          stderr: logs.stderr,
          artifacts: artifactsIn(prepared.outdir, started),
          ...(parsed === undefined ? {} : { parsed }),
          provenance: {
            args: prepared.argsTail,
            env: Object.keys(prepared.env).sort(),
            env_keys: prepared.envKeys,
            preloads: prepared.preloads,
            bootstrap: prepared.bootstrap,
          },
          ...(timedOut
            ? {
                error: {
                  ok: false,
                  code: 'job_timeout',
                  stage: 'render' as const,
                  root_cause: 'The job exceeded its timeout.',
                  fix: 'Raise timeout_ms or reduce the workload, then resubmit.',
                  fallback: {
                    kind: 'unavailable' as const,
                    summary: 'resubmit with a larger timeout',
                  },
                  evidence: { timeoutMs },
                },
              }
            : {}),
        })
      }
      child.once('error', (e) => {
        clearTimeout(timer)
        settled = true
        resolve(prepareFailure(e, this.opts.blenderExe || BLENDER_EXE))
      })
      child.once('close', (code, signal) => finish(code, signal ? String(signal) : null))
    })
    return { pid: child.pid ?? null, cancel: () => killTree(child), done }
  }
}
