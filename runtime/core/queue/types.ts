// Job-queue types: one bounded queue for render and headless work.
//
// The queue is deliberately independent from the legacy synchronous headless
// path: a submitted job gets one id and is observed through the same record
// until it reaches a terminal state.

import type { AvailabilityFailure } from '../availability.js'
import type { JobOwner } from '../sessions/job-owner.js'

export type JobKind = 'render' | 'headless'
export type JobState = 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'canceled'
export type JobSlot = 'gpu' | 'cpu'

export const JOB_STATES: readonly JobState[] = [
  'queued',
  'assigned',
  'running',
  'completed',
  'failed',
  'canceled',
]
export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'canceled']

export interface JobEvent {
  at: number
  from: JobState | null
  to: JobState
  slot: JobSlot | null
  pid: number | null
  reason: string
}

export interface JobDecision {
  /** Why this job is (or is not yet) on a slot. */
  outcome: 'admitted' | 'waiting'
  reason: 'fifo' | 'priority' | 'quota' | 'capacity' | 'virtual_gui'
  detail: string
}

export interface JobLogs {
  stdout: string
  stderr: string
}

export interface JobResult {
  exitCode: number | null
  signal: string | null
  ms: number
  parsed?: unknown
  /** 参数透传回执（R4）：args 分词结果、注入的 env 键、preload 清单、bootstrap 是否开启。 */
  provenance?: Record<string, unknown>
}

/** Persisted job shape. Handles and timers are never part of this record. */
export interface JobRecord {
  id: string
  kind: JobKind
  params: Record<string, unknown>
  state: JobState
  priority: number
  slot: JobSlot | null
  owner: JobOwner
  createdAt: number
  updatedAt: number
  assignedAt: number | null
  startedAt: number | null
  finishedAt: number | null
  pid: number | null
  decision: JobDecision | null
  result: JobResult | null
  artifacts: string[]
  logs: JobLogs
  error: AvailabilityFailure | null
  events: JobEvent[]
  /**
   * H5（作业跨 reload）：这条记录是**上一个 Gateway** 留下的、进程已经随换代消失的作业。
   * 它不能自称 running（那会让下一次 status/wait 一直等一个不存在的进程），
   * 也不能假装失败得像"跑完了"—— lost=true 才是诚实答案：id / 参数 / 事件保留，
   * 产物按磁盘台账认领，要产物就重新 submit。
   */
  lost?: boolean
  /** lost 的人话原因（与 events 的 reason 同源） */
  lostReason?: string
  /** 判 lost 的时刻（毫秒时间戳） */
  lostAt?: number
  /** submit 回执专用的入队位次（派生值，不持久化）。 */
  queued_ahead?: number
}

export interface JobExecutionResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  artifacts?: string[]
  parsed?: unknown
  provenance?: Record<string, unknown>
  error?: AvailabilityFailure
}

export interface JobHandle {
  pid: number | null
  done: Promise<JobExecutionResult>
  cancel: () => void
}

export interface JobExecutor {
  start: (job: JobRecord) => JobHandle
}

export interface JobStore {
  load: () => JobRecord[]
  save: (jobs: JobRecord[]) => void
}

export interface QueueCapacity {
  pending: number
  gpu: number
  cpu: number
  ownerQuota: number
}

export const DEFAULT_CAPACITY: QueueCapacity = { pending: 64, gpu: 1, cpu: 2, ownerQuota: 8 }

export interface SubmitInput extends Record<string, unknown> {
  kind?: JobKind | string
  priority?: number
}
