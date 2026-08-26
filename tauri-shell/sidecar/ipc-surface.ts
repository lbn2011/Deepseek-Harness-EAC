import type { BridgeSession } from '../../dsh-desktop/lib/host-ctx.js';
import { state } from '../../dsh-desktop/lib/state.js';
import type { IpcEvent, IpcSurface } from '../../dsh-desktop/lib/ipc/transport.js';

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
