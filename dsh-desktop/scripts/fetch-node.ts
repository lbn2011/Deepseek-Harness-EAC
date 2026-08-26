'use strict';

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

const version = process.version.replace(/^v/, '');
const archive = `node-v${version}-linux-x64.tar.xz`;
const linuxUrl = `https://nodejs.org/dist/v${version}/${archive}`;
const vendorRoot = path.resolve(__dirname, '..', 'vendor', 'node');
const dest = process.platform === 'win32'
  ? path.join(vendorRoot, 'node.exe')
  : path.join(vendorRoot, 'bin', 'node');

function download(url: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        void download(new URL(response.headers.location, url).toString(), file).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载 Node 失败: HTTP ${response.statusCode ?? 0}`));
        return;
      }
      const output = fs.createWriteStream(file);
      response.pipe(output);
      output.once('finish', () => output.close(() => resolve()));
      output.once('error', reject);
    }).once('error', reject);
  });
}

async function main(): Promise<void> {
  if (process.platform === 'linux') {
    if (process.arch !== 'x64') throw new Error(`暂不支持 Linux ${process.arch}`);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-'));
    const archivePath = path.join(temp, archive);
    try {
      await download(linuxUrl, archivePath);
      const unpacked = path.join(temp, `node-v${version}-linux-x64`);
      const result = spawnSync('tar', ['-xJf', archivePath, '-C', temp], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`解压 Node 失败: ${result.status ?? 'unknown'}`);
      fs.rmSync(vendorRoot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(vendorRoot), { recursive: true });
      fs.renameSync(unpacked, vendorRoot);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } else {
    const src = process.execPath;
    if (!/node(\.exe)?$/i.test(path.basename(src))) {
      throw new Error('fetch-node 必须在系统 Node 下运行（npm run fetch-node），不能在 Electron 内运行。');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  console.log(`Node ${process.version} / ${process.platform}-${process.arch} / ${fs.statSync(dest).size} bytes`);
  console.log(`运行时路径: ${dest}`);
}

void main().catch((error) => {
  console.error(String((error as Error).message || error));
  process.exitCode = 1;
});
