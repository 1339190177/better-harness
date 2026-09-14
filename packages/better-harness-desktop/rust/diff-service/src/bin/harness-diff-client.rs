//! stdio<->NSXPC bridge Studio spawns in place of `harness-diff-host` on macOS.
fn main() -> std::process::ExitCode {
    #[cfg(target_os = "macos")]
    {
        harness_diff_service::xpc::bridge()
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("NSXPC requires macOS");
        std::process::ExitCode::from(2)
    }
}
