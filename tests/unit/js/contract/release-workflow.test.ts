import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { repoPath } from '../../../helpers/docs'

const workflow = fs.readFileSync(repoPath('.github/workflows/release.yml'), 'utf8')

describe('manual CD workflow', () => {
  it('only runs on explicit workflow_dispatch', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m)
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|pull_request_target|schedule):/m)
  })

  it('defaults to a dry run and has no registry publishing input', () => {
    expect(workflow).toContain("default: '3.3.1'")
    expect(workflow).toMatch(/dry_run:[\s\S]*?default: true/)
    expect(workflow).toContain('if: ${{ !inputs.dry_run }}')
    expect(workflow).not.toContain('github.event.inputs')
    expect(workflow).not.toContain('publish_npm')
    expect(workflow).not.toContain('publish-npm')
    expect(workflow).not.toContain('npm publish')
  })

  it('requires the release environment and only creates a draft release', () => {
    expect(workflow).toContain('name: release')
    expect(workflow).toContain('--draft')
    expect(workflow).toContain('--target')
    expect(workflow).toContain('--prerelease')
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('Refuse a prerelease marketplace upload')
  })

  it('validates the generated gateway schema rather than the retired protocol constant', () => {
    expect(workflow).toContain(
      "fs.readFileSync('extension/dsh_blender_bridge/gateway_schema.py', 'utf8')",
    )
    expect(workflow).not.toContain(
      "fs.readFileSync('extension/dsh_blender_bridge/protocol.py', 'utf8')",
    )
  })

  it('does not publish to npm and ships the tarball as a release asset only', () => {
    expect(workflow).not.toContain('npm publish')
    expect(workflow).not.toContain('registry.npmjs.org')
    expect(workflow).not.toContain('id-token: write')
    expect(workflow).not.toContain('NPM_TOKEN')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
    expect(workflow).toContain('npm pack --json --pack-destination release-assets')
    const pkg = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8'))
    expect(pkg.private).toBe(true)
    expect(pkg.repository && pkg.repository.url).toContain('dsh-blender-plugin')
  })
})
