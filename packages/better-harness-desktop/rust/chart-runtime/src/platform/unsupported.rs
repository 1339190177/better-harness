use super::RenderTimings;
use crate::{ChartResult, dataset::{Dataset, Lod}, validation::{Colors, Viewport}};

// 无实例类型：未支持的平台不能构造渲染器，也不会悄悄进入 CPU 位图路径。
pub(crate) enum Backend {}
pub(crate) enum Surface {}

impl Backend {
    pub fn new() -> ChartResult<Self> { Err(super::UNSUPPORTED_REASON.into()) }
    pub fn name(&self) -> &str { match *self {} }
    pub fn create_surface(&self, _width: u32, _height: u32) -> ChartResult<Surface> { match *self {} }
    pub fn render(&mut self, _surface: &Surface, _data: &Dataset, _lod: &Lod, _view: Viewport, _colors: Colors) -> ChartResult<RenderTimings> {
        match *self {}
    }
}

impl Surface {
    pub fn handle_bytes(&self) -> Vec<u8> { match *self {} }
}
