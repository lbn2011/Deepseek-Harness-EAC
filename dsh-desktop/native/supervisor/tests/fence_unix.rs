#![cfg(target_os = "linux")]

use std::process::Command;

#[test]
fn unix_fence_arms_parent_death_and_creates_own_process_group() {
    let output = Command::new("sh")
        .args([
            "-c",
            "python3 - <<'PY'\nimport ctypes, os\nlibc = ctypes.CDLL(None, use_errno=True)\nparent = os.getppid()\nos.setpgid(0, 0)\nassert libc.prctl(1, 15, 0, 0, 0) == 0\nassert os.getppid() == parent\nprint(f'{os.getpid()} {os.getpgrp()}')\nPY",
        ])
        .output()
        .expect("执行 Linux 围栏探针");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ids: Vec<u32> = String::from_utf8(output.stdout)
        .expect("探针输出 UTF-8")
        .split_whitespace()
        .map(|value| value.parse().expect("解析 pid"))
        .collect();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1]);
}
