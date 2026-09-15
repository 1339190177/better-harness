fn main() {
    println!("cargo:rerun-if-changed=src/arch-protocol.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/arch-protocol.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("harness_arch_protocol");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
