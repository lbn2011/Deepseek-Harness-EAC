/**
 * lib/hot-update/shell-swap.ts — shell 组件（dsh-eac-shell.exe）热更换。
 *
 * 复用 client-update/apply.ts 的 detached CMD 模式（Windows exe 文件锁：
 * 主进程必须先退出，由脚本等解锁 → 备份 → 覆盖 → 重启 → 自删）。
 * 回滚依据 = exe 同目录 .hu-bak；Rust boot-attempts 熔断连续 3 次失败时
 * 自动换回（main.rs）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

/** 生成并 detached 执行交换脚本，返回脚本路径。 */
export function spawnShellSwap(newExe: string, currentExe: string, workDir: string): string {
  if (process.platform !== 'win32') {
    // 非 Windows：exe 为原生二进制，同锁问题存在；v1 仅支持 Windows，
    // Linux/macOS 走正式更新整包链路。
    throw new Error('shell 热更换当前仅支持 Windows（其余平台走正式更新）');
  }
  fs.mkdirSync(workDir, { recursive: true });
  const scriptPath = path.join(workDir, 'hu-shell-swap.cmd');
  const bak = `${currentExe}.hu-bak`;
  const lines = [
    '@echo off',
    'rem hot-update shell swap (auto-generated; ASCII only)',
    `set "NEW=${newExe}"`,
    `set "CUR=${currentExe}"`,
    `set "BAK=${bak}"`,
    'rem 有界等待旧 exe 解锁（最多 ~5 分钟）',
    'set /a TRIES=0',
    ':waitlock',
    'copy /y "%CUR%" "%CUR%.hulocktest" >nul 2>&1',
    'if errorlevel 1 (',
    '  set /a TRIES+=1',
    '  if %TRIES% GEQ 150 exit /b 1',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto waitlock',
    ')',
    'del "%CUR%.hulocktest" >nul 2>&1',
    'rem 备份现值（熔断回滚依据），失败即放弃（宁可不动）',
    'copy /y "%CUR%" "%BAK%" >nul 2>&1',
    'if errorlevel 1 exit /b 1',
    'copy /y "%NEW%" "%CUR%" >nul 2>&1',
    'if errorlevel 1 (',
    '  rem 覆盖失败：恢复备份并退出（保持旧 exe 可用）',
    '  copy /y "%BAK%" "%CUR%" >nul 2>&1',
    '  exit /b 1',
    ')',
    'rem 重启壳（工作目录 = exe 所在目录，与安装布局一致）',
    'cd /d "%~dp0"',
    'start "" "%CUR%"',
    'rem 自删',
    '(goto) 2>nul & del "%~f0" & exit /b 0',
  ];
  // CRLF 收尾：batch 解析器对无尾换行的最后一条命令敏感（apply.ts 同款纪律）
  fs.writeFileSync(scriptPath, lines.join('\r\n') + '\r\n', 'utf8');
  const child = spawn('cmd.exe', ['/d', '/s', '/c', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
  return scriptPath;
}
