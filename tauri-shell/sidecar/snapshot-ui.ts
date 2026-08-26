/**
 * preload/snapshot-ui.ts — 快照管理器面板（⋯ 菜单「快照管理器」入口）。
 *
 * 全屏 overlay（毛玻璃 + 高 z-index，样式全部自带前缀隔离，不依赖页面
 * CSS）。布局：
 *   工具栏：分支选择/新建/删除 + 立即备份 + 回收空间 + 设置开关
 *   主区：左侧 git 式备份树（按分支分泳道，共享祖先只出现一次），
 *         右侧设置抽屉（定时备份计划 + 备份排除列表）
 *   行操作：恢复到该快照（含安全快照确认）/ 查看文件清单 / 删除 / 从该快照建分支
 *
 * 数据全部经 window.dshDesktop.snapshot.*（contextBridge → 主进程
 * lib/snapshot/manager.ts → Rust 引擎）。
 */

type DshDesktopApi = any;

const PANEL_ID = '__dsh_snapshot_panel__';

/** overview 返回的数据面（与 lib/snapshot/manager.ts 对齐）。 */
interface SnapOverview {
  ok: boolean;
  error?: string;
  data?: {
    nativeAvailable: boolean;
    storeDir: string;
    sourceDir: string;
    config: SnapConfig;
    defaultExclusions: string[];
    branches: SnapBranch[];
    snapshots: SnapSummary[];
    scheduler: { armed: boolean; nextRunMs: number | null };
  };
}
interface SnapConfig {
  exclusions: string[];
  scheduleEnabled: boolean;
  scheduleMode: string;
  intervalMinutes: number;
  dailyTime: string;
  currentBranch: string;
}
interface SnapBranch {
  name: string;
  head: string;
  createdAtMs: number;
  isCurrent: boolean;
}
interface SnapSummary {
  id: string;
  parent: string | null;
  branch: string;
  message: string;
  createdAtMs: number;
  trigger: string;
  filesTotal: number;
  filesNew: number;
  bytesNew: number;
  filesSkipped: number;
}

const LANE_COLORS = ['#4f8cff', '#3ddc84', '#ffb454', '#c792ea', '#ff7a85', '#5ad7e0'];

function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c] ?? c,
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function triggerLabel(t: string): string {
  if (t === 'scheduled') return '定时';
  if (t === 'restore-point') return '恢复点';
  return '手动';
}

const CSS = `
#${PANEL_ID}{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;
  font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif)}
#${PANEL_ID} .snap-mask{position:absolute;inset:0;background:rgba(4,8,18,.55);backdrop-filter:blur(6px)}
#${PANEL_ID} .snap-panel{position:relative;width:min(920px,94vw);height:min(640px,88vh);display:flex;flex-direction:column;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0d1526) 97%,white);color:var(--dsw-alias-label-primary,#e6ecff);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:16px;
  box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden}
#${PANEL_ID} .snap-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
#${PANEL_ID} .snap-title{font-size:15px;font-weight:600}
#${PANEL_ID} .snap-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);font-family:Consolas,monospace;
  max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .snap-close{margin-left:auto;width:30px;height:28px;display:grid;place-items:center;border:none;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;font-size:16px}
#${PANEL_ID} .snap-close:hover{background:rgba(255,255,255,.1);color:#fff}
#${PANEL_ID} .snap-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 18px;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
#${PANEL_ID} .snap-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:transparent;
  color:var(--dsw-alias-label-primary,#dbe4f8);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
#${PANEL_ID} .snap-btn:hover{background:rgba(255,255,255,.08)}
#${PANEL_ID} .snap-btn:disabled{opacity:.45;cursor:default}
#${PANEL_ID} .snap-btn-primary{background:#2f6bff;border-color:#2f6bff;color:#fff}
#${PANEL_ID} .snap-btn-primary:hover{background:#4079ff}
#${PANEL_ID} .snap-btn-danger{color:var(--dsw-alias-state-error-primary,#ff7a85)}
#${PANEL_ID} .snap-select{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:rgba(255,255,255,.05);
  color:var(--dsw-alias-label-primary,#dbe4f8);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;max-width:180px}
#${PANEL_ID} .snap-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);margin-left:auto}
#${PANEL_ID} .snap-main{flex:1;display:flex;min-height:0}
#${PANEL_ID} .snap-tree{flex:1;overflow-y:auto;padding:10px 14px}
#${PANEL_ID} .snap-lane{margin-bottom:10px}
#${PANEL_ID} .snap-lane-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#a9b8de);
  padding:4px 8px;position:sticky;top:0;background:color-mix(in srgb,var(--dsw-alias-bg-base,#0d1526) 97%,white);z-index:1}
#${PANEL_ID} .snap-lane-dot{width:8px;height:8px;border-radius:50%;flex:none}
#${PANEL_ID} .snap-lane-name{font-weight:600;color:var(--dsw-alias-label-primary,#e6ecff)}
#${PANEL_ID} .snap-lane-tag{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid rgba(255,255,255,.2);color:#8b9ac4}
#${PANEL_ID} .snap-row{position:relative;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 26px;border-radius:10px;min-height:44px}
#${PANEL_ID} .snap-row:hover{background:rgba(255,255,255,.05)}
#${PANEL_ID} .snap-row::before{content:"";position:absolute;left:14px;top:0;bottom:0;width:2px;background:var(--lane,rgba(255,255,255,.14))}
#${PANEL_ID} .snap-row:first-of-type::before{top:16px}
#${PANEL_ID} .snap-row:last-of-type::before{bottom:auto;height:16px}
#${PANEL_ID} .snap-node{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:10px;height:10px;border-radius:50%;
  background:var(--lane,#4f8cff);box-shadow:0 0 0 3px color-mix(in srgb,var(--lane,#4f8cff) 30%,transparent)}
#${PANEL_ID} .snap-msg{font-size:12.5px;line-height:17px;min-width:0;flex:1}
#${PANEL_ID} .snap-msg-title{display:flex;align-items:center;gap:6px}
#${PANEL_ID} .snap-msg-note{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#5f6f9c);font-family:Consolas,monospace}
#${PANEL_ID} .snap-badge{font-size:10px;padding:1px 7px;border-radius:999px;flex:none;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));color:#93a5d8}
#${PANEL_ID} .snap-badge-head{color:#3ddc84;border-color:rgba(61,220,132,.5)}
#${PANEL_ID} .snap-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);text-align:right;flex:none;line-height:15px;
  font-family:Consolas,monospace;min-width:130px}
#${PANEL_ID} .snap-acts{display:flex;gap:4px;flex:none}
#${PANEL_ID} .snap-act{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#8b9ac4);
  border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;font-family:inherit}
#${PANEL_ID} .snap-act:hover{background:rgba(255,255,255,.1);color:var(--dsw-alias-label-primary,#eef2ff)}
#${PANEL_ID} .snap-act-danger:hover{color:#ff7a85}
#${PANEL_ID} .snap-files{margin:2px 8px 8px 26px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  border-radius:8px;background:rgba(0,0,0,.2);padding:8px 10px;max-height:220px;overflow-y:auto}
#${PANEL_ID} .snap-files div{font-size:11px;color:#a9b8de;font-family:Consolas,monospace;line-height:18px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .snap-empty{padding:40px 20px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b9ac4);font-size:12.5px;line-height:22px}
#${PANEL_ID} .snap-side{width:300px;flex:none;border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));
  overflow-y:auto;padding:14px 16px;display:none}
#${PANEL_ID} .snap-side.open{display:block}
#${PANEL_ID} .snap-side h3{font-size:12.5px;margin:4px 0 8px;font-weight:600}
#${PANEL_ID} .snap-side h4{font-size:11px;margin:14px 0 6px;color:var(--dsw-alias-label-tertiary,#8b9ac4);font-weight:600}
#${PANEL_ID} .snap-field{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px}
#${PANEL_ID} .snap-field label{color:var(--dsw-alias-label-secondary,#b8c5ea)}
#${PANEL_ID} .snap-input{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:rgba(255,255,255,.05);
  color:var(--dsw-alias-label-primary,#dbe4f8);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;width:100px}
#${PANEL_ID} .snap-textarea{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:rgba(255,255,255,.05);
  color:var(--dsw-alias-label-primary,#dbe4f8);border-radius:8px;padding:8px 10px;font:12px Consolas,monospace;width:100%;
  box-sizing:border-box;height:130px;resize:vertical;line-height:19px}
#${PANEL_ID} .snap-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);line-height:16px;margin:6px 0}
#${PANEL_ID} .snap-modal{position:absolute;inset:0;background:rgba(4,8,18,.6);display:flex;align-items:center;justify-content:center;z-index:2}
#${PANEL_ID} .snap-modal-card{width:min(400px,90%);background:color-mix(in srgb,var(--dsw-alias-bg-base,#0d1526) 97%,white);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:14px;padding:18px;box-shadow:0 16px 60px rgba(0,0,0,.55)}
#${PANEL_ID} .snap-modal-title{font-size:13.5px;font-weight:600;margin-bottom:8px}
#${PANEL_ID} .snap-modal-body{font-size:12px;color:var(--dsw-alias-label-secondary,#b8c5ea);line-height:19px;margin-bottom:14px}
#${PANEL_ID} .snap-modal-acts{display:flex;justify-content:flex-end;gap:8px}
#${PANEL_ID} .snap-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(4,8,18,.5);z-index:3;font-size:13px;color:#dbe4f8}
#${PANEL_ID} .snap-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:7px 16px;border-radius:999px;
  font-size:12px;background:rgba(20,30,55,.95);border:1px solid rgba(255,255,255,.15);color:#dbe4f8;max-width:80%}
#${PANEL_ID} .snap-toast.err{color:#ff9aa2}
`;

let panelEl: HTMLElement | null = null;
let apiRef: DshDesktopApi | null = null;
let overviewCache: SnapOverview['data'] | null = null;
let settingsOpen = false;
let expandedId: string | null = null;

/** 打开面板（chrome.ts 菜单项调用；惰性建 DOM）。 */
export function openSnapshotPanel(api: DshDesktopApi): void {
  apiRef = api;
  if (!panelEl) buildPanel();
  if (!panelEl) return;
  panelEl.hidden = false;
  void refresh();
}

function closePanel(): void {
  if (panelEl) panelEl.hidden = true;
}

function buildPanel(): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = PANEL_ID;
  el.hidden = true;
  el.innerHTML = `
    <div class="snap-mask"></div>
    <div class="snap-panel">
      <div class="snap-head">
        <span class="snap-title">快照管理器</span>
        <span class="snap-sub" id="snap-store-path"></span>
        <button class="snap-close" title="关闭 (Esc)">✕</button>
      </div>
      <div class="snap-toolbar">
        <select class="snap-select" id="snap-branch-select" title="当前分支（手动/定时备份落在此分支）"></select>
        <button class="snap-btn" id="snap-branch-new">新建分支</button>
        <button class="snap-btn snap-btn-danger" id="snap-branch-del">删除当前分支</button>
        <button class="snap-btn snap-btn-primary" id="snap-create-now">立即备份</button>
        <button class="snap-btn" id="snap-gc">回收空间</button>
        <button class="snap-btn" id="snap-settings-toggle">设置</button>
        <span class="snap-hint" id="snap-sched-hint"></span>
      </div>
      <div class="snap-main">
        <div class="snap-tree" id="snap-tree"></div>
        <div class="snap-side" id="snap-side">
          <h3>定时备份</h3>
          <div class="snap-field">
            <input type="checkbox" id="snap-sched-enabled" />
            <label for="snap-sched-enabled">启用定时备份</label>
          </div>
          <div class="snap-field">
            <select class="snap-select" id="snap-sched-mode" style="max-width:120px">
              <option value="daily">每天定时</option>
              <option value="interval">间隔周期</option>
            </select>
            <span id="snap-sched-param"></span>
          </div>
          <div class="snap-field" id="snap-sched-daily-row">
            <label>时间</label>
            <input class="snap-input" id="snap-sched-daily" type="text" placeholder="03:00" style="width:70px" />
          </div>
          <div class="snap-field" id="snap-sched-interval-row">
            <label>间隔</label>
            <input class="snap-input" id="snap-sched-interval" type="number" min="1" max="525600" style="width:80px" />
            <span>分钟</span>
          </div>
          <h4>备份排除列表</h4>
          <textarea class="snap-textarea" id="snap-exclusions" spellcheck="false"
            placeholder="每行一个模式：&#10;skills          # 任意层级同名目录&#10;profiles/web    # 指定目录&#10;*.log           # 后缀匹配"></textarea>
          <p class="snap-note">无 <code>/</code> 的模式按路径段匹配任意深度；含 <code>/</code> 的按相对路径匹配。默认排除 skills / sessions / .agent-presets / memories / node_modules。</p>
          <div class="snap-field" style="margin-top:12px">
            <button class="snap-btn snap-btn-primary" id="snap-config-save">保存设置</button>
            <button class="snap-btn" id="snap-excl-reset">恢复默认排除</button>
          </div>
          <h4>存储</h4>
          <p class="snap-note" id="snap-store-info"></p>
        </div>
      </div>
      <div class="snap-modal" id="snap-modal" hidden></div>
      <div class="snap-busy" id="snap-busy" hidden>处理中…</div>
    </div>`;
  document.body.appendChild(el);
  panelEl = el;
  bindEvents(el);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el && !el.hidden) closePanel();
  });
}

function bindEvents(el: HTMLElement): void {
  el.querySelector('.snap-mask')?.addEventListener('click', closePanel);
  el.querySelector('.snap-close')?.addEventListener('click', closePanel);
  el.querySelector('#snap-branch-select')?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (name && overviewCache && name !== overviewCache.config.currentBranch) {
      void run(`切换到分支 ${name}`, () => apiRef?.snapshot.setCurrentBranch(name));
    }
  });
  el.querySelector('#snap-branch-new')?.addEventListener('click', () => showBranchModal());
  el.querySelector('#snap-branch-del')?.addEventListener('click', () => {
    if (!overviewCache) return;
    const cur = overviewCache.config.currentBranch;
    if (cur === 'main') {
      toast('main 是默认分支，不可删除', true);
      return;
    }
    showConfirm('删除分支', `删除分支「${cur}」？该分支的快照本体保留（可重建分支找回），仅移除指针。`, () =>
      void run('删除分支', () => apiRef?.snapshot.deleteBranch(cur)),
    );
  });
  el.querySelector('#snap-create-now')?.addEventListener('click', () => {
    void run('立即备份', () => apiRef?.snapshot.create());
  });
  el.querySelector('#snap-gc')?.addEventListener('click', () => {
    showConfirm('回收空间', '删除所有已删快照不再引用的备份对象，释放磁盘空间。继续？', () =>
      void run('回收空间', () => apiRef?.snapshot.gc()),
    );
  });
  el.querySelector('#snap-settings-toggle')?.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    el.querySelector('#snap-side')?.classList.toggle('open', settingsOpen);
  });
  el.querySelector('#snap-sched-mode')?.addEventListener('change', () => syncScheduleRows());
  el.querySelector('#snap-config-save')?.addEventListener('click', () => saveConfigForm());
  el.querySelector('#snap-excl-reset')?.addEventListener('click', () => {
    if (!overviewCache) return;
    const ta = el.querySelector<HTMLTextAreaElement>('#snap-exclusions');
    if (ta) ta.value = overviewCache.defaultExclusions.join('\n');
  });
}

function syncScheduleRows(): void {
  const el = panelEl;
  if (!el) return;
  const mode = (el.querySelector('#snap-sched-mode') as HTMLSelectElement | null)?.value ?? 'daily';
  el.querySelector('#snap-sched-daily-row')?.toggleAttribute('hidden', mode !== 'daily');
  el.querySelector('#snap-sched-interval-row')?.toggleAttribute('hidden', mode !== 'interval');
}

function saveConfigForm(): void {
  const el = panelEl;
  if (!el || !overviewCache) return;
  const enabled = (el.querySelector('#snap-sched-enabled') as HTMLInputElement).checked;
  const mode = (el.querySelector('#snap-sched-mode') as HTMLSelectElement).value;
  const daily = (el.querySelector('#snap-sched-daily') as HTMLInputElement).value.trim();
  const interval = Number((el.querySelector('#snap-sched-interval') as HTMLInputElement).value || 0);
  const excl = (el.querySelector('#snap-exclusions') as HTMLTextAreaElement).value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  void run('保存设置', () =>
    apiRef?.snapshot.saveConfig({
      scheduleEnabled: enabled,
      scheduleMode: mode,
      dailyTime: mode === 'daily' ? daily : overviewCache?.config.dailyTime ?? '03:00',
      intervalMinutes: mode === 'interval' ? Math.max(1, Math.floor(interval)) : overviewCache?.config.intervalMinutes ?? 1440,
      exclusions: excl,
    }),
  );
}

/** 运行一个异步操作：busy 遮罩 + 完成后刷新 + 错误 toast。 */
async function run(label: string, op: () => unknown): Promise<void> {
  const el = panelEl;
  if (!el) return;
  const busyEl = el.querySelector('#snap-busy') as HTMLElement | null;
  if (busyEl && !busyEl.hidden) return;
  if (busyEl) {
    busyEl.textContent = label + '…';
    busyEl.hidden = false;
  }
  try {
    const r = (await op()) as { ok?: boolean; error?: string } | null | undefined;
    if (r && r.ok === false) toast(label + '失败：' + (r.error ?? '未知错误'), true);
    else toast(label + '完成');
  } catch (err) {
    toast(label + '失败：' + String((err as Error).message || err), true);
  } finally {
    if (busyEl) busyEl.hidden = true;
    await refresh();
  }
}

function toast(msg: string, isErr = false): void {
  const el = panelEl;
  if (!el) return;
  const t = document.createElement('div');
  t.className = 'snap-toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  el.querySelector('.snap-panel')?.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 4200 : 2200);
}

function showModal(html: string): HTMLElement | null {
  const el = panelEl;
  if (!el) return null;
  const modal = el.querySelector<HTMLElement>('#snap-modal');
  if (!modal) return null;
  modal.innerHTML = `<div class="snap-modal-card">${html}</div>`;
  modal.hidden = false;
  return modal;
}

function hideModal(): void {
  const modal = panelEl?.querySelector<HTMLElement>('#snap-modal');
  if (modal) modal.hidden = true;
}

function showConfirm(title: string, body: string, onOk: () => void): void {
  const modal = showModal(`
    <div class="snap-modal-title">${esc(title)}</div>
    <div class="snap-modal-body">${esc(body)}</div>
    <div class="snap-modal-acts">
      <button class="snap-btn" data-x="cancel">取消</button>
      <button class="snap-btn snap-btn-primary" data-x="ok">确定</button>
    </div>`);
  if (!modal) return;
  modal.querySelector('[data-x="cancel"]')?.addEventListener('click', hideModal);
  modal.querySelector('[data-x="ok"]')?.addEventListener('click', () => {
    hideModal();
    onOk();
  });
}

function showRestoreModal(snap: SnapSummary): void {
  const modal = showModal(`
    <div class="snap-modal-title">恢复到此快照</div>
    <div class="snap-modal-body">
      将把 .dsh 目录恢复到 <b>${esc(fmtTime(snap.createdAtMs))}</b>（${esc(snap.message)}）的状态：<br />
      · 写回快照内的 ${snap.filesTotal} 个文件<br />
      · 删除快照之后新增的文件<br />
      · 排除列表内的目录（skills / sessions 等）不受影响<br />
      · 恢复期间将自动重启 Web 服务
    </div>
    <div class="snap-field">
      <input type="checkbox" id="snap-restore-safety" checked />
      <label for="snap-restore-safety">恢复前自动创建安全快照（推荐）</label>
    </div>
    <div class="snap-modal-acts">
      <button class="snap-btn" data-x="cancel">取消</button>
      <button class="snap-btn snap-btn-primary" data-x="ok">恢复</button>
    </div>`);
  if (!modal) return;
  modal.querySelector('[data-x="cancel"]')?.addEventListener('click', hideModal);
  modal.querySelector('[data-x="ok"]')?.addEventListener('click', () => {
    const safety = (modal.querySelector('#snap-restore-safety') as HTMLInputElement).checked;
    hideModal();
    void run('恢复', () => apiRef?.snapshot.restore(snap.id, safety));
  });
}

function showBranchModal(fromSnap?: SnapSummary): void {
  const modal = showModal(`
    <div class="snap-modal-title">${fromSnap ? '从快照创建分支' : '新建分支'}</div>
    <div class="snap-modal-body">
      ${fromSnap ? `新分支的起点为快照 ${esc(fromSnap.id)}（${esc(fmtTime(fromSnap.createdAtMs))}）。` : '新分支从当前分支的最新快照开始。'}
      创建后将切换到新分支，之后的备份会落在新分支上。
    </div>
    <div class="snap-field">
      <label>分支名</label>
      <input class="snap-input" id="snap-branch-name" type="text" placeholder="experiment" style="flex:1;width:auto"
        maxlength="64" />
    </div>
    <div class="snap-modal-acts">
      <button class="snap-btn" data-x="cancel">取消</button>
      <button class="snap-btn snap-btn-primary" data-x="ok">创建</button>
    </div>`);
  if (!modal) return;
  const input = modal.querySelector('#snap-branch-name') as HTMLInputElement;
  input.focus();
  const doCreate = (): void => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    hideModal();
    void run('创建分支', async () => {
      const r = (await apiRef?.snapshot.createBranch(name, fromSnap?.id)) as { ok?: boolean; error?: string } | null;
      if (r && r.ok !== false) await apiRef?.snapshot.setCurrentBranch(name);
      return r;
    });
  };
  modal.querySelector('[data-x="cancel"]')?.addEventListener('click', hideModal);
  modal.querySelector('[data-x="ok"]')?.addEventListener('click', doCreate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
  });
}

/** 拉取 overview 并重渲染。 */
async function refresh(): Promise<void> {
  const el = panelEl;
  if (!el || !apiRef) return;
  try {
    const r = (await apiRef.snapshot.overview()) as SnapOverview;
    if (!r.ok || !r.data) {
      renderError(r.error ?? '快照引擎不可用');
      return;
    }
    overviewCache = r.data;
    render(r.data);
  } catch (err) {
    renderError(String((err as Error).message || err));
  }
}

function renderError(msg: string): void {
  const tree = panelEl?.querySelector('#snap-tree');
  if (tree) tree.innerHTML = `<div class="snap-empty">${esc(msg)}<br /><br />快照引擎位于 native/snapshot/index.node，<br />请重新安装客户端或运行 npm run build:native。</div>`;
}

/** 渲染主体：分支下拉 / 调度提示 / 备份树 / 设置表单。 */
function render(d: NonNullable<SnapOverview['data']>): void {
  const el = panelEl;
  if (!el) return;
  const sub = el.querySelector('#snap-store-path');
  if (sub) sub.textContent = d.storeDir;
  // 分支下拉
  const sel = el.querySelector('#snap-branch-select') as HTMLSelectElement | null;
  if (sel) {
    sel.innerHTML = d.branches
      .map((b) => `<option value="${esc(b.name)}" ${b.name === d.config.currentBranch ? 'selected' : ''}>${esc(b.name)}${b.isCurrent ? ' （当前）' : ''}</option>`)
      .join('');
  }
  // 调度提示
  const hint = el.querySelector('#snap-sched-hint');
  if (hint) {
    if (d.scheduler.armed && d.scheduler.nextRunMs) {
      const plan = d.config.scheduleMode === 'daily' ? `每天 ${d.config.dailyTime}` : `每 ${d.config.intervalMinutes} 分钟`;
      hint.textContent = `定时备份已开启（${plan}），下次：${fmtTime(d.scheduler.nextRunMs)}`;
    } else if (d.config.scheduleEnabled) {
      hint.textContent = '定时备份已开启，等待调度';
    } else {
      hint.textContent = '定时备份已关闭';
    }
  }
  renderTree(d);
  renderSettings(d);
}

/** 备份树：按分支分泳道；共享祖先归入先出现的分支，避免重复。 */
function renderTree(d: NonNullable<SnapOverview['data']>): void {
  const tree = panelEl?.querySelector('#snap-tree');
  if (!tree) return;
  const byId = new Map(d.snapshots.map((s) => [s.id, s]));
  // 分支排序：当前分支优先，其余按创建时间
  const branches = [...d.branches].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (a.createdAtMs || 9e15) - (b.createdAtMs || 9e15);
  });
  const claimed = new Set<string>();
  const lanes: Array<{ branch: SnapBranch; items: SnapSummary[] }> = [];
  for (const b of branches) {
    const items: SnapSummary[] = [];
    let cur = b.head ? byId.get(b.head) : undefined;
    while (cur) {
      if (!claimed.has(cur.id)) {
        claimed.add(cur.id);
        items.push(cur);
      }
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    if (items.length > 0) lanes.push({ branch: b, items });
  }
  // 孤儿快照（分支指针已删但快照还在）：单独泳道兜底显示
  const orphans = d.snapshots.filter((s) => !claimed.has(s.id));
  if (orphans.length > 0) lanes.push({ branch: { name: '（已删分支）', head: '', createdAtMs: 0, isCurrent: false }, items: orphans });

  if (lanes.length === 0) {
    tree.innerHTML = `<div class="snap-empty">还没有任何快照<br /><br />点击上方「立即备份」创建第一个快照<br />定时备份${d.config.scheduleEnabled ? '已开启，将按计划自动备份' : '当前处于关闭状态，可在设置中开启'}</div>`;
    return;
  }
  const headIds = new Set(d.branches.map((b) => b.head).filter(Boolean));
  tree.innerHTML = lanes
    .map((lane, li) => {
      const color = LANE_COLORS[li % LANE_COLORS.length];
      const rows = lane.items
        .map((s) => {
          const isHead = headIds.has(s.id);
          return `<div class="snap-row" style="--lane:${color}" data-id="${esc(s.id)}">
            <span class="snap-node"></span>
            <div class="snap-msg">
              <div class="snap-msg-title">${esc(s.message)}
                <span class="snap-badge${isHead ? ' snap-badge-head' : ''}">${isHead ? 'HEAD' : ''}</span>
                <span class="snap-badge">${esc(triggerLabel(s.trigger))}</span>
              </div>
              <div class="snap-msg-note">${esc(s.id)}</div>
            </div>
            <div class="snap-meta">${esc(fmtTime(s.createdAtMs))}<br />${s.filesTotal} 文件 · 增量 ${s.filesNew}（${fmtBytes(s.bytesNew)}）</div>
            <div class="snap-acts">
              <button class="snap-act" data-op="restore" title="恢复 .dsh 目录到此快照">恢复</button>
              <button class="snap-act" data-op="branch" title="从该快照创建分支">建分支</button>
              <button class="snap-act" data-op="files" title="查看文件清单">详情</button>
              <button class="snap-act snap-act-danger" data-op="del" title="删除该快照">删除</button>
            </div>
          </div>${expandedId === s.id ? '<div class="snap-files" id="snap-files-box">加载中…</div>' : ''}`;
        })
        .join('');
      return `<div class="snap-lane">
        <div class="snap-lane-head">
          <span class="snap-lane-dot" style="background:${color}"></span>
          <span class="snap-lane-name">${esc(lane.branch.name)}</span>
          ${lane.branch.isCurrent ? '<span class="snap-lane-tag">当前分支</span>' : ''}
          <span class="snap-lane-tag">${lane.items.length} 个快照</span>
        </div>${rows}</div>`;
    })
    .join('');

  // 行操作（事件委托）
  tree.querySelectorAll<HTMLElement>('.snap-row').forEach((row) => {
    row.querySelectorAll<HTMLButtonElement>('.snap-act').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = row.dataset.id ?? '';
        const snap = d.snapshots.find((s) => s.id === id);
        if (!snap) return;
        const op = btn.dataset.op;
        if (op === 'restore') showRestoreModal(snap);
        else if (op === 'branch') showBranchModal(snap);
        else if (op === 'del') {
          showConfirm('删除快照', `删除快照 ${snap.id}？\n其引用的备份对象在「回收空间」时才真正释放。`, () =>
            void run('删除快照', () => apiRef?.snapshot.deleteSnapshot(id)),
          );
        } else if (op === 'files') {
          expandedId = expandedId === id ? null : id;
          void refresh();
          if (expandedId === id) void loadFiles(id);
        }
      });
    });
  });
}

async function loadFiles(id: string): Promise<void> {
  const box = panelEl?.querySelector('#snap-files-box');
  if (!box || !apiRef) return;
  try {
    const r = (await apiRef.snapshot.detail(id)) as {
      ok: boolean;
      error?: string;
      data?: { files: Array<{ path: string; size: number }> };
    };
    if (!box.isConnected) return;
    if (!r.ok || !r.data) {
      box.textContent = r.error ?? '读取失败';
      return;
    }
    const files = r.data.files;
    const MAX = 400;
    box.innerHTML =
      files
        .slice(0, MAX)
        .map((f) => `<div title="${esc(f.path)}">${esc(f.path)} <span style="color:#5f6f9c">(${fmtBytes(f.size)})</span></div>`)
        .join('') + (files.length > MAX ? `<div style="color:#5f6f9c">… 共 ${files.length} 个文件（仅显示前 ${MAX} 个）</div>` : '');
  } catch (err) {
    box.textContent = String((err as Error).message || err);
  }
}

/** 设置抽屉表单回填。 */
function renderSettings(d: NonNullable<SnapOverview['data']>): void {
  const el = panelEl;
  if (!el) return;
  (el.querySelector('#snap-sched-enabled') as HTMLInputElement).checked = d.config.scheduleEnabled;
  (el.querySelector('#snap-sched-mode') as HTMLSelectElement).value = d.config.scheduleMode;
  (el.querySelector('#snap-sched-daily') as HTMLInputElement).value = d.config.dailyTime;
  (el.querySelector('#snap-sched-interval') as HTMLInputElement).value = String(d.config.intervalMinutes);
  const ta = el.querySelector('#snap-exclusions') as HTMLTextAreaElement;
  if (ta && document.activeElement !== ta) ta.value = d.config.exclusions.join('\n');
  const info = el.querySelector('#snap-store-info');
  if (info) info.textContent = `备份对象库：${d.storeDir}\n备份源目录：${d.sourceDir}\n存储在 .dsh 之外，恢复 .dsh 不会影响快照库。`;
  el.querySelector('#snap-side')?.classList.toggle('open', settingsOpen);
  syncScheduleRows();
}
