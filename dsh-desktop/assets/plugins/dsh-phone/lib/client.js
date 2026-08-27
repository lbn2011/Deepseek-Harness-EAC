/**
 * dsh-phone — Web settings card (client half).
 *
 * Registers a 「连接手机 / Connect Phone」 section in the DSH Web settings page:
 *   - 状态区：桥运行状态 + 配对状态（等待/已批准/过期/未启动）
 *   - 「开始配对」：经 window.dshDesktop.phoneBridge.start() 向 Tauri 壳 sidecar
 *     请求 LAN 配对 → 渲染二维码（内置 qrcode-generator，经插件静态路由加载）
 *   - 「批准/拒绝」「断开」：配对决策（sidecar 的 decide/disconnect 只接受回环
 *     调用，WS 桥本身即回环，安全）
 *   - 手机端说明：手机端客户端正在开发中，接口（/api/rpc 白名单 + cookie）已预留
 *
 * 仅在 Tauri 壳（bridge.ts 提供了 phoneBridge 键组）下可用；Electron 开发壳
 * 的 preload 镜像会拒绝调用，这里兜底提示。
 *
 * Hand-written ModuleLoader bundle — no build step (same shape as computer-user).
 */
window.__ModuleLoader__.load({
  id: "dsh-phone",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS（theme tokens; own prefix）────────────────────────────────────
    var CSS =
      ".__ph_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__ph_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".__ph_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__ph_hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6}" +
      ".__ph_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__ph_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__ph_btn:disabled{opacity:.5;cursor:default}" +
      ".__ph_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__ph_qr{background:#fff;padding:10px;border-radius:10px;display:inline-block}" +
      ".__ph_url{font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}" +
      ".__ph_badge{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-state-business-primary)}";
    var tagId = "dsh-phone/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-phone";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    var NS = "dsh-phone";
    var inject = ["slots", "locale"];

    var zh = {
      nav: "连接手机",
      intro: "通过手机浏览器扫码配对，在手机上继续电脑里的 DSH 会话。手机端客户端正在开发中——配对与接口（白名单 RPC）已就绪，接入后将自动可用。",
      unavailable: "桌面桥不可用：phoneBridge 仅在 Tauri 桌面壳提供（Electron 开发壳不承载）。",
      statusIdle: "未启动：点击「开始配对」生成二维码。",
      statusRunning: "桥已运行（LAN {port}），等待手机扫码。",
      statusWaiting: "手机已打开配对页，等待你在电脑端批准…",
      statusApproved: "配对已批准：手机端已建立会话 cookie（手机端 UI 开发中）。",
      statusExpired: "配对已过期：请点击「重新配对」。",
      start: "开始配对",
      restart: "重新配对",
      stop: "停止",
      approve: "批准",
      reject: "拒绝",
      disconnect: "断开并失效",
      qrHint: "用手机浏览器（微信扫一扫选择「在浏览器打开」）扫码访问。",
      urlLabel: "或手动输入地址：",
      mobileDev: "手机端客户端开发中",
      mobileDevHint: "手机访问后当前显示开发中占位页；会话续聊等能力将在移动端完成开发后启用。",
      refresh: "刷新状态",
    };

    var en = {
      nav: "Connect Phone",
      intro: "Scan with your phone to continue DSH sessions from a mobile browser. The mobile client is under development — pairing and the whitelist-RPC interface are already in place.",
      unavailable: "Desktop bridge unavailable: phoneBridge is provided by the Tauri shell only.",
      statusIdle: "Not started: click \"Start pairing\" to show a QR code.",
      statusRunning: "Bridge running (LAN {port}), waiting for a scan.",
      statusWaiting: "Phone opened the pairing page; awaiting your approval on the desktop…",
      statusApproved: "Pairing approved: session cookie issued (mobile UI under development).",
      statusExpired: "Pairing expired: click \"Re-pair\".",
      start: "Start pairing",
      restart: "Re-pair",
      stop: "Stop",
      approve: "Approve",
      reject: "Reject",
      disconnect: "Disconnect & revoke",
      qrHint: "Scan with a mobile browser.",
      urlLabel: "Or open this address manually:",
      mobileDev: "Mobile client under development",
      mobileDevHint: "The phone currently sees a placeholder page; session features will light up once the mobile client ships.",
      refresh: "Refresh",
    };

    function bridge() {
      var w = typeof window !== "undefined" ? window : null;
      return w && w.dshDesktop && w.dshDesktop.phoneBridge ? w.dshDesktop.phoneBridge : null;
    }

    function statusText(t, status) {
      if (!status) return t("statusIdle");
      if (status.running === false) return t("statusIdle");
      var state = status.pairing && status.pairing.state;
      if (state === "approved") return t("statusApproved");
      if (state === "expired") return t("statusExpired");
      if (state === "waiting") return t("statusWaiting");
      return t("statusRunning").replace("{port}", String(status.port || ""));
    }

    function Section(props) {
      var t = props.t;
      var [status, setStatus] = react.useState(null);
      var [pairUrl, setPairUrl] = react.useState(null);
      var [busy, setBusy] = react.useState(false);
      var [error, setError] = react.useState(null);
      var [qrReady, setQrReady] = react.useState(false);
      var aliveRef = react.useRef(true);

      // 2s 轮询状态（sidecar 无推送，低频轮询即可）。
      react.useEffect(function () {
        var timer = null;
        var poll = function () {
          var b = bridge();
          if (!b) return;
          b.status().then(function (r) {
            if (!aliveRef.current) return;
            setStatus(r && r.ok ? r : r);
            setError(null);
          }).catch(function (e) {
            if (aliveRef.current) setError(String((e && e.message) || e));
          });
        };
        poll();
        timer = setInterval(poll, 2000);
        return function () { aliveRef.current = false; if (timer) clearInterval(timer); };
      }, []);

      // qrcode-generator 脚本（插件静态路由）
      react.useEffect(function () {
        if (typeof window === "undefined") return;
        if (typeof window.qrcode !== "undefined" || qrReady) { setQrReady(true); return; }
        var s = document.createElement("script");
        s.src = "/plugins/dsh-phone/qrcode.js";
        s.async = true;
        s.onload = function () { if (aliveRef.current) setQrReady(true); };
        document.head.appendChild(s);
      }, []);

      var b = bridge();

      function callStart() {
        if (!b) return;
        setBusy(true); setError(null);
        b.start().then(function (r) {
          setBusy(false);
          if (r && r.ok && r.url) setPairUrl(r.url);
        }).catch(function (e) {
          setBusy(false); setError(String((e && e.message) || e));
        });
      }
      function callStop() {
        if (!b) return;
        setBusy(true); setError(null);
        b.stop().then(function () { setBusy(false); setPairUrl(null); }).catch(function (e) {
          setBusy(false); setError(String((e && e.message) || e));
        });
      }
      function callDecide(approved) {
        if (!b) return;
        setBusy(true); setError(null);
        b.decide(approved).then(function () { setBusy(false); }).catch(function (e) {
          setBusy(false); setError(String((e && e.message) || e));
        });
      }
      function callDisconnect() {
        if (!b) return;
        setBusy(true); setError(null);
        b.disconnect().then(function () { setBusy(false); }).catch(function (e) {
          setBusy(false); setError(String((e && e.message) || e));
        });
      }

      function renderQr() {
        if (!pairUrl || !qrReady || typeof window.qrcode === "undefined") return null;
        try {
          var qr = window.qrcode(0, "M");
          qr.addData(pairUrl, "Byte");
          qr.make();
          var moduleCount = qr.getModuleCount();
          var cell = 6;
          var size = (moduleCount + 8) * cell;
          var canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size, size);
          ctx.fillStyle = "#111418";
          for (var r = 0; r < moduleCount; r += 1) {
            for (var c = 0; c < moduleCount; c += 1) {
              if (qr.isDark(r, c)) {
                ctx.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell);
              }
            }
          }
          return h("div", { className: "__ph_qr" }, h("canvas", { width: size, height: size }));
        } catch (e) {
          return h("span", { className: "__ph_hint" }, String((e && e.message) || e));
        }
      }

      if (!b) {
        return h("div", { className: "__ph_root" },
          h("p", { className: "__ph_hint" }, t("intro")),
          h("p", { className: "__ph_status" }, t("unavailable"))
        );
      }

      var state = status ? status.pairing && status.pairing.state : null;
      var running = status && status.running === true;

      return h("div", { className: "__ph_root" },
        h("p", { className: "__ph_hint", style: { margin: "0 0 4px" } }, t("intro")),
        h("div", { className: "__ph_row" },
          h("span", { className: "__ph_status" }, statusText(t, status)),
          h("span", { className: "__ph_badge" }, t("mobileDev"))
        ),
        h("div", { className: "__ph_row" },
          h("button", { type: "button", className: "__ph_btn __ph_btnPrimary", disabled: busy, onClick: callStart }, t(running ? "restart" : "start")),
          running ? h("button", { type: "button", className: "__ph_btn", disabled: busy, onClick: callStop }, t("stop")) : null,
          state === "waiting"
            ? h("button", { type: "button", className: "__ph_btn", disabled: busy, onClick: function () { callDecide(true); } }, t("approve"))
            : null,
          state === "waiting"
            ? h("button", { type: "button", className: "__ph_btn", disabled: busy, onClick: function () { callDecide(false); } }, t("reject"))
            : null,
          state === "approved"
            ? h("button", { type: "button", className: "__ph_btn", disabled: busy, onClick: callDisconnect }, t("disconnect"))
            : null
        ),
        pairUrl
          ? h("div", { className: "__ph_root", style: { marginTop: "4px" } },
              renderQr(),
              h("div", { className: "__ph_hint" }, t("qrHint")),
              h("div", { className: "__ph_url" }, t("urlLabel") + " " + pairUrl.split("?")[0])
            )
          : null,
        error ? h("p", { className: "__ph_status", style: { color: "var(--dsw-alias-state-error-primary)" } }, error) : null,
        h("p", { className: "__ph_hint" }, t("mobileDevHint"))
      );
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-phone: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-phone",
          order: 9,
          label: function () { return t("nav"); },
          locale: NS,
        }, function (props) {
          return h(Section, Object.assign({}, props, { t: t }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});