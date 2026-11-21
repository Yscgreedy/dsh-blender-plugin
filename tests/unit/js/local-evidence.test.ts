/**
 * 6c：诱饵 fixture 的回放判据。
 *
 * 一份 fixture 里同时放"真 gateway"与"看起来像 gateway 的诱饵"：
 *   · 39877 被 blender.exe 占着（pid 对不上）—— 朴素实现会直接报 gateway 在；
 *   · 39877 有一条没有任何进程表条目的监听（无法印证）；
 *   · 9879 被 chrome.exe 占着（不是 blender）；
 *   · 9877 被 python.exe 占着（旧端口，不是判据）。
 * classifyLocals 必须只认 pid==gatewayPid 且进程名可印证的那一条，false_positives 保持空。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  classifyLocals,
  collectLocalEvidence,
  decodeFixture,
  fixtureRows,
  parseNetstatListening,
  parseTasklistAll,
} from '../../../runtime/core/local-evidence.js'
import { pkgPath } from '../../helpers/pkg'

const FIXTURE = pkgPath('tests', 'fixtures', 'session', 'p6_decoy_ports.json')

function loadFixture(): ReturnType<typeof decodeFixture> {
  const raw: unknown = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  return decodeFixture(raw)
}

function classifyFixture() {
  const doc = loadFixture()
  expect(doc).not.toBeNull()
  const rows = fixtureRows(doc!)
  expect(rows.decoys).toBe(4)
  return {
    rows,
    evidence: classifyLocals({
      listeners: rows.listeners,
      processes: rows.processes,
      gatewayPid: Number(doc!.gatewayPid),
      gatewayPort: 39877,
      workerPort: 9879,
      legacyPort: 9877,
      source: 'fixture',
      scanOk: true,
      fixture: { path: FIXTURE, name: String(doc!.name), decoys: rows.decoys },
    }),
  }
}

describe('6c decoy fixture', () => {
  it('keeps false_positives empty while accepting the real gateway', () => {
    const { evidence } = classifyFixture()
    expect(evidence.false_positives).toEqual([])
    expect(evidence.ports_evidence.gateway.matched).toBe(true)
    expect(evidence.ports_evidence.gateway.pid).toBe(7504)
    expect(evidence.ports_evidence.worker.matched).toBe(true)
    expect(evidence.ports_evidence.legacy.counts_as_gateway).toBe(false)
    expect(evidence.ports_evidence.legacy.state).toBe('listening')
    expect(evidence.ports_evidence.reader).toBe('fixture')
    expect(evidence.ports_evidence.scanned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('has more listeners on 39877 than the one it accepts (the decoys are real)', () => {
    const { rows, evidence } = classifyFixture()
    const onGatewayPort = rows.listeners.filter((r) => r.port === 39877)
    expect(onGatewayPort.length).toBe(3)
    const gatewayPort = evidence.ports.find((p) => p.role === 'gateway')
    expect(gatewayPort?.listening).toBe(true)
    expect(gatewayPort?.pids).toContain(7504)
  })

  it('keeps decoy pids out of pids (raw only) and tags mode', () => {
    const { evidence } = classifyFixture()
    const gateway = evidence.ports.find((p) => p.port === 39877)
    const worker = evidence.ports.find((p) => p.port === 9879)
    const legacy = evidence.ports.find((p) => p.port === 9877)
    // 认定值：只有 pid=7504 的 gateway、pid=11176 的 worker；9877 一个都不认。
    expect(gateway?.pids).toEqual([7504])
    expect(worker?.pids).toEqual([11176])
    expect(legacy?.pids).toEqual([])
    // 原始行仍在 pids_raw：诱饵 pid 只能出现在这里。
    expect(gateway?.pids_raw).toEqual([4242, 7504, 11176])
    expect(worker?.pids_raw).toContain(5150)
    expect(legacy?.pids_raw).toContain(31337)
    expect(legacy?.mode).toBe('fixture')
  })

  it('labels worker pids as worker (never addon) and keeps one GUI blender as addon', () => {
    const evidence = classifyLocals({
      listeners: [
        { port: 39877, pid: 7504, address: 'a', process: 'DeepSeek Harness.exe', decoy: false },
        { port: 9879, pid: 32416, address: 'b', process: 'blender.exe', decoy: false },
      ],
      processes: [
        { pid: 7504, name: 'DeepSeek Harness.exe', decoy: false },
        { pid: 32416, name: 'blender.exe', decoy: false },
        { pid: 5140, name: 'blender.exe', decoy: false },
      ],
      gatewayPid: 7504,
      gatewayPort: 39877,
      workerPort: 9879,
      legacyPort: 9877,
      source: 'netstat',
      scanOk: true,
      workerPids: [32416],
      addonConnected: true,
      fixture: null,
    })
    const role = (pid: number) => evidence.local_processes.find((p) => p.pid === pid)?.role
    expect(role(32416)).toBe('worker')
    expect(role(32416)).not.toBe('addon')
    expect(role(5140)).toBe('addon')
  })

  it('reports each worker on its real port instead of the default for all (field 7)', () => {
    const evidence = classifyLocals({
      listeners: [
        { port: 9879, pid: 32416, address: 'b', process: 'blender.exe', decoy: false },
        { port: 9880, pid: 32417, address: 'b', process: 'blender.exe', decoy: false },
        { port: 9881, pid: 32418, address: 'b', process: 'blender.exe', decoy: false },
      ],
      processes: [
        { pid: 7504, name: 'DeepSeek Harness.exe', decoy: false },
        { pid: 32416, name: 'blender.exe', decoy: false },
        { pid: 32417, name: 'blender.exe', decoy: false },
        { pid: 32418, name: 'blender.exe', decoy: false },
      ],
      gatewayPid: 7504,
      gatewayPort: 39877,
      workerPort: 9879,
      legacyPort: 9877,
      source: 'netstat',
      scanOk: true,
      workerPids: [
        { pid: 32416, port: 9879 },
        { pid: 32417, port: 9880 },
        { pid: 32418, port: 9881 },
      ],
      addonConnected: false,
      fixture: null,
    })
    const port = (pid: number) => evidence.local_processes.find((p) => p.pid === pid)?.port
    expect(port(32416)).toBe(9879)
    expect(port(32417)).toBe(9880)
    expect(port(32418)).toBe(9881)
  })

  it('uses the visible-window blender as addon and keeps hidden instances as other', () => {
    const evidence = classifyLocals({
      listeners: [{ port: 9879, pid: 32416, address: 'b', process: 'blender.exe', decoy: false }],
      processes: [
        { pid: 7504, name: 'DeepSeek Harness.exe', decoy: false },
        { pid: 32416, name: 'blender.exe', decoy: false },
        { pid: 4504, name: 'blender.exe', decoy: false },
        { pid: 5140, name: 'blender.exe', decoy: false },
      ],
      gatewayPid: 7504,
      gatewayPort: 39877,
      workerPort: 9879,
      legacyPort: 9877,
      source: 'netstat',
      scanOk: true,
      workerPids: [32416],
      addonConnected: true,
      guiPids: [5140],
      fixture: null,
    })
    const role = (pid: number) => evidence.local_processes.find((p) => p.pid === pid)?.role
    expect(role(32416)).toBe('worker')
    expect(role(5140)).toBe('addon')
    // 隐藏实例归 other，不出现在可见列表里（契约只列非 other 的进程）。
    expect(role(4504)).toBeUndefined()
  })

  it('records a conflict when another pid holds the gateway port', () => {
    const { evidence } = classifyFixture()
    expect(evidence.ports_evidence.conflicts.length).toBeGreaterThanOrEqual(1)
    expect(evidence.ports_evidence.conflicts[0]).toContain('blender.exe')
  })

  it('replays through collectLocalEvidence with the same reader', () => {
    const evidence = collectLocalEvidence({ gatewayPort: 39877, probeFixture: FIXTURE })
    expect(evidence.fixture?.path).toBe(FIXTURE)
    expect(evidence.false_positives).toEqual([])
    expect(evidence.ports_evidence.reader).toBe('fixture')
    expect(evidence.local_processes.some((p) => p.role === 'gateway' && p.pid === 7504)).toBe(true)
  })

  it('degrades loudly when the fixture is unreadable', () => {
    const evidence = collectLocalEvidence({
      probeFixture: pkgPath('tests', 'fixtures', 'session', 'nope.json'),
    })
    expect(evidence.ok).toBe(false)
    expect(evidence.degraded).toBe(true)
    expect(String(evidence.error)).toContain('probeFixture')
  })
})

describe('工单 6 scanners', () => {
  it('parses only LISTENING rows with exact port match', () => {
    const text = [
      '  TCP    0.0.0.0:39877          0.0.0.0:0              LISTENING       7504',
      '  TCP    127.0.0.1:39877        127.0.0.1:5013         ESTABLISHED     7504',
      '  TCP    0.0.0.0:339877         0.0.0.0:0              LISTENING       9999',
    ].join('\r\n')
    const rows = parseNetstatListening(text)
    // 解析器只负责"是不是 LISTENING"；端口精确匹配由 classify 的 target 端口做。
    expect(rows.map((r) => r.port)).toEqual([39877, 339877])
    expect(rows.filter((r) => r.port === 39877)).toHaveLength(1)
    expect(rows[0]).toMatchObject({ port: 39877, pid: 7504 })
  })

  it('parses tasklist CSV rows', () => {
    const text =
      '"DeepSeek Harness.exe","7504","Console","1","123,456 K"\r\n"blender.exe","11176","Console","1","1,234 K"\r\n'
    expect(parseTasklistAll(text)).toEqual([
      { pid: 7504, name: 'DeepSeek Harness.exe' },
      { pid: 11176, name: 'blender.exe' },
    ])
  })
})
