import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import * as assert from 'node:assert/strict'
import { pkgPath } from '../../../helpers/pkg'

// Regression for optional Cordis services. The client bundle registers:
//   · the selection bridge (renders null) and the one-line status chip in the
//     conversation input dock;
//   · the Blender session tab TYPE plus its body and title (two keyed seats)
//     when the right Sidebar's registry is present;
//   · a header entry that opens that tab, and a list entry in the frame overlay
//     that draws the drawer fallback;
//   · the "@" mention source once inputTriggers appears.
// Every seat is optional: the plugin must load without the right sidebar and
// without inputTriggers, and the panel body must never land in the input dock
// again (that was the field complaint: it sat above the composer).

const BUNDLE = pkgPath('lib', 'client.js')

function loadModule() {
  let entry: any
  const window = {
    __ModuleLoader__: {
      load(value: any) {
        entry = value
      },
    },
  }
  const sandbox = vm.createContext({ window, console: { warn() {}, info() {} } })
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { timeout: 2000 })
  return entry.factory((name: string) => {
    assert.equal(name, 'react')
    return {}
  })
}

interface HostOptions {
  withTriggers?: boolean
  withSidebar?: boolean
}

function makeHost(options: HostOptions = {}) {
  const docks: any[] = []
  const header: any[] = []
  const overlay: any[] = []
  const keyedTab: any[] = []
  const keyedTitle: any[] = []
  const sources: any[] = []
  const effects: Array<{ callback: () => any; name?: string }> = []
  const registeredTypes: any[] = []
  const triggers = {
    registerSource(source: any) {
      sources.push(source)
      return () => {}
    },
  }
  const sidebarTabs = {
    register(definition: any) {
      registeredTypes.push(definition)
      return () => {}
    },
  }
  const ctx: any = {
    get: (name: string) =>
      name === 'inputTriggers'
        ? options.withTriggers
          ? triggers
          : undefined
        : name === 'sidebarRightTabs'
          ? options.withSidebar
            ? sidebarTabs
            : undefined
          : undefined,
    effect(callback: () => any, name?: string) {
      // Cordis runs the effect body at registration time and keeps its disposer.
      const disposer = callback()
      effects.push({ callback, name })
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names: string[], callback: (scope: any) => void) {
      assert.equal(names.length, 1)
      const name = names[0]
      assert.ok(['inputTriggers', 'sidebarRightTabs'].includes(name))
      if (name === 'inputTriggers' && !options.withTriggers) return
      if (name === 'sidebarRightTabs' && !options.withSidebar) return
      callback({
        get: (key: string) =>
          key === 'inputTriggers' ? triggers : key === 'sidebarRightTabs' ? sidebarTabs : undefined,
        effect(callback: () => any, effectName?: string) {
          const disposer = callback()
          effects.push({ callback, name: effectName })
          return typeof disposer === 'function' ? disposer : () => {}
        },
      })
    },
    slots: {
      inject(name: string, callback: () => any) {
        assert.ok(
          [
            'conversation.input.dock',
            'conversation.session.header.actions',
            'shell.overlay',
            'sidebar.right.pane.tab',
            'sidebar.right.pane.tab.title',
          ].includes(name),
          'unexpected slot: ' + name,
        )
        if (name.startsWith('sidebar.right') && !options.withSidebar) return undefined
        return callback()
      },
      register(options: any, component: any) {
        const row = { options, component }
        if (options.name === 'conversation.input.dock') docks.push(row)
        else if (options.name === 'conversation.session.header.actions') header.push(row)
        else if (options.name === 'shell.overlay') overlay.push(row)
        else if (options.name === 'sidebar.right.pane.tab') keyedTab.push(row)
        else if (options.name === 'sidebar.right.pane.tab.title') keyedTitle.push(row)
        return () => {}
      },
    },
  }
  return { ctx, docks, header, overlay, keyedTab, keyedTitle, sources, effects, registeredTypes }
}

describe('optional client services', () => {
  it('declares slots as the only hard dependency and keeps no sidebar pane body in the composer dock', () => {
    const mod = loadModule()
    expect(mod.inject).toEqual(['slots'])
    const source = fs.readFileSync(BUNDLE, 'utf8')
    expect(source).toContain('conversation.input.dock')
    expect(source).toContain('blender-selection-bridge')
    expect(source).toContain('blender-session-chip')
    expect(source).toContain('sidebar.right.pane.tab')
    expect(source).toContain('sidebar.right.pane.tab.title')
    expect(source).toContain('conversation.session.header.actions')
    expect(source).toContain('shell.overlay')
    expect(source).not.toContain('conversation.view')
    // 面板主体不再注册进输入框上方（用户实拍：贴在输入框上、与对话流无关）
    expect(source).not.toContain("id: 'blender-session-panel'")
  })

  it('registers the bridge and the one-line chip without any optional service', () => {
    const mod = loadModule()
    const host = makeHost()
    expect(() => mod.apply(host.ctx)).not.toThrow()
    expect(host.docks).toHaveLength(2)
    const bridge = host.docks.find((d) => d.options.id === 'blender-selection-bridge')
    const chip = host.docks.find((d) => d.options.id === 'blender-session-chip')
    expect(bridge.options).toMatchObject({
      name: 'conversation.input.dock',
      id: 'blender-selection-bridge',
      order: 90,
    })
    expect(bridge.options.inject).toBeTypeOf('function')
    expect(bridge.component).toBeTruthy()
    expect(chip.options).toMatchObject({
      name: 'conversation.input.dock',
      id: 'blender-session-chip',
      order: 80,
    })
    expect(chip.options.inject).toBeTypeOf('function')
    expect(chip.component).toBeTruthy()
    // 头部入口与抽屉是"会话视图"的常驻位，没有右侧栏也要注册
    expect(host.header.map((h) => h.options.id)).toEqual(['blender-session-open'])
    expect(host.overlay.map((h) => h.options.id)).toEqual(['blender-session-drawer'])
    // 没有右侧栏服务：tab 类型与两个 keyed 槽位都不注册
    expect(host.registeredTypes).toHaveLength(0)
    expect(host.keyedTab).toHaveLength(0)
    expect(host.keyedTitle).toHaveLength(0)
    expect(host.sources).toEqual([])
  })

  it('registers the tab TYPE and both keyed seats (body + title) when the sidebar is present', () => {
    const mod = loadModule()
    const host = makeHost({ withSidebar: true })
    mod.apply(host.ctx)
    expect(host.registeredTypes).toHaveLength(1)
    expect(host.registeredTypes[0]).toMatchObject({
      kind: 'blender-session',
      priority: 'extension',
    })
    const typeId = host.registeredTypes[0].id
    expect(typeId).toBe('dsh-blender-plugin/session-panel')
    expect(host.keyedTab).toHaveLength(1)
    expect(host.keyedTab[0].options).toMatchObject({
      name: 'sidebar.right.pane.tab',
      key: typeId,
    })
    expect(host.keyedTitle).toHaveLength(1)
    expect(host.keyedTitle[0].options).toMatchObject({
      name: 'sidebar.right.pane.tab.title',
      key: typeId,
    })
    expect(host.keyedTab[0].component).toBeTruthy()
    expect(host.keyedTitle[0].component).toBeTruthy()
  })

  it('registers the @ mention source when inputTriggers arrives', () => {
    const mod = loadModule()
    const host = makeHost({ withTriggers: true })
    mod.apply(host.ctx)
    expect(host.sources).toHaveLength(1)
    expect(host.sources[0]).toMatchObject({ trigger: '@', name: 'blender' })
    expect(host.sources[0].candidates).toBeTypeOf('function')
    expect(host.sources[0].onPick).toBeTypeOf('function')
    expect(host.sources[0].codec).toBeTruthy()
  })

  it('applies once and resets through its dispose effect', () => {
    const mod = loadModule()
    const host = makeHost()
    mod.apply(host.ctx)
    mod.apply(host.ctx)
    expect(host.docks).toHaveLength(2)
    const reset = host.effects.find((effect) => String(effect.name).includes('reset apply guard'))
    expect(reset).toBeTruthy()
    reset!.callback()()
    mod.apply(host.ctx)
    expect(host.docks).toHaveLength(4)
  })
})
