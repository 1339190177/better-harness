pub(crate) use super::unsupported::{Backend, Surface};
pub(crate) const UNSUPPORTED_REASON: &str =
    "UNSUPPORTED: Linux 尚未实现 DMA-BUF 导出；LOD 可独立测试";
