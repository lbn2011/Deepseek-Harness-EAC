//! 主窗导航围栏（Task 8.2 / Task 12⑥）——纯函数抽取，便于表驱动单测。
//!
//! 语义（自 main.rs 原 `is_allowed_main_navigation` 抽出，行为不变）：
//! 仅放行 http/https，且满足其一——
//!   1. 与当前 dsh web 的 origin 同源；
//!   2. 回环主机（127.0.0.1 / localhost / ::1）且端口 == WS_PORT。

/// 判断主窗是否允许导航到 `target`。
///
/// - `current_url`：当前 dsh web 的完整 URL（同源放行），可为 `None`（未就绪时仅回环白名单生效）。
/// - `ws_port`：回环 WS/HTTP 端口白名单。
pub fn is_allowed_navigation(target: &tauri::Url, current_url: Option<&str>, ws_port: u16) -> bool {
    if target.scheme() != "http" && target.scheme() != "https" {
        return false;
    }
    if let Some(current) = current_url {
        if let Ok(base) = tauri::Url::parse(current) {
            if target.origin() == base.origin() {
                return true;
            }
        }
    }
    // 回环主机判定：用类型化的 Host 匹配（IPv4/IPv6 回环地址），而非字符串比较——
    // url crate 的 host_str() 对 IPv6 返回带方括号的 "[::1]"，裸字符串 "::1" 永远不匹配。
    let loopback = matches!(target.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(target.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback())
        || matches!(target.host_str(), Some("localhost"));
    loopback && target.port_or_known_default() == Some(ws_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 19873;

    fn allowed(url: &str, current: Option<&str>) -> bool {
        is_allowed_navigation(&tauri::Url::parse(url).unwrap(), current, PORT)
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(!allowed("file:///etc/passwd", None));
        assert!(!allowed("javascript:alert(1)", None));
        assert!(!allowed("data:text/html,hi", None));
    }

    #[test]
    fn allows_same_origin_as_current_web() {
        let cur = "http://127.0.0.1:19873/";
        assert!(allowed("http://127.0.0.1:19873/session/abc", Some(cur)));
        assert!(allowed("http://127.0.0.1:19873/", Some(cur)));
    }

    #[test]
    fn allows_loopback_host_on_ws_port() {
        assert!(allowed("http://127.0.0.1:19873/", None));
        assert!(allowed("http://localhost:19873/", None));
        assert!(allowed("http://[::1]:19873/", None));
    }

    #[test]
    fn rejects_loopback_on_wrong_port() {
        assert!(!allowed("http://localhost:9999/", None));
        assert!(!allowed("http://127.0.0.1/", None)); // 默认端口 80
    }

    #[test]
    fn rejects_external_hosts() {
        assert!(!allowed("https://evil.example.com/", None));
        assert!(!allowed("http://198.51.100.7:19873/", None)); // 非回环
    }

    #[test]
    fn rejects_external_even_if_ports_match() {
        assert!(!allowed("https://evil.example.com:19873/", None));
    }
}
