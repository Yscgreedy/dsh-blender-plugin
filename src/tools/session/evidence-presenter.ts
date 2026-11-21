/**
 * blender_session 的本地进程 / 端口证据段（list 与 doctor 共用；从 presenter.ts 拆出，
 * 保持单文件行预算）。字段名保持 snake_case，判据可被机械 grep。
 */
import { asRecord, text } from '../../contracts/dynamic.js'

function processText(procs: Record<string, unknown>[]): string {
  if (!procs.length) return '(无)'
  return procs
    .map(
      (p) =>
        text(p.role || '?') +
        ' pid=' +
        text(p.pid) +
        ' "' +
        text(p.name) +
        '" port=' +
        (p.port === null || p.port === undefined ? 'null' : text(p.port)),
    )
    .join(' · ')
}

function portText(ports: Record<string, unknown>[]): string {
  if (!ports.length) return '(无)'
  return ports
    .map((p) => {
      const pids = Array.isArray(p.pids) ? p.pids.map(text).join(',') : ''
      const raw = Array.isArray(p.pids_raw) ? p.pids_raw.map(text).join(',') : ''
      return (
        text(p.port) +
        ' ' +
        (p.listening === true ? 'listening' : 'closed') +
        ' pids=[' +
        pids +
        '] pids_raw=[' +
        raw +
        ']' +
        (p.process ? ' "' + text(p.process) + '"' : '') +
        ' role=' +
        text(p.role || '-') +
        ' mode=' +
        text(p.mode || '-')
      )
    })
    .join(' · ')
}

function portsEvidenceLine(
  ev: Record<string, unknown>,
  evidence: Record<string, unknown>,
  conflicts: string[],
): string {
  const gw = asRecord(ev.gateway)
  const worker = asRecord(ev.worker)
  const legacy = asRecord(ev.legacy)
  return (
    'source=' +
    text(ev.source || evidence.source || '-') +
    ' · scanned_at=' +
    text(ev.scanned_at || evidence.scanned_at || '-') +
    ' · gateway=' +
    text(gw.port) +
    ' ' +
    text(gw.state) +
    ' pid=' +
    text(gw.pid === null || gw.pid === undefined ? '-' : gw.pid) +
    ' matched=' +
    String(gw.matched === true) +
    ' · worker=' +
    text(worker.port) +
    ' ' +
    text(worker.state) +
    ' · legacy=' +
    text(legacy.port) +
    ' ' +
    text(legacy.state) +
    '（不冒充 gateway）' +
    ' · conflicts=' +
    String(conflicts.length)
  )
}

function falsePositiveText(fps: Record<string, unknown>[]): string {
  return fps.map((f) => text(f.port) + '/pid=' + text(f.pid) + ' ' + text(f.reason)).join(', ')
}

/**
 * 工单 6：本地进程 / 端口证据（list 与 doctor 共用同一段，避免两处口径漂移）。
 * 字段名保持 snake_case —— 判据要能被机械 grep（local_processes / ports / ports_evidence / false_positives）。
 */
export function formatLocalEvidence(
  evidence: Record<string, unknown> | null | undefined,
): string[] {
  if (!evidence || !Object.keys(evidence).length) return []
  const procs = Array.isArray(evidence.local_processes)
    ? evidence.local_processes.map(asRecord)
    : []
  const ports = Array.isArray(evidence.ports) ? evidence.ports.map(asRecord) : []
  const ev = asRecord(evidence.ports_evidence)
  const conflicts = Array.isArray(ev.conflicts) ? ev.conflicts.map(text) : []
  const fps = Array.isArray(evidence.false_positives) ? evidence.false_positives.map(asRecord) : []
  const fixture = asRecord(evidence.fixture)
  const lines = [
    'local_processes · ' + String(procs.length) + ' 个（' + processText(procs) + '）',
    'ports · ' + portText(ports),
    'ports_evidence · ' + portsEvidenceLine(ev, evidence, conflicts),
    'false_positives · [' +
      falsePositiveText(fps) +
      ']' +
      (fixture.path
        ? '（fixture=' +
          text(fixture.name || '-') +
          ' path=' +
          text(fixture.path) +
          ' decoys=' +
          String(fixture.decoys ?? 0) +
          '）'
        : ''),
  ]
  // 扫描失败不沉默：degraded 必须出现在回执里（端口状态此时是 unknown，不是 closed）。
  if (evidence.degraded === true)
    lines.push('degraded · ' + text(evidence.error || 'local scan degraded'))
  if (conflicts.length) for (const c of conflicts) lines.push('  conflict: ' + c)
  return lines
}
