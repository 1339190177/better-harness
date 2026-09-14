fn main() -> std::process::ExitCode {
    #[cfg(target_os = "macos")]
    {
        harness_arch_service::xpc::bridge()
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("NSXPC requires macOS");
        std::process::ExitCode::FAILURE
    }
}