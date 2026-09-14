fn main() {
    #[cfg(target_os = "macos")]
    harness_arch_service::xpc::listen();
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("NSXPC requires macOS");
        std::process::exit(2);
    }
}