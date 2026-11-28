import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { repoPath } from '../../../helpers/docs'

const pr = fs.readFileSync(repoPath('.github/workflows/pr.yml'), 'utf8')
const release = fs.readFileSync(repoPath('.github/workflows/release.yml'), 'utf8')
const all = pr + '\n' + release
const pkg = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const checkBuildSource = fs.readFileSync(repoPath('scripts/check-build.mjs'), 'utf8')

const actionRefs = (text: string): string[] =>
  [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
const checkoutSteps = (text: string): { total: number; protected: number } => {
  const lines = text.split('\n')
  let total = 0
  let protectedCount = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('uses: actions/checkout@')) continue
    total += 1
    if (
      lines
        .slice(i, i + 6)
        .join('\n')
        .includes('persist-credentials: false')
    )
      protectedCount += 1
  }
  return { total, protected: protectedCount }
}

const jobBlock = (text: string, job: string): string => {
  const lines = text.split('\n')
  const start = lines.indexOf('  ' + job + ':')
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const next = rest.findIndex((line) => /^ {2}[a-z][\w-]*:$/.test(line))
  return (next < 0 ? rest : rest.slice(0, next)).join('\n')
}
const matrixVersions = (text: string, job: string): string[] =>
  [...jobBlock(text, job).matchAll(/^\s+- blender: '([^']+)'$/gm)].map((match) => match[1])

describe('CI workflow hygiene', () => {
  it('uses safe triggers and least-privilege tokens', () => {
    expect(pr).toMatch(/^on:\n {2}pull_request:/m)
    expect(pr).toMatch(/^ {4}branches: \[main\]$/m)
    expect(all).not.toMatch(/pull_request_target|workflow_run/)
    expect(pr).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(release).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(release).toMatch(/permissions:\n {6}contents: write/)
    // registry publishing is closed, so the workflow carries no OIDC token scope.
    expect(release).not.toContain('id-token: write')
  })

  it('pins every action to a full commit SHA', () => {
    const refs = actionRefs(all)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(ref).toMatch(/@[0-9a-f]{40}$/)
  })

  it('does not persist checkout credentials', () => {
    for (const text of [pr, release]) {
      const { total, protected: protectedCount } = checkoutSteps(text)
      expect(total).toBeGreaterThan(0)
      expect(protectedCount).toBe(total)
    }
  })

  it('builds before running check:build', () => {
    for (const text of [pr, release]) {
      const build = text.indexOf('npm run build\n')
      const checkBuild = text.indexOf('npm run check:build')
      expect(build).toBeGreaterThan(-1)
      expect(checkBuild).toBeGreaterThan(-1)
      expect(build).toBeLessThan(checkBuild)
    }
  })

  it('validates the addon package with a pinned Blender 4.2 LTS validator', () => {
    expect(pr).toContain('blender-4.2.10-linux-x64.tar.xz')
    expect(pr).toContain('key: blender-4.2.10-linux-x64')
    expect(pr).toContain('--command extension validate extension/dsh_blender_bridge.zip')
    expect(pr).toContain('Reject an invalid extension package')
  })

  it('puts Blender 4.2.10 LTS and 5.3.0 in one matrix for the Blender jobs', () => {
    expect(matrixVersions(pr, 'extension')).toEqual(['4.2.10', '5.3.0'])
    expect(matrixVersions(pr, 'linux-preview-see')).toEqual(['4.2.10', '5.3.0'])
    for (const job of ['extension', 'linux-preview-see']) {
      const block = jobBlock(pr, job)
      expect(block).toContain('fail-fast: false')
      expect(block).toContain('key: ${{ matrix.cache_key }}')
      expect(block).toContain('path: .cache/blender-${{ matrix.blender }}')
      expect(block).toContain('sha256sum -c -')
      expect(block).toContain('blender-${{ matrix.blender }}/blender')
    }
  })

  it('pins the Blender 5.3.0 artifact with its own key and a literal checksum', () => {
    expect(pr).toContain('blender-5.3.0-linux-x64.tar.xz')
    expect(pr).toContain('cache_key: blender-5.3.0-linux-x64')
    expect(pr).toContain('cache_key: blender-4.2.10-linux-x64')
    const checksums = [...jobBlock(pr, 'extension').matchAll(/^\s+sha256: ([0-9a-f]{64})$/gm)]
    expect(checksums.map((match) => match[1])).toEqual([
      '7b888b36cf5bd7e35d495eb9717f7a9b645ea5f2fb4fe9850991800b8f08d531',
      'dacb8264197a3f7fda6001285a5a506fc97ee943881261c2c3bd63c882f22e05',
    ])
  })

  it('copies exactly one extension artifact into the release assets', () => {
    const copied = [...release.matchAll(/\bcp\s+(\S+\.zip)\s+release-assets\//g)].map((m) => m[1])
    expect(copied).toEqual(['extension/dsh_blender_bridge.zip'])
    expect(release).not.toMatch(/cp\s+\S*legacy\S*\.zip/)
  })

  it('keeps manual CD inputs typed and gated', () => {
    expect(release).toContain('if: ${{ !inputs.dry_run }}')
    expect(release).not.toContain('github.event.inputs')
    expect(release).not.toContain('publish_npm')
    expect(release).toContain('name: release')
    expect(release).toContain('--draft')
  })

  it('gates the extension upload behind an explicit opt-in and a real token', () => {
    expect(release).toContain('publish_extension:')
    expect(release).toContain("description: 'Upload the extension zip to extensions.blender.org")
    expect(release).toMatch(
      /publish_extension:\n\s+description:.*\n\s+required: true\n\s+default: false/,
    )
    expect(release).toContain('if: ${{ !inputs.dry_run && inputs.publish_extension }}')
    expect(release).toContain('BLENDER_EXTENSIONS_TOKEN is not configured')
    expect(release).toContain('npm run publish:extension --')
    expect(release).toContain('--notes-file release/extension-release-notes.md')
    expect(release).toContain('submitted manually at https://extensions.blender.org/')
  })

  it('validates the addon manifest and protocol against one gateway schema', () => {
    expect(release).toContain('const protocol = protocolSource.match')
    expect(release).toContain('const addonVersion = manifest.match')
    expect(release).toContain('addon gateway_schema.py and config/gateway.json disagree')
    expect(release).toContain('blender_manifest.toml and config/gateway.json disagree')
    expect(release).not.toContain('addon protocol.py must keep protocol 11')
    expect(release).not.toContain('addon protocol.py must keep addon version 1.11')
  })
})

describe('build hooks and VCS gate wiring', () => {
  it('keeps prepack build-only', () => {
    expect(pkg.scripts.prepack).toBe('npm run build')
  })

  it('keeps git out of check-build', () => {
    expect(checkBuildSource).not.toContain("spawnSync('git'")
  })

  it('runs git hygiene in both workflows', () => {
    for (const text of [pr, release]) expect(text).toContain('npm run check:git-hygiene')
  })
})
