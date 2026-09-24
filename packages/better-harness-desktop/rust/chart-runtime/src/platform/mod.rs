#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::{Backend, Surface};

#[cfg(not(target_os = "macos"))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub(crate) use windows::*;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux::*;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) use unsupported::{Backend, Surface};
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const UNSUPPORTED_REASON: &str = "UNSUPPORTED: 原生图表仅实现 macOS Metal/IOSurface";

pub(crate) struct RenderTimings {
    pub encode_ms: f64,
    pub gpu_wait_ms: f64,
}
