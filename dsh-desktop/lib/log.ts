/**
 * lib/log.ts — 统一日志通道（Task 1.x 自 main.js 提取，逻辑逐行等价）。
 *
 * 双通道记录（日志系统接入 AC-1 / AC-3）：
 *   1) 旧 desktop.log 纯文本 —— 保留，便于 tail/外部脚本、NSIS 卸载诊断、
 *      非结构化查看；写入流由 main.js 启动时挂到 state.desktopLog。
 *   2) 结构化 logger.{level}(msg, { tag, ... }) —— JSON lines + PII 脱敏 +
 *      rotation + 诊断 zip 导出（见 logger.js / Task 6.2 拆分计划）。
 *
 * 本地时间 + 显式时区偏移：此前用 toISOString()（UTC），本地排查时易误判
 * （issue #4），故保留手工格式化。
 */

import * as structuredLogger from '../logger.js';
import { state } from './state.js';

/** 外部注入的日志出口（Tauri sidecar 宿主；null = 默认双通道行为）。 */
export type LogSink = (tag: string, msg: string) => void;

let sinkOverride: LogSink | null = null;

/**
 * 注入日志出口（Tauri sidecar boot 链调用，幂等；Task 3.5 吸收 main 侧
 * vnext-absorb 变体的导出面）。设置后 log() 只走注入 sink（sidecar 的
 * stderr → Rust 壳统一收集），不再写 desktop.log/结构化通道——两通道的
 * 初始化依赖 legacy-shell userData 流程，sidecar 宿主不适用。legacy-shell 宿主
 * 不调用本函数，行为保持双通道不变。
 */
export function setLogSink(fn: LogSink | null): void {
  sinkOverride = fn;
}

/** 把 Date 格式化为 `YYYY-MM-DD HH:mm:ss.SSS UTC+HH:MM`（本地时间+偏移）。 */
function formatLocalTimestamp(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    ` UTC${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/**
 * 统一日志入口。
 *
 * @param tag 子系统标签（如 'boot' / 'service' / 'guard'）；warn|err|error|fatal
 *            映射结构化 warn 级，debug|trace 映射 debug 级，其余 info 级。
 * @param msg 消息文本（结构化通道会做 PII 脱敏）。
 */
export function log(tag: string, msg: string): void {
  if (sinkOverride) {
    // sidecar 宿主：日志只走注入出口（sink 故障不影响业务）。
    try {
      sinkOverride(tag, msg);
    } catch {
      /* 忽略 sink 异常 */
    }
    return;
  }
  const line = `[${formatLocalTimestamp(new Date())}] [${tag}] ${msg}\n`;
  // 通道 1：desktop.log 纯文本（写入流可能尚未初始化/已销毁，静默容错）。
  try {
    if (state.desktopLog) state.desktopLog.write(line);
  } catch {
    /* 流已关闭等场景：忽略 */
  }
  // 调试开关下镜像到 stdout（dev / e2e 排查用）。
  if (process.env.DSH_DESKTOP_DEBUG) process.stdout.write(line);
  // 通道 2：结构化 JSON lines（logger.js 内部自带容错，这里再兜一层，
  // 保证任何情况下日志故障都不影响业务路径）。
  try {
    const level = /^(warn|warning|err|error|fatal)$/i.test(tag)
      ? 'warn'
      : /^debug$|trace$/i.test(tag)
        ? 'debug'
        : 'info';
    structuredLogger[level](msg, { tag });
  } catch {
    /* 结构化日志不可用时静默降级 */
  }
}
