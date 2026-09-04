# Deepseek-Harness-EAC 长期项目笔记

## 仓库结构（2026-08 现状）

- 本地 main 与上游 upsterm/main（zouyuxuan122）双向分叉：merge-base=671e87ec，本地领先 123 / 落后 32。**不要直接 git merge**（merge-tree 试算 48 冲突文件、15+ modify/delete 结构性冲突）；上游修复走定点移植。
- 本地主线重构："统一 lib 模块族"——lib/desktop/* 已删，宿主注入走 lib/host-ctx.ts；sidecar（tauri-shell/sidecar/server.ts）顶层 load() 全部 lib 模块。
- IPC 双通道命名：页面桥 bridge.ts 走冒号通道（chrome:init / dsh:* / snapshot:*），经 sidecar 的 createSidecarIpcSurface 注册进 methods 表；点号通道（win.*/menu.action/boot.*）由 Rust 壳 WS 中继拦截或 sidecar 原生 methods 处理。sender 校验 = 会话 token 绑定（state.mainSession），token 由壳在 initialization_script 注入 __DSH_BRIDGE_SESSION__。
- sidecar/*.js、lib/*.js 是 tsc 编译产物（gitignored），编译配置在 dsh-desktop/tsconfig.json（include 覆盖 ../tauri-shell/sidecar）。Rust 经 include_str! 内嵌 bridge.js——改完 TS 必须先 tsc 再 cargo build。

## 本机环境坑

- Windows 受控文件夹访问 (CFA) 拦截 cargo.exe 写 Desktop 下 target → `CARGO_TARGET_DIR=%LOCALAPPDATA%\Temp\dsh-cargo-target` 绕开。
- 2026-08-30 起本机 VS 18 BuildTools 的 link.exe 启动即崩 0xC0000139 → cargo check/test 不可用，待修复 VS Build Tools。
- Node 测试须 26+：用 `C:\Program Files\nodejs\node.exe`（managed 22 会拒跑）；测试套件 110 文件全量约 40min+。

## bug-report.md 维护约定

- 发现即增量写入；修复后在条目标题加 ✅ + 日期 + 一句话修复说明；S 级速览表同步更新状态列。
