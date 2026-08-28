import type { BridgeSession } from '../../dsh-desktop/lib/host-ctx.js';
import type { IpcEvent, IpcSurface } from '../../dsh-desktop/lib/ipc/transport.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

// 与 server.ts 一致的资源根解析（sidecar 与 dsh-desktop 同级的任意布局），
// 动态 require 保证与 server.js 共享同一 state 单例。
function resolveDesktopRoot(): string {
  const upTwo = path.resolve(__dirname, '..', '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upTwo, 'package.json'))) return upTwo;
  const upOne = path.resolve(__dirname, '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upOne, 'package.json'))) return upOne;
  return upTwo;
}
const DSH_DESKTOP_ROOT = process.env.DSH_RESOURCE_ROOT
  ? path.join(process.env.DSH_RESOURCE_ROOT, 'dsh-desktop')
  : resolveDesktopRoot();
const { state } = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'state.js')) as typeof import('../../dsh-desktop/lib/state.js');

export type SidecarMethod = (params?: Record<string, unknown>) => unknown;

export interface SidecarIpcSurface extends IpcSurface {
  channels(): string[];
  kindOf(channel: string): 'invoke' | 'send' | undefined;
  session(token: string): BridgeSession;
}

export function createSidecarIpcSurface(methods: Record<string, SidecarMethod>): SidecarIpcSurface {
  const kinds = new Map<string, 'invoke' | 'send'>();
  const sessions = new Map<string, BridgeSession>();

  const session = (token: string): BridgeSession => {
    let current = sessions.get(token);
    if (current) return current;
    current = {
      id: token,
      send: () => {},
      focus: () => {},
      close: () => sessions.delete(token),
      isAlive: () => sessions.has(token),
    };
    sessions.set(token, current);
    return current;
  };

  const register = (
    kind: 'invoke' | 'send',
    channel: string,
    fn: (payload: unknown, ev: IpcEvent) => unknown,
  ): void => {
    kinds.set(channel, kind);
    methods[channel] = async (params = {}) => {
      const token = typeof params.__sessionToken === 'string' ? params.__sessionToken : '';
      const payload = { ...params };
      delete payload.__sessionToken;
      const active = token ? session(token) : null;
      if (active && channel === 'chrome:init' && !state.mainSession) state.mainSession = active;
      if (active && channel === 'onboard:list' && !state.wizardSession) state.wizardSession = active;
      const result = await fn(payload, { sender: { sessionToken: token } });
      return kind === 'send' ? null : result;
    };
  };

  return {
    handle: (channel, fn) => register('invoke', channel, fn),
    on: (channel, fn) => register('send', channel, fn),
    channels: () => [...kinds.keys()],
    kindOf: (channel) => kinds.get(channel),
    session,
  };
}
