use crate::{
    ChartResult,
    dataset::{Dataset, Hit},
    platform::{Backend, Surface},
    pool::SurfacePool,
    validation::{self, Colors, MAX_POINTS, Viewport},
};
use std::{marker::PhantomData, rc::Rc, time::Instant};

fn gpu_call<T>(operation: impl FnOnce() -> ChartResult<T>) -> ChartResult<T> {
    // 依赖库的 panic 不能越过 N-API 边界；渲染调用失败后图表会进入故障状态。
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)).unwrap_or_else(|payload| {
        let reason = payload.downcast_ref::<String>().map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied()).unwrap_or("未知 GPU panic");
        Err(format!("GPU_PANIC: {reason}"))
    })
}

#[derive(Debug)]
pub struct Generation {
    pub raw_points: u32,
    pub from: f64,
    pub to: f64,
    pub generation_ms: f64,
}

#[cfg_attr(feature = "addon", napi_derive::napi(object))]
#[derive(Debug)]
pub struct LoadedSeries {
    pub raw_points: u32,
    pub from: f64,
    pub to: f64,
    pub load_ms: f64,
}

#[cfg_attr(feature = "addon", napi_derive::napi(object))]
#[derive(Debug)]
pub struct Stats {
    pub backend: String,
    pub allocated_surfaces: u32,
    pub in_flight: u32,
    pub rendered_frames: u32,
    pub released_frames: u32,
}

#[derive(Debug)]
pub struct Frame {
    pub frame_id: u32,
    pub width: u32,
    pub height: u32,
    pub handle: Vec<u8>,
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

pub struct Chart {
    // 租用池先析构；其 Drop 在误用时保留租用资源，不依赖 JS 对象的寿命。
    pool: SurfacePool<Surface>,
    backend: Option<Backend>,
    backend_name: String,
    dataset: Option<Dataset>,
    viewport: Option<Viewport>,
    width: u32,
    height: u32,
    colors: Colors,
    fault: Option<String>,
    // GPU 状态严格属于创建它的 worker；即使平台对象未来变成 Send，也禁止搬线程。
    _thread_bound: PhantomData<Rc<()>>,
}

impl Chart {
    pub fn new(width: f64, height: f64) -> ChartResult<Self> {
        let (width, height) = validation::dimensions(width, height)?;
        let backend = gpu_call(Backend::new)?;
        let backend_name = backend.name().to_owned();
        Ok(Self {
            pool: SurfacePool::default(), backend: Some(backend), backend_name,
            dataset: None, viewport: None, width, height,
            colors: Colors::legacy_theme(false), fault: None, _thread_bound: PhantomData,
        })
    }

    fn ensure_live(&self) -> ChartResult<()> {
        if self.backend.is_none() { return Err("DISPOSED: 图表已释放".into()); }
        if let Some(fault) = &self.fault {
            return Err(format!("GPU_FAULT: {fault}；请释放并重建图表"));
        }
        Ok(())
    }

    fn data(&self) -> ChartResult<&Dataset> {
        self.dataset.as_ref().ok_or_else(|| "EMPTY_DATA: 请先调用 loadSeries".into())
    }

    pub fn load_series(&mut self, timestamps: Vec<f64>, values: Vec<f64>) -> ChartResult<LoadedSeries> {
        self.ensure_live()?;
        let start = Instant::now();
        let dataset = Dataset::from_api_series(timestamps, values)?;
        let (from, to) = dataset.domain();
        let raw_points = dataset.len() as u32;
        self.viewport = Some(dataset.viewport(from, to)?);
        self.dataset = Some(dataset);
        Ok(LoadedSeries { raw_points, from, to, load_ms: start.elapsed().as_secs_f64() * 1000.0 })
    }

    // 仅 Rust 测试/基准入口；正式 JS 类不暴露 generate。
    pub fn generate(&mut self, points: f64) -> ChartResult<Generation> {
        self.ensure_live()?;
        let count = validation::integer(points, 1, MAX_POINTS as u32, "points")?;
        let start = Instant::now();
        let dataset = Dataset::generate(count as usize)?;
        let (from, to) = dataset.domain();
        self.viewport = Some(dataset.viewport(from, to)?);
        self.dataset = Some(dataset);
        Ok(Generation { raw_points: count, from, to, generation_ms: start.elapsed().as_secs_f64() * 1000.0 })
    }

    pub fn set_viewport(&mut self, from: f64, to: f64) -> ChartResult<()> {
        self.ensure_live()?;
        self.viewport = Some(self.data()?.viewport(from, to)?);
        Ok(())
    }

    pub fn resize(&mut self, width: f64, height: f64) -> ChartResult<()> {
        self.ensure_live()?;
        let (width, height) = validation::dimensions(width, height)?;
        // 这里只更新目标尺寸；下次 render 才在空闲槽延迟替换，不触碰任何租用输出。
        self.width = width;
        self.height = height;
        Ok(())
    }

    pub fn set_colors(&mut self, background: &[f64], line: &[f64]) -> ChartResult<()> {
        self.ensure_live()?;
        self.colors = Colors::new(background, line)?;
        Ok(())
    }

    pub fn set_theme(&mut self, dark: bool) -> ChartResult<()> {
        self.ensure_live()?;
        self.colors = Colors::legacy_theme(dark);
        Ok(())
    }

    pub fn hit_test(&self, timestamp: f64) -> ChartResult<Hit> {
        self.ensure_live()?;
        self.data()?.hit_test(timestamp)
    }

    pub fn render(&mut self) -> ChartResult<Frame> {
        self.ensure_live()?;
        self.data()?;
        if self.pool.in_flight() == 3 {
            return Err("SURFACE_BUSY: 等待 allReferencesReleased 后再渲染".into());
        }
        let viewport = self.viewport.ok_or("EMPTY_DATA: 缺少 viewport")?;
        let dataset = self.dataset.as_ref().expect("数据已校验");
        let start = Instant::now();
        let lod = dataset.lod(viewport, self.width)?;
        let lod_ms = start.elapsed().as_secs_f64() * 1000.0;
        let backend = self.backend.as_mut().expect("图表未释放");
        let slot = match self.pool.prepare(self.width, self.height, || {
            gpu_call(|| backend.create_surface(self.width, self.height))
        }) {
            Ok(slot) => slot,
            Err(error) => {
                self.fault = Some(error.clone());
                return Err(error);
            }
        };
        // 调用 GPU 前设置隔离状态，覆盖 submit/poll 内部 panic 和不明完成状态。
        self.pool.begin_gpu(slot);
        let timings = match gpu_call(|| backend.render(self.pool.get(slot), dataset, &lod, viewport, self.colors)) {
            Ok(timings) => timings,
            Err(error) => {
                self.fault = Some(error.clone());
                return Err(error);
            }
        };
        self.pool.complete_gpu(slot);
        let handle = self.pool.get(slot).handle_bytes();
        let frame_id = self.pool.lease(slot);
        Ok(Frame {
            frame_id, width: self.width, height: self.height, handle,
            raw_points: dataset.len() as u32, visible_points: lod.visible_points,
            rendered_vertices: lod.indices.len() as u32, lod_ms,
            encode_ms: timings.encode_ms, gpu_wait_ms: timings.gpu_wait_ms,
            from: viewport.from, to: viewport.to, y_min: lod.y_min, y_max: lod.y_max,
        })
    }

    pub fn release_frame(&mut self, frame_id: f64) -> ChartResult<bool> {
        let frame_id = validation::integer(frame_id, 0, u32::MAX, "frameId")?;
        // 即使已 dispose 或设备失效，也允许重复回执（返回 false）。
        Ok(self.pool.release(frame_id))
    }

    pub fn stats(&self) -> Stats {
        Stats { backend: self.backend_name.clone(), allocated_surfaces: self.pool.allocated(),
            in_flight: self.pool.in_flight(), rendered_frames: self.pool.rendered(), released_frames: self.pool.released() }
    }

    pub fn dispose(&mut self) -> ChartResult<()> {
        let uncertain = self.pool.has_uncertain();
        self.pool.clear()?;
        self.dataset = None;
        self.viewport = None;
        if uncertain {
            // 不只保留输出，还保留仍可能被 GPU 使用的上下文/上传资源；不再次等待故障设备。
            if let Some(backend) = self.backend.take() { std::mem::forget(backend); }
        } else { self.backend = None; }
        Ok(())
    }
}

impl Drop for Chart {
    fn drop(&mut self) {
        if self.pool.has_uncertain() || self.pool.in_flight() != 0 {
            if let Some(backend) = self.backend.take() { std::mem::forget(backend); }
        }
    }
}
