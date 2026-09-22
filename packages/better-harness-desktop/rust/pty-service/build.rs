fn main() {
    println!("cargo:rerun-if-changed=src/pty-core.c");
    println!("cargo:rerun-if-changed=src/pty-protocol.m");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    // POSIX only. Windows ConPTY would be a separate backend and a separate
    // source file; the POC does not build one.
    if target_os == "windows" {
        return;
    }
    cc::Build::new()
        .file("src/pty-core.c")
        .compile("harness_pty_core");
    // login_tty / openpty live in libutil on Linux; macOS folds them into libc.
    if target_os == "linux" {
        println!("cargo:rustc-link-lib=util");
    }
    // The NSXPC service and bridge need the Objective-C protocol metadata; only
    // macOS builds the xpc module that references these symbols.
    if target_os == "macos" {
        cc::Build::new()
            .file("src/pty-protocol.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("harness_pty_protocol");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
