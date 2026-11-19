import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate the package root from either layout:
 *   source:  <pkg>/runtime/ext/gltf_validate_runner.ts
 *   built:   <pkg>/lib/runtime/ext/gltf_validate_runner.js
 * The nearest `package.json` is unambiguous; "first directory containing runtime/ext"
 * would stop at `lib/runtime/ext` in the built layout.
 */
export function findPackageRoot(fromUrl: string | URL): string {
  let dir = path.dirname(fileURLToPath(fromUrl))
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.dirname(fileURLToPath(fromUrl))
}

/** Fixed install directory: <pkg>/runtime/ext (even before setup:ext creates it). */
export function findExtDir(fromUrl: string | URL): string {
  return path.join(findPackageRoot(fromUrl), 'runtime', 'ext')
}
