pub(crate) use super::unsupported::{Backend, Surface};
pub(crate) const UNSUPPORTED_REASON: &str =
    "UNSUPPORTED: Windows 尚未实现 D3D 共享句柄导出；LOD 可独立测试";
