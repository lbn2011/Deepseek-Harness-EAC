/**
 * lib/platform.ts — 桌面平台能力描述（上游 #219 Linux 桌面适配移植）。
 *
 * 纯 node 依赖（fs/path/os），无壳层耦合：sidecar 的 shell.info 用它暴露
 * userDataDir / capabilities（Linux XDG 布局 + 外链剪贴板探测），供
 * 配套插件与 Web UI 做能力协商。合并上游 main 时 lib/desktop/ 按 D2 删除，
 * 本模块从 lib/desktop/platform.ts 平移到 lib/（vnext 隔离体系）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

export interface DesktopCapabilities {
  clipboard: 'supported' | 'external-dependency' | 'unavailable';
  clientSelfUpdate: 'supported' | 'external-handoff';
  computerUser: 'supported' | 'unavailable';
  processFence: 'job-object' | 'degraded';
  plugins: {
    computerUser: 'supported' | 'unavailable';
    ocr: 'supported' | 'external-dependency';
    dafeiyu: 'supported' | 'unavailable';
  };
}

export interface PluginCapability {
  status: 'supported' | 'external-dependency' | 'unavailable';
  reason: string;
}

export function pluginCapabilityDetails(platform: NodeJS.Platform = process.platform): Record<string, PluginCapability> {
  if (platform === 'win32') {
    return {
      'computer-user': { status: 'supported', reason: 'Windows PowerShell and SendInput adapter' },
      picturereader: { status: 'supported', reason: 'Windows OCR and bundled image backends' },
      'dsh-dafeiyu': { status: 'supported', reason: 'Bundled Windows helper' },
    };
  }
  if (platform === 'darwin') {
    return {
      'computer-user': { status: 'unavailable', reason: 'macOS v1.5 计划：CGEvent + TCC 授权' },
      picturereader: { status: 'external-dependency', reason: 'OCR 需 Python (paddle/rapid)，v1.5 计划 Vision 后端' },
      'dsh-dafeiyu': { status: 'unavailable', reason: '无 macOS helper 产物' },
    };
  }
  return {
    'computer-user': { status: 'unavailable', reason: 'Linux/Wayland has no transparent SendInput equivalent' },
    picturereader: { status: 'external-dependency', reason: 'OCR requires a separately installed Linux backend' },
    'dsh-dafeiyu': { status: 'unavailable', reason: 'No Linux helper payload has passed the required smoke test' },
  };
}

export interface DesktopPlatform {
  userDataDir(): string;
  runtimeExecutableName(): string;
  capabilities(): DesktopCapabilities;
}

export interface DesktopPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  commandExists?: (file: string) => boolean;
}

export function nodeExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

function defaultCommandExists(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH || env.Path || env.path || '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, platform === 'win32' ? file + ext.toLowerCase() : file);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch { /* continue */ }
    }
  }
  return false;
}

export function createDesktopPlatform(options: DesktopPlatformOptions = {}): DesktopPlatform {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const commandExists = options.commandExists ?? ((file: string) => defaultCommandExists(file, platform, env));

  const userDataDir = (): string => {
    if (platform === 'win32') {
      const appData = env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
      return path.win32.join(appData, 'Deepseek Harness EAC');
    }
    if (platform === 'linux') {
      const configHome = env.XDG_CONFIG_HOME || path.posix.join(homeDir, '.config');
      return path.posix.join(configHome, 'deepseek-harness-eac');
    }
    if (platform === 'darwin') {
      // macOS 惯例：~/Library/Application Support/<app>（不经 XDG fallback）。
      return path.posix.join(homeDir, 'Library', 'Application Support', 'deepseek-harness-eac');
    }
    const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    return path.join(configHome, 'deepseek-harness-eac');
  };

  const capabilities = (): DesktopCapabilities => ({
    clipboard: platform === 'win32'
      ? 'supported'
      : platform === 'linux' && (commandExists('wl-copy') || commandExists('xclip') || commandExists('xsel'))
        ? 'supported'
        : platform === 'darwin'
          ? 'supported' // pbcopy/pbpaste 为 macOS 内置
          : platform === 'linux' ? 'external-dependency' : 'unavailable',
    clientSelfUpdate: platform === 'win32' ? 'supported' : 'external-handoff',
    computerUser: platform === 'win32' ? 'supported' : 'unavailable',
    processFence: platform === 'win32' ? 'job-object' : 'degraded',
    plugins: platform === 'win32'
      ? { computerUser: 'supported', ocr: 'supported', dafeiyu: 'supported' }
      : { computerUser: 'unavailable', ocr: 'external-dependency', dafeiyu: 'unavailable' },
  });

  return {
    userDataDir,
    runtimeExecutableName: () => nodeExecutableName(platform),
    capabilities,
  };
}
