'use strict';

// 把随系统 Node 分发的 npm CLI 复制进 vendor/npm。打包应用经 vendored
// node.exe 使用它来检查并安装官方 @deepseek-ai/dsh 更新 —— npm 会按
// registry 发布意图精确解析依赖树、处理平台相关的 optional deps、并尊重
// 用户的 .npmrc（镜像、代理）。
//
// 用法（必须在系统 Node 下运行）：
//   npm run fetch-npm

import * as fs from 'node:fs';
import * as path from 'node:path';

// 随系统 Node 分发的 npm CLI 位置随平台而异：
//   Windows: <node_dir>/node_modules/npm（node.exe 与 node_modules 同层）
//   Linux/macOS: <prefix>/lib/node_modules/npm（node 在 <prefix>/bin，npm 在 lib 下）
// 逐个探测带 bin/npm-cli.js 的候选，避免 setup-node 打包布局差异导致
// fetch-runtime 在 Linux CI 上失败（此前固定取 Windows 布局路径，Linux 必挂）。
const candidates = [
  path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
];
const src = candidates.find((p) => fs.existsSync(path.join(p, 'bin', 'npm-cli.js')));
const dest = path.resolve(__dirname, '..', 'vendor', 'npm');

if (!src) {
  console.error('找不到随 Node 分发的 npm，已探测：');
  for (const p of candidates) console.error('  - ' + p);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const version = (JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`已复制 npm@${version}`);
console.log(`    ${src}`);
console.log(` -> ${dest}`);
