// Job queue manager: submission, admission, persistence, control.
import { randomUUID } from 'node:crypto'
import { availabilityFailure } from '../availability.js'
import type { AvailabilityFailure } from '../availability.js'
import type { CallerIdentity } from '../sessions/types.js'
import { canManageJob, jobOwnerFromCaller, jobPermissionFailure } from '../sessions/job-owner.js'
import type { JobManageAction } from '../sessions/job-owner.js'
import { JsonJobStore } from './store.js'
import { DEFAULT_CAPACITY, TERMINAL_STATES } from './types.js'
import type {
  JobExecutor,
  JobHandle,
  JobRecord,
  JobState,
  JobStore,
  QueueCapacity,
  SubmitInput,
} from './types.js'
import { explainWaiting, nextAdmission, pendingCount, slotFor, slotUse } from './scheduler.js'

const LOG_CAP = 65536
const WAIT_DEFAULT_MS = 120000
const WAIT_MAX_MS = 600000

export interface QueueOptions {
  executor: JobExecutor
  store?: JobStore
  capacity?: Partial<QueueCapacity>
  reservedGpu?: () => number
  now?: () => number
  id?: () => string
}

export class QueueError extends Error {
  readonly failure: AvailabilityFailure
  constructor(failure: AvailabilityFailure) {
    super(failure.root_cause)
    this.name = 'QueueError'
    this.failure = failure
  }
}

function terminalOf(state: JobState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}

function queueFailure(
  code: string,
  rootCause: string,
  fix: string,
  evidence: Record<string, unknown> = {},
): AvailabilityFailure {
  return availabilityFailure({
    stage: 'queue',
    code,
    rootCause,
    fix,
    fallback: { kind: 'unavailable', summary: rootCause },
    evidence,
  })
}

export function failureForRestart(): AvailabilityFailure {
  return availabilityFailure({
    stage: 'queue',
    code: 'gateway_restart',
    rootCause: 'Gateway restarted while this job was assigned or running.',
    fix: 'Submit the job again; running work is never replayed automatically.',
    fallback: { kind: 'unavailable', summary: 'resubmit the job' },
    evidence: { reason: 'gateway_restart' },
  })
}

export class JobQueue {
  private readonly store: JobStore
  private readonly executor: JobExecutor
  private readonly capacity: QueueCapacity
  private readonly reservedGpu: () => number
  private readonly now: () => number
  private readonly newId: () => string
  private readonly jobs: JobRecord[] = []
  private readonly handles = new Map<string, JobHandle>()

  constructor(opts: QueueOptions) {
    this.executor = opts.executor
    this.store = opts.store || new JsonJobStore()
    this.capacity = { ...DEFAULT_CAPACITY, ...opts.capacity }
    this.reservedGpu = opts.reservedGpu || (() => 0)
    this.now = opts.now || (() => Date.now())
    this.newId = opts.id || (() => 'job-' + randomUUID())
    this.restore()
  }

  /**
   * 从磁盘恢复队列（Gateway 换代后的第一件事）。
   *
   * H5：上一个 Gateway 死的那一刻，assigned/running 的 Blender 进程已经被收走
   * （dispose 杀进程树 / 宿主换代）—— 这条记录若继续自称 running，下一个调用者的
   * status/wait 就会一直等一个不存在的 pid。这里落到 failed(gateway_restart) 并打
   * **lost=true**：id 与参数保留、事件链完整、重新入口写在 error.fix 与 lostReason 里。
   *
   * queued 的作业没有进程，所以反过来**照旧入队**（随后 pump 会真把它跑起来）——
   * "reload 之前排上队的活不会因为 reload 白排"。
   */
  private restore(): void {
    const loaded = this.store.load()
    for (const job of loaded) {
      if (job.state === 'assigned' || job.state === 'running') {
        this.transition(job, 'failed', 'gateway_restart')
        job.error = failureForRestart()
        job.finishedAt = this.now()
        job.pid = null
        job.lost = true
        job.lostAt = this.now()
        job.lostReason =
          'Gateway 换代（reload / dispose）时进程被收走：作业没有跑完，id 与参数保留。' +
          '要产物就用同一组参数重新 action=submit；旧记录只用于对账（lost=true）。'
      }
      this.jobs.push(job)
    }
    if (loaded.length > 0) this.persist()
    this.pump()
  }

  submit(caller: CallerIdentity, input: SubmitInput): JobRecord {
    const kind = input.kind === 'render' || input.kind === 'headless' ? input.kind : null
    if (!kind)
      throw new QueueError(
        queueFailure(
          'queue_invalid_kind',
          'kind must be render or headless',
          'Pass kind=render or kind=headless.',
        ),
      )
    if (kind === 'render' && (input.script !== undefined || input.script_file !== undefined))
      throw new QueueError(
        queueFailure(
          'queue_render_script',
          'render does not execute Python scripts',
          // Q-5 方案 a：render 只放行 pre_script（渲染前跑一次的场景准备），整段脚本仍走 headless。
          'Use kind=headless for a script, or pass render pre_script=<inline Python> for scene preparation (it runs once, before the declarative render prelude).',
        ),
      )
    if (pendingCount(this.jobs) >= this.capacity.pending) {
      throw new QueueError(
        queueFailure(
          'queue_full',
          'The job queue is full.',
          // Q-3：文案必须指向**真实存在**的键（以前写的是不存在的 "documented pending limit"）。
          'Wait for a running job to finish (action=list then action=collect/cancel), ' +
            'or raise the pending limit: env DSH_BLENDER_QUEUE_PENDING ' +
            'or features.queue.pending in dsh-blender.config.json (see docs/配置参考.md).',
          {
            pending: pendingCount(this.jobs),
            limit: this.capacity.pending,
            set: 'DSH_BLENDER_QUEUE_PENDING',
          },
        ),
      )
    }
    const job: JobRecord = {
      id: this.newId(),
      kind,
      params: { ...input },
      state: 'queued',
      priority: clampPriority(input.priority),
      slot: null,
      owner: jobOwnerFromCaller(caller),
      createdAt: this.now(),
      updatedAt: this.now(),
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
    delete job.params.kind
    job.params.kind = kind
    this.events(job, null, 'queued', 'submitted')
    // 入队位置：同一优先级按创建时间 FIFO；只在 submit 回执里给（未持久化，避免过期数字）。
    // 必须在 push/pump 之前算：pump 会立刻把前面的作业提成 running，事后数会少。
    const queuedAhead = this.jobs.filter(
      (other) =>
        other.state === 'queued' &&
        (other.priority > job.priority ||
          (other.priority === job.priority && other.createdAt < job.createdAt)),
    ).length
    this.jobs.push(job)
    this.persist()
    this.pump()
    return Object.assign(this.view(job), { queued_ahead: queuedAhead })
  }

  status(id: string): JobRecord | null {
    const job = this.find(id)
    return job ? this.view(job) : null
  }

  async wait(
    _caller: CallerIdentity,
    id: string,
    timeoutMs = WAIT_DEFAULT_MS,
  ): Promise<Record<string, unknown>> {
    const budget = Math.max(1000, Math.min(WAIT_MAX_MS, Number(timeoutMs) || WAIT_DEFAULT_MS))
    const t0 = Date.now()
    for (;;) {
      const job = this.find(id)
      if (!job)
        throw new QueueError(
          queueFailure(
            'queue_unknown_job',
            'No job has id ' + id,
            'Call op=list and use an existing jobId.',
          ),
        )
      if (terminalOf(job.state))
        return { job: this.view(job), waitedMs: Date.now() - t0, waitTimedOut: false }
      if (Date.now() - t0 >= budget)
        return {
          job: this.view(job),
          waitedMs: Date.now() - t0,
          waitTimedOut: true,
          // Q-4：超时**不是失败**。显式给出"作业仍在跑（或仍在排队等槽位）"，免得调用方
          // 把 waitTimedOut 读成 failed；到达终态的那条路径不带这个字段。
          still_running: !terminalOf(job.state),
        }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }

  collect(caller: CallerIdentity, id: string, tail = 4000): Record<string, unknown> {
    const job = this.find(id)
    if (!job)
      throw new QueueError(
        queueFailure(
          'queue_unknown_job',
          'No job has id ' + id,
          'Call op=list and use an existing jobId.',
        ),
      )
    this.authorize(caller, job, 'collect')
    const snap = this.view(job)
    return {
      job: {
        ...snap,
        logs: { stdout: tailText(job.logs.stdout, tail), stderr: tailText(job.logs.stderr, tail) },
      },
    }
  }

  cancel(caller: CallerIdentity, id: string): Record<string, unknown> {
    const job = this.find(id)
    if (!job)
      throw new QueueError(
        queueFailure(
          'queue_unknown_job',
          'No job has id ' + id,
          'Call op=list and use an existing jobId.',
        ),
      )
    this.authorize(caller, job, 'cancel')
    if (terminalOf(job.state))
      return { job: this.snapshot(job), canceled: false, alreadyFinished: true }
    const handle = this.handles.get(job.id)
    this.transition(job, 'canceled', 'cancel requested by caller')
    job.finishedAt = this.now()
    job.pid = null
    this.handles.delete(job.id)
    if (handle) {
      try {
        handle.cancel()
      } catch {
        /* cancellation is idempotent */
      }
    }
    this.persist()
    this.pump()
    return { job: this.snapshot(job), canceled: true, alreadyFinished: false }
  }

  /**
   * H4/H5：Gateway 关停（插件 dispose / 热更重启）时把**所有非终态作业**收干净。
   *
   * 为什么不能只让 OS 杀子进程：作业是 Gateway 的子进程，Gateway 一死它们就成了
   * 孤儿（还在跑、还在写盘），而 index.jsonl 里永远留着 running —— 现场表现为
   * "reload 之后 /status 有一堆状态是 running 的僵尸作业"。这里显式 cancel：
   * 杀掉 handle、状态落到 canceled、并在事件里写明原因（重新入口 = 重新 submit）。
   */
  cancelAll(reason = 'gateway shutdown'): string[] {
    const dropped: string[] = []
    for (const job of this.jobs) {
      if (terminalOf(job.state)) continue
      const handle = this.handles.get(job.id)
      this.transition(job, 'canceled', reason)
      job.finishedAt = this.now()
      job.pid = null
      this.handles.delete(job.id)
      if (handle) {
        try {
          handle.cancel()
        } catch {
          /* cancellation is idempotent */
        }
      }
      dropped.push(job.id)
    }
    if (dropped.length) this.persist()
    return dropped
  }

  list(
    filter: {
      state?: string
      kind?: string
      owner?: string
      sinceMs?: number
      limit?: number
      offset?: number
    } = {},
  ): JobRecord[] {
    const rows = this.jobs
      .filter((job) => !filter.state || job.state === filter.state)
      .filter((job) => !filter.kind || job.kind === filter.kind)
      .filter((job) => !filter.owner || job.owner.dshSessionId === filter.owner)
      .filter((job) => !filter.sinceMs || Number(job.createdAt || 0) >= Number(filter.sinceMs))
    // C-13：历史队列可达数百条，list 必须有边界（offset/limit），否则一次回执 602 行。
    const offset = Math.max(0, Math.trunc(Number(filter.offset) || 0))
    const limit = Math.trunc(Number(filter.limit) || 0)
    const page = limit > 0 ? rows.slice(offset, offset + limit) : rows.slice(offset)
    return page.map((job) => this.view(job))
  }

  perf(): Record<string, unknown> {
    const byState: Record<string, number> = {}
    for (const state of ['queued', 'assigned', 'running', 'completed', 'failed', 'canceled'])
      byState[state] = this.jobs.filter((job) => job.state === state).length
    return {
      pending: pendingCount(this.jobs),
      byState,
      capacity: { ...this.capacity },
      slots: {
        gpu: {
          used: slotUse(this.jobs, 'gpu'),
          total: this.capacity.gpu,
          reserved: this.reservedGpu(),
        },
        cpu: { used: slotUse(this.jobs, 'cpu'), total: this.capacity.cpu },
      },
      oldestQueuedAt: this.oldestQueuedAt(),
    }
  }

  private oldestQueuedAt(): number | null {
    const queued = this.jobs.filter((job) => job.state === 'queued')
    return queued.length === 0 ? null : Math.min(...queued.map((job) => job.createdAt))
  }

  private pump(): void {
    for (;;) {
      const admission = nextAdmission(this.jobs, this.capacity, this.reservedGpu())
      if (!admission.job) {
        this.recordWaiting()
        return
      }
      const job = admission.job
      job.slot = slotFor(job.kind, job.params)
      job.decision = admission.decision
      this.transition(job, 'assigned', admission.decision.reason)
      job.assignedAt = this.now()
      this.persist()
      this.start(job)
    }
  }

  private recordWaiting(): void {
    const head = this.jobs
      .filter((job) => job.state === 'queued')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0]
    if (!head) return
    const next = explainWaiting(head, this.jobs, this.capacity, this.reservedGpu())
    if (JSON.stringify(head.decision) === JSON.stringify(next)) return
    head.decision = next
    this.persist()
  }

  private start(job: JobRecord): void {
    let handle: JobHandle
    try {
      handle = this.executor.start(this.snapshot(job))
    } catch (e) {
      this.fail(
        job,
        availabilityFailure({
          stage: 'spawn',
          code: 'job_spawn_failed',
          rootCause: e instanceof Error ? e.message : String(e),
          fix: 'Check the Blender executable and the submitted parameters, then retry.',
          fallback: { kind: 'unavailable', summary: 'retry the job' },
          evidence: { kind: job.kind, params: job.params },
        }),
      )
      return
    }
    this.handles.set(job.id, handle)
    job.pid = handle.pid
    this.transition(job, 'running', 'slot acquired')
    this.persist()
    void handle.done.then(
      (result) => this.finish(job, result),
      (error) =>
        this.fail(
          job,
          availabilityFailure({
            stage: job.kind === 'render' ? 'render' : 'spawn',
            code: 'job_execution_failed',
            rootCause: error instanceof Error ? error.message : String(error),
            fix: 'Read the job logs, fix the reported cause, then resubmit.',
            fallback: { kind: 'unavailable', summary: 'resubmit the job' },
            evidence: { jobId: job.id },
          }),
        ),
    )
  }

  private finish(job: JobRecord, result: Awaited<JobHandle['done']>): void {
    if (terminalOf(job.state)) return
    this.handles.delete(job.id)
    job.logs = { stdout: cap(result.stdout), stderr: cap(result.stderr) }
    job.result = {
      exitCode: result.exitCode,
      signal: result.signal,
      ms: Date.now() - (job.startedAt || Date.now()),
      ...(result.parsed === undefined ? {} : { parsed: result.parsed }),
      ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
    }
    job.artifacts = result.artifacts || []
    job.pid = null
    if (result.error) {
      job.error = result.error
      this.transition(job, 'failed', result.error.code)
    } else if (result.exitCode === 0) {
      this.transition(job, 'completed', 'process exited 0')
    } else {
      job.error = availabilityFailure({
        stage: job.kind === 'render' ? 'render' : 'spawn',
        code: 'job_exit_nonzero',
        rootCause: 'Blender exited with code ' + String(result.exitCode) + '.',
        fix: 'Read the job logs and fix the reported Blender error.',
        fallback: { kind: 'unavailable', summary: 'inspect logs then resubmit' },
        evidence: { exitCode: result.exitCode, signal: result.signal },
      })
      this.transition(job, 'failed', 'process exited nonzero')
    }
    job.finishedAt = this.now()
    this.persist()
    this.pump()
  }

  private fail(job: JobRecord, failure: AvailabilityFailure): void {
    if (terminalOf(job.state)) return
    this.handles.delete(job.id)
    job.error = failure
    job.pid = null
    this.transition(job, 'failed', failure.code)
    job.finishedAt = this.now()
    this.persist()
    this.pump()
  }

  private transition(job: JobRecord, to: JobState, reason: string): void {
    const from = job.state
    job.state = to
    job.updatedAt = this.now()
    this.events(job, from, to, reason)
  }

  private events(job: JobRecord, from: JobState | null, to: JobState, reason: string): void {
    job.events.push({ at: this.now(), from, to, slot: job.slot, pid: job.pid, reason })
  }

  private authorize(caller: CallerIdentity, job: JobRecord, action: JobManageAction): void {
    const decision = canManageJob(caller, job.owner)
    if (!decision.allowed)
      throw new QueueError(
        queueFailure(
          'job_ownership_denied',
          jobPermissionFailure(decision, action),
          'Use the DSH session that submitted the job, its parent agent, or the main agent.',
          { action, reason: decision.reason },
        ),
      )
  }

  private find(id: string): JobRecord | null {
    return this.jobs.find((job) => job.id === id) || null
  }

  /**
   * 读路径的作业视图（Q-3）：排队中的作业若**还没有** decision，就用 scheduler 的
   * explainWaiting 当场算一次 —— 同一条策略，绝不在这里复制一份分支。
   *
   * 为什么需要：recordWaiting() 只给队首记原因，第二行之后在 status/list 里是
   * decision=null，调用方看不出"我在等什么"。派生值不落盘、不进事件链：读一次不改状态，
   * 也不会把队列拍成"每次 status 都变一次"。
   */
  private view(job: JobRecord): JobRecord {
    const snap = this.snapshot(job)
    if (snap.state !== 'queued') return snap
    snap.decision = explainWaiting(job, this.jobs, this.capacity, this.reservedGpu())
    return snap
  }

  private snapshot(job: JobRecord): JobRecord {
    return JSON.parse(JSON.stringify(job)) as JobRecord
  }

  private persist(): void {
    this.store.save(this.jobs.map((job) => this.snapshot(job)))
  }
}

function clampPriority(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(-100, Math.min(100, Math.trunc(n)))
}

function cap(text: string): string {
  return text.length > LOG_CAP ? text.slice(-LOG_CAP) : text
}

/**
 * 日志尾部（T-1）：`tail` 仍是**字符上限**，但窗口起点不落在行中间。
 *
 * 按字符 slice 会把一行切成两半：JSON / `HEADLESS {...}` 这类结构化行一旦断在开头，
 * 逐行解析就失败（现场看到的 "STK_JSON 解析不出来"，其实是回执把行截断了）。
 * 所以只做一件事：窗口起点在行中间时，丢掉那半行、从下一个换行之后开始。
 *
 * 两条保持原样：整段没有换行（单行超长输出只能按字符切），以及窗口本来就落在换行后。
 */
function tailText(text: string, tail: number): string {
  const n = Math.max(0, Math.min(LOG_CAP, Number(tail) || 4000))
  if (text.length <= n) return text
  const cut = text.length - n
  const slice = text.slice(cut)
  // 上一字符是换行 ⇒ 窗口正好从行首开始，整段都能用。
  if (text.slice(cut - 1, cut) === '\n') return slice
  const at = slice.indexOf('\n')
  return at < 0 ? slice : slice.slice(at + 1)
}
