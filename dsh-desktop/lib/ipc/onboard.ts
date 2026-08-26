/**
 * lib/ipc/onboard.ts — 选择向导域 IPC（Task 4 自 registerChromeIpc 拆分；
 * Task 6.1 传输面化）。
 *
 * onboard:list / onboard:submit / onboard:close / onboard:open。
 * 来源校验：list/submit/close 只接受向导会话（fromWizardSession），
 * onboard:open 只接受主窗会话（fromMainSession）。
 */

import * as updater from '../../updater.js';
import * as onboardingLogic from '../../scripts/onboarding.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { updCtx } from '../proc.js';
import { ensureDesktopProfileInit } from '../paths.js';
import { COMPANION_PLUGINS } from '../plugin-registry-data.js';
import { pluginManagerSetEnabled } from '../plugin-manager-core.js';
import { restartWebServiceCore } from '../server.js';
import {
  buildOnboardingCatalog, pluginCurrentState, closeWizard, openPluginWizard,
} from '../onboarding.js';
import { fromMainSession, fromWizardSession } from './sender.js';
import type { IpcSurface } from './transport.js';

/** 注册选择向导域全部 channel（清单见文件头；boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerOnboardIpc(surface: IpcSurface): void {
  // 内置插件选择向导（assets/onboarding.html，onboarding-preload.js 桥）：
  //   list   —— 目录（核心/推荐标记 + 描述 + 体积）+ 模式 + 当前启停状态
  //   submit —— 校验选择 → 写 disabled/裸条目 → 持久化 settings → 关窗；
  //             rerun 模式随后重启 Web 服务使 host 侧插件生效
  //   close  —— 用户点「跳过」/关闭窗口（走 closed 事件的 cancelled 分支）
  surface.handle('onboard:list', async (_payload, ev) => {
    if (!fromWizardSession(ev)) return null;
    return {
      mode: state.wizardMode,
      catalog: buildOnboardingCatalog(),
      current: state.wizardMode === 'rerun' ? pluginCurrentState() : null,
    };
  });

  surface.handle('onboard:submit', async (payload, ev) => {
    if (!fromWizardSession(ev)) return { ok: false, error: 'unauthorized' };
    const { ids } = (payload ?? {}) as { ids?: unknown };
    // 首次向导时 sync 尚未运行、profile 目录可能还不存在：先按官方模板初始化
    // （package.json / pnpm-workspace.yaml / 空 patch 层），否则写盘 ENOENT。
    ensureDesktopProfileInit();
    const want = onboardingLogic.sanitizeSelection(ids, COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS);
    // 首次：patch 行尚未写全，normalize 全部非核心插件（current=null）；
    // 二次：只切换与用户选择不同的插件。
    const current = state.wizardMode === 'rerun' ? pluginCurrentState() : null;
    const ops = onboardingLogic.buildSelectionOps(
      COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS, want, current,
    );
    const errors: string[] = [];
    for (const op of ops) {
      try {
        const res = pluginManagerSetEnabled(op.id, op.enable);
        if (!res.ok) errors.push(op.id + ': ' + (res.error || 'unknown'));
        else log('plugin-manager', '向导已' + (op.enable ? '启用' : '停用') + '内置插件 ' + op.id);
      } catch (err) {
        errors.push(op.id + ': ' + String((err as Error).message));
      }
    }
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    s.builtinPluginSelection = Array.from(want);
    updater.saveSettings(updCtx(), s);
    log('boot', '插件选择向导已应用：' + ops.length + ' 个插件状态变更' + (errors.length ? '，失败 ' + errors.join('; ') : ''));
    const mode = state.wizardMode;
    closeWizard({ ok: true, applied: ops.length, errors });
    if (mode === 'rerun' && state.serverProc && state.serverProc.exitCode === null) {
      // 二次向导：重启 Web 服务让 host 侧插件生效（与插件市场安装后同路径）。
      void restartWebServiceCore();
    }
    return { ok: true, applied: ops.length, errors };
  });

  surface.on('onboard:close', (_payload, ev) => {
    if (!fromWizardSession(ev)) return;
    closeWizard({ ok: false, cancelled: true });
  });

  // 设置页「插件 → 选择向导」（dsh-plugin-wizard 插件）二次打开入口。
  surface.handle('onboard:open', (_payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    if (state.wizardSession && state.wizardSession.isAlive()) {
      state.wizardSession.focus();
      return { ok: true, reused: true };
    }
    void openPluginWizard({ mode: 'rerun' });
    return { ok: true };
  });
}
