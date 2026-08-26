/**
 * lib/snapshot/paths.ts — 快照管理的路径决策。
 *
 * 源目录 = 生效 DSH_HOME（state.dshHome 或 ~/.dsh，与 lib/paths.ts 同规则）。
 * 存储目录 = 源目录的同级兄弟 `.dsh-snapshots` —— 必须在 .dsh 之外：
 *   1. 自引用：存储在备份目标内会递归包含自身；
 *   2. 恢复安全：恢复 .dsh 时若存储也在其中，快照库会被一起回滚。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { state } from '../state.js';

/** 生效的 .dsh 目录（与 dsh CLI 的 DSH_HOME 解析一致）。 */
export function effectiveDshHome(): string {
  return state.dshHome || path.join(os.homedir(), '.dsh');
}

/** 快照存储目录（<.dsh 父目录>/.dsh-snapshots）。 */
export function snapshotStoreDir(): string {
  const home = effectiveDshHome();
  return path.join(path.dirname(path.resolve(home)), '.dsh-snapshots');
}
