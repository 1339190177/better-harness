use crate::chart::{Chart, Frame, LoadedSeries, Stats};
use napi::{Error, Result, bindgen_prelude::Buffer};
use napi_derive::napi;

#[napi(object)]
pub struct HitResult {
    pub index: u32,
    pub timestamp: f64,
    pub value: f64,
}

#[napi(object)]
pub struct RenderedFrame {
    pub frame_id: u32,
    pub width: u32,
    pub height: u32,
    pub handle: Buffer,
    pub raw_points: u32,
    pub visible_points: u32,
    pub rendered_vertices: u32,
    pub lod_ms: f64,
    pub encode_ms: f64,
    pub gpu_wait_ms: f64,
    pub from: f64,
    pub to: f64,
    pub y_min: f64,
    pub y_max: f64,
}

impl From<Frame> for RenderedFrame {
    fn from(frame: Frame) -> Self {
        Self {
            frame_id: frame.frame_id, width: frame.width, height: frame.height,
            handle: Buffer::from(frame.handle), raw_points: frame.raw_points,
            visible_points: frame.visible_points, rendered_vertices: frame.rendered_vertices,
            lod_ms: frame.lod_ms, encode_ms: frame.encode_ms, gpu_wait_ms: frame.gpu_wait_ms,
            from: frame.from, to: frame.to, y_min: frame.y_min, y_max: frame.y_max,
        }
    }
}

// 同步且线程绑定：专用 Node worker 必须在自身线程构造、调用和销毁；没有异步线程池任务。
#[napi]
pub struct NativeChart {
    inner: Chart,
}

#[napi]
impl NativeChart {
    // 所有数字参数先接收 f64 再显式验证，避免 N-API 对 u32 截断或回绕。
    #[napi(constructor, strict)]
    pub fn new(width: f64, height: f64) -> Result<Self> {
        Ok(Self { inner: Chart::new(width, height).map_err(Error::from_reason)? })
    }

    #[napi(js_name = "loadSeries", strict)]
    pub fn load_series(&mut self, timestamps: Vec<f64>, values: Vec<f64>) -> Result<LoadedSeries> {
        self.inner.load_series(timestamps, values).map_err(Error::from_reason)
    }

    #[napi(js_name = "setViewport", strict)]
    pub fn set_viewport(&mut self, from: f64, to: f64) -> Result<()> {
        self.inner.set_viewport(from, to).map_err(Error::from_reason)
    }

    #[napi(strict)]
    pub fn resize(&mut self, width: f64, height: f64) -> Result<()> {
        self.inner.resize(width, height).map_err(Error::from_reason)
    }

    #[napi(js_name = "setColors", strict)]
    pub fn set_colors(&mut self, background: Vec<f64>, line: Vec<f64>) -> Result<()> {
        self.inner.set_colors(&background, &line).map_err(Error::from_reason)
    }

    #[napi(js_name = "setTheme", strict)]
    pub fn set_theme(&mut self, dark: bool) -> Result<()> {
        self.inner.set_theme(dark).map_err(Error::from_reason)
    }

    #[napi(js_name = "hitTest", strict)]
    pub fn hit_test(&self, timestamp: f64) -> Result<HitResult> {
        let hit = self.inner.hit_test(timestamp).map_err(Error::from_reason)?;
        Ok(HitResult { index: hit.index, timestamp: hit.timestamp, value: hit.value })
    }

    #[napi]
    pub fn render(&mut self) -> Result<RenderedFrame> {
        self.inner.render().map(RenderedFrame::from).map_err(Error::from_reason)
    }

    #[napi(js_name = "releaseFrame", strict)]
    pub fn release_frame(&mut self, frame_id: f64) -> Result<bool> {
        self.inner.release_frame(frame_id).map_err(Error::from_reason)
    }

    #[napi]
    pub fn stats(&self) -> Stats { self.inner.stats() }

    #[napi]
    pub fn dispose(&mut self) -> Result<()> {
        self.inner.dispose().map_err(Error::from_reason)
    }
}
