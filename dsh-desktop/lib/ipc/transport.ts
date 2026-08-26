/**
 * lib/ipc/transport.ts — IPC 传输面中立化（Task 6.1）。
 *
 * 42 个 channel 的 handler 逻辑本就宿主中立，legacy-shell 耦合仅在传输：
 * ipcMain.handle/on 注册与 event.sender 身份校验。本模块把传输抽象为
 * IpcSurface（注册面）+ IpcSender（来源身份 token），handler 改经注册面
 * 挂载、来源校验改比对 bridge 会话 token（lib/ipc/sender.ts）：
 *   · legacy-shell：host-legacy-shell/ipc.ts 的 legacy-shellIpcSurface()（token＝
 *     webContents.id，与宿主登记的 BridgeSession.id 一致）
 *   · Tauri sidecar：Task 7 的 JSON-RPC 注册面（token＝WS 桥会话）
 *   · Node 测试：createRecordingIpcSurface() 记录 handler 供直调
 */

/** IPC 调用来源身份（宿主中立）：sessionToken 与 state 登记的会话比对。 */
export interface IpcSender {
  sessionToken: string;
}

// 宿主装配期注入的缺省注册面：boot 链（lib/boot.ts）调 registerIpc() 时不
// 持有宿主对象，经这里取宿主在装配段（legacy-shell main.ts / sidecar server.ts）
// 预先注入的传输面；测试与显式传参调用方不受影响。
let defaultSurface: IpcSurface | null = null;

/** 宿主装配期注入缺省注册面（须早于 boot 链的 registerIpc()）。 */
export function setDefaultIpcSurface(s: IpcSurface): void {
  defaultSurface = s;
}

/** 取缺省注册面（未注入即抛错——装配期漏注属于宿主接线缺陷，不应静默）。 */
export function defaultIpcSurface(): IpcSurface {
  if (!defaultSurface) {
    throw new Error('IpcSurface 未注入：宿主装配期需先 setDefaultIpcSurface()');
  }
  return defaultSurface;
}

/** handler 收到的最小事件上下文（无 legacy-shell IpcMainEvent 依赖）。 */
export interface IpcEvent {
  /** 来源会话 token（sender 校验用）。 */
  sender: IpcSender;
}

/**
 * IPC 注册面：invoke 语义（handle，有返回值/异常）与事件语义（on，
 * 单向推送）。legacy-shell 映射 ipcMain.handle/on；sidecar 映射 JSON-RPC
 * 方法注册（Task 7.1）。
 */
export interface IpcSurface {
  handle(channel: string, fn: (payload: unknown, ev: IpcEvent) => unknown): void;
  on(channel: string, fn: (payload: unknown, ev: IpcEvent) => void): void;
}

/** 测试清理：清空装配期注入的缺省注册面。 */
export function resetDefaultIpcSurface(): void {
  defaultSurface = null;
}

/**
 * 记录型注册面（测试用）：handler 进表可直调，payload/来源 token 模拟
 * legacy-shell 端语义（含未登记 channel 的调用报错）。
 */
export function createRecordingIpcSurface(): IpcSurface & {
  invoke(channel: string, payload?: unknown, sessionToken?: string): Promise<unknown>;
  emit(channel: string, payload?: unknown, sessionToken?: string): void;
  channels(): string[];
} {
  const handlers = new Map<string, (payload: unknown, ev: IpcEvent) => unknown>();
  const listeners = new Map<string, Array<(payload: unknown, ev: IpcEvent) => void>>();
  return {
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
    on: (channel, fn) => {
      const arr = listeners.get(channel) ?? [];
      arr.push(fn);
      listeners.set(channel, arr);
    },
    invoke: async (channel, payload, sessionToken = 'test-session') => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error('no handler: ' + channel);
      return fn(payload, { sender: { sessionToken } });
    },
    emit: (channel, payload, sessionToken = 'test-session') => {
      for (const fn of listeners.get(channel) ?? []) fn(payload, { sender: { sessionToken } });
    },
    channels: () => [...handlers.keys(), ...listeners.keys()],
  };
}
