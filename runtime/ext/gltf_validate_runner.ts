import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from "../foundation/json.js";
import { findExtDir } from './ext-dir.js';
// 安装目录固定是 <pkg>/runtime/ext —— 不能按 runner 自身位置 require：
// 构建后 runner 在 lib/runtime/ext/，会找不到 runtime/ext/node_modules（现场实测）。
const require = createRequire(path.join(findExtDir(import.meta.url), 'gltf_validate_runner.js'));
const file = process.argv[2];
if (!file) { console.log(JSON.stringify({ ok: false, error: 'usage: node gltf_validate_runner.mjs <file.glb|gltf>' })); process.exit(0); }
try {
  const validator = require('./node_modules/gltf-validator');
  const bytes = new Uint8Array(fs.readFileSync(file));
  validator.validateBytes(bytes, { maxIssues: 200 }).then((rep: unknown) => {
    console.log('RAW ' + JSON.stringify(rep));
  }).catch((e: unknown) => {
    console.log('RAW ' + JSON.stringify({ ok: false, error: errorMessage(e).slice(0, 300) }));
  });
} catch (e) {
  console.log('RAW ' + JSON.stringify({ ok: false, error: 'validator 加载失败: ' + errorMessage(e).slice(0, 200) }));
}
