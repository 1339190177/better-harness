use std::time::{Duration, Instant};

use ecolor::{Color32, Rgba};
use objc2::rc::autoreleasepool;
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained};
use objc2_io_surface::{
    IOSurfaceRef, kIOSurfaceBytesPerElement, kIOSurfaceBytesPerRow, kIOSurfaceHeight,
    kIOSurfacePixelFormat, kIOSurfaceWidth,
};
use objc2_metal::{
    MTLDevice as _, MTLPixelFormat, MTLStorageMode, MTLTextureDescriptor, MTLTextureType,
    MTLTextureUsage,
};
use re_renderer::device_caps::DeviceCaps;
use re_renderer::view_builder::{OrthographicCameraMode, Projection, TargetConfiguration};
use re_renderer::{
    LineDrawableBuilder, PointCloudBuilder, RenderConfig, RenderContext, Size, ViewBuilder,
    ViewBuilderId,
};

use super::RenderTimings;
use crate::{
    ChartResult,
    dataset::{Dataset, Lod},
    validation::{Colors, Viewport},
};

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
const GPU_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct Surface {
    // 字段按声明顺序析构。视图先于纹理释放，IOSurface 的自有引用最后释放。
    view: wgpu::TextureView,
    _texture: wgpu::Texture,
    surface: CFRetained<IOSurfaceRef>,
    width: u32,
    height: u32,
}

impl Surface {
    fn new(device: &wgpu::Device, width: u32, height: u32) -> ChartResult<Self> {
        autoreleasepool(|_| {
            // 系统常量有效；属性字典只含正尺寸、BGRA 四字符码及对齐后的行跨度。
            let keys = unsafe {
                [kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceBytesPerElement, kIOSurfaceBytesPerRow]
            };
            let row_bytes = IOSurfaceRef::align_property(keys[4], width as usize * 4);
            let values = [
                CFNumber::new_i64(width as i64),
                CFNumber::new_i64(height as i64),
                CFNumber::new_i64(u32::from_be_bytes(*b"BGRA") as i64),
                CFNumber::new_i64(4),
                CFNumber::new_i64(row_bytes as i64),
            ];
            let properties = CFDictionary::from_slices(&keys, &values.iter().map(|v| &**v).collect::<Vec<_>>());
            // 返回的 +1 CF 引用由 Surface 持有，不使用 IOSurfaceID 或 Mach port 替代指针。
            let surface = unsafe { IOSurfaceRef::new(properties.as_opaque()) }
                .ok_or("IOSURFACE_ERROR: IOSurfaceCreate 分配失败")?;
            let descriptor = wgpu::TextureDescriptor {
                label: Some("native-chart-iosurface"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            };
            let hal_texture = {
                // 只借用同一个 wgpu 设备的 Metal 句柄，不在 guard 生命周期之外保存借用。
                let hal_device = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }
                    .ok_or("UNSUPPORTED: 必须使用 Metal 设备")?;
                let raw_device = hal_device.raw_device();
                let metal_desc = MTLTextureDescriptor::new();
                // 当前作用域独占新描述符，宽高已经过上限和非零验证。
                unsafe {
                    metal_desc.setWidth(width as usize);
                    metal_desc.setHeight(height as usize);
                }
                metal_desc.setTextureType(MTLTextureType::Type2D);
                metal_desc.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
                metal_desc.setUsage(MTLTextureUsage::RenderTarget);
                metal_desc.setStorageMode(if raw_device.hasUnifiedMemory() { MTLStorageMode::Shared } else { MTLStorageMode::Managed });
                let raw_texture = raw_device.newTextureWithDescriptor_iosurface_plane(&metal_desc, &surface, 0)
                    .ok_or("IOSURFACE_ERROR: Metal 无法创建 IOSurface-backed texture")?;
                // raw_texture 来自当前设备，尺寸/格式/层数与描述一致，所有权交给 HAL。
                // MTLTexture 自身 retain IOSurface；无外部借用资源，故 drop_callback 为 None。
                unsafe {
                    wgpu::hal::metal::Device::texture_from_raw(
                        raw_texture, FORMAT, MTLTextureType::Type2D, 1, 1,
                        wgpu::hal::CopyExtent { width, height, depth: 1 }, None,
                    )
                }
            };
            // Metal 无显式图像布局；初始用途与首个清屏写入一致，不能误标 COPY_SRC。
            // 首次 composite 使用 Clear，整张纹理写完并等待 GPU 后才允许导出。
            let texture = unsafe {
                device.create_texture_from_hal::<wgpu::hal::api::Metal>(hal_texture, &descriptor, wgpu::TextureUses::COLOR_TARGET)
            };
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            Ok(Self { view, _texture: texture, surface, width, height })
        })
    }

    pub fn handle_bytes(&self) -> Vec<u8> {
        // 原生端序、原生指针宽度，仅供同进程 Electron main 导入；绝不能通过普通 IPC 发送。
        (CFRetained::as_ptr(&self.surface).as_ptr() as usize).to_ne_bytes().to_vec()
    }
}

struct ErrorScopes(Vec<wgpu::ErrorScopeGuard>);
impl ErrorScopes {
    fn new(device: &wgpu::Device) -> Self {
        Self([wgpu::ErrorFilter::OutOfMemory, wgpu::ErrorFilter::Internal, wgpu::ErrorFilter::Validation]
            .into_iter().map(|filter| device.push_error_scope(filter)).collect())
    }
    fn finish(mut self) -> ChartResult<()> {
        let mut errors = Vec::new();
        while let Some(scope) = self.0.pop() {
            if let Some(error) = pollster::block_on(scope.pop()) { errors.push(error.to_string()); }
        }
        if errors.is_empty() { Ok(()) } else { Err(format!("GPU_ERROR: {}", errors.join("; "))) }
    }
}
impl Drop for ErrorScopes {
    fn drop(&mut self) {
        // 提前返回时也严格按栈的逆序弹出，避免破坏 wgpu 的线程局部错误作用域。
        while let Some(scope) = self.0.pop() { drop(scope); }
    }
}

pub(crate) struct Backend {
    ctx: RenderContext,
    name: String,
}

impl Backend {
    pub fn new() -> ChartResult<Self> {
        autoreleasepool(|_| {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::METAL,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false, compatible_surface: None, ..Default::default()
            })).map_err(|error| format!("METAL_UNAVAILABLE: {error}"))?;
            let info = adapter.get_info();
            if info.backend != wgpu::Backend::Metal || info.device_type == wgpu::DeviceType::Cpu {
                return Err("UNSUPPORTED: 禁止使用非 Metal 或 CPU fallback".into());
            }
            let caps = DeviceCaps::from_adapter(&adapter).map_err(|error| format!("GPU_CAPS: {error}"))?;
            let (device, queue) = pollster::block_on(adapter.request_device(&caps.device_descriptor()))
                .map_err(|error| format!("GPU_DEVICE: {error}"))?;
            let scopes = ErrorScopes::new(&device);
            let ctx = RenderContext::new(&adapter, device, queue, FORMAT, RenderConfig::best_for_device_caps)
                .map_err(|error| format!("GPU_CONTEXT: {error}"))?;
            scopes.finish()?;
            Ok(Self { ctx, name: format!("Metal / IOSurface / {}", info.name) })
        })
    }

    pub fn name(&self) -> &str { &self.name }

    pub fn create_surface(&self, width: u32, height: u32) -> ChartResult<Surface> {
        let scopes = ErrorScopes::new(&self.ctx.device);
        let result = Surface::new(&self.ctx.device, width, height);
        scopes.finish()?;
        result
    }

    pub fn render(&mut self, surface: &Surface, data: &Dataset, lod: &Lod, viewport: Viewport, colors: Colors) -> ChartResult<RenderTimings> {
        autoreleasepool(|_| {
            let scopes = ErrorScopes::new(&self.ctx.device);
            let encode_start = Instant::now();
            let ctx = &mut self.ctx;
            ctx.begin_frame();
            // 颜色由 host 提供 Studio 语义 token；Rgba 转换负责线性空间清屏。
            let [r, g, b] = colors.background;
            let background = Color32::from_rgb(r, g, b);
            let [r, g, b] = colors.line;
            let line = Color32::from_rgb(r, g, b);
            let mut view = ViewBuilder::new(ctx, TargetConfiguration {
                name: "native-chart".into(),
                resolution_in_pixel: [surface.width, surface.height],
                projection_from_view: Projection::Orthographic {
                    camera_mode: OrthographicCameraMode::TopLeftCornerAndExtendZ,
                    vertical_world_size: surface.height as f32, far_plane_distance: 100.0,
                },
                ..Default::default()
            }, ViewBuilderId::new(1)).map_err(|error| format!("GPU_VIEW: {error}"))?;
            let positions: Vec<glam::Vec2> = lod.indices.iter().map(|&index| {
                glam::Vec2::from_array(data.pixel_position(index, lod, viewport, surface.width, surface.height))
            }).collect();
            // 完全重合的样本不能画零长度折线；仅改变绘制图元，不改 LOD 索引或回执计数。
            if positions.first().is_some_and(|first| positions.iter().all(|position| position == first)) {
                let mut points = PointCloudBuilder::new(ctx);
                points.batch("single-sample").add_points_2d(
                    &[positions[0].extend(0.0)], &[Size::new_ui_points(2.5)], &[line], &[Default::default()],
                );
                view.queue_draw(ctx, points.into_draw_data().map_err(|e| format!("GPU_POINT: {e}"))?);
            } else if !positions.is_empty() {
                let mut lines = LineDrawableBuilder::new(ctx);
                lines.batch("time-series").add_strip_2d(positions.into_iter()).radius(Size::new_ui_points(0.9)).color(line);
                view.queue_draw(ctx, lines.into_draw_data().map_err(|e| format!("GPU_LINE: {e}"))?);
            }
            let draw = view.draw(ctx, Rgba::from(background)).map_err(|e| format!("GPU_DRAW: {e}"))?;
            let mut encoder = ctx.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("native-chart-composite") });
            {
                // 直接将 IOSurface-backed texture 作为 composite target；不做回读或纹理复制。
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("native-chart-iosurface-composite"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &surface.view, depth_slice: None, resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                    })],
                    ..Default::default()
                });
                view.composite(ctx, &mut pass);
            }
            let composite = encoder.finish();
            ctx.before_submit();
            let submission = ctx.queue.submit([draw, composite]);
            let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.0;
            let wait_start = Instant::now();
            wait_for_submission(&ctx.device, submission)?;
            let gpu_wait_ms = wait_start.elapsed().as_secs_f64() * 1000.0;
            scopes.finish()?;
            // 只有成功等待该提交及其之前全部上传完成后，调用方才可以创建输出租约。
            Ok(RenderTimings { encode_ms, gpu_wait_ms })
        })
    }
}

#[cfg(test)]
thread_local! {
    // 测试线程局部注入，不影响并行测试；生产 addon 完全不包含此入口。
    static WAIT_FAILURE: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

fn wait_for_submission(device: &wgpu::Device, submission: wgpu::SubmissionIndex) -> ChartResult<()> {
    bounded_wait(|timeout| device.poll(wgpu::PollType::Wait { submission_index: Some(submission), timeout: Some(timeout) }))?;
    #[cfg(test)]
    match WAIT_FAILURE.with(|failure| failure.replace(0)) {
        1 => return Err("GPU_WAIT_TIMEOUT: 测试注入未确认完成".into()),
        2 => panic!("测试注入 GPU 等待 panic"),
        _ => {},
    }
    Ok(())
}

// 测试通过注入 poll 结果验证超时参数及状态，不故意挂死真实 GPU。
fn bounded_wait(poll: impl FnOnce(Duration) -> Result<wgpu::PollStatus, wgpu::PollError>) -> ChartResult<()> {
    match poll(GPU_WAIT_TIMEOUT) {
        Ok(status) if status.wait_finished() => Ok(()),
        Ok(_) => Err("GPU_WAIT: 未确认提交完成".into()),
        Err(wgpu::PollError::Timeout) => Err("GPU_WAIT_TIMEOUT: GPU 提交未在 5 秒内完成".into()),
        Err(error) => Err(format!("GPU_WAIT: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::Chart;

    static_assertions::assert_not_impl_any!(Chart: Send, Sync);
    #[cfg(feature = "addon")]
    static_assertions::assert_not_impl_any!(crate::NativeChart: Send, Sync);

    #[test]
    fn gpu_wait_is_bounded_and_requires_confirmed_completion() {
        for status in [wgpu::PollStatus::QueueEmpty, wgpu::PollStatus::WaitSucceeded] {
            bounded_wait(|timeout| {
                assert_eq!(timeout, Duration::from_secs(5));
                Ok(status)
            }).unwrap();
        }
        assert!(bounded_wait(|_| Ok(wgpu::PollStatus::Poll)).is_err());
        assert!(bounded_wait(|_| Err(wgpu::PollError::Timeout)).unwrap_err().starts_with("GPU_WAIT_TIMEOUT:"));
        assert!(bounded_wait(|_| Err(wgpu::PollError::WrongSubmissionIndex(3, 2))).is_err());
    }

    #[test]
    fn gpu_wait_fault_and_panic_block_reuse_but_allow_existing_lease_acknowledgements() {
        for (injection, code) in [(1, "GPU_WAIT_TIMEOUT:"), (2, "GPU_PANIC:")] {
            let mut chart = Chart::new(32.0, 32.0).unwrap();
            chart.load_series(vec![10.0, 20.0], vec![1.0, 2.0]).unwrap();
            let frame = chart.render().unwrap();
            WAIT_FAILURE.with(|failure| failure.set(injection));
            assert!(chart.render().unwrap_err().starts_with(code));
            assert_eq!(chart.stats().rendered_frames, 1);
            assert_eq!(chart.stats().in_flight, 1);
            assert_eq!(chart.stats().allocated_surfaces, 2);
            assert!(chart.render().unwrap_err().starts_with("GPU_FAULT:"));
            assert!(chart.resize(64.0, 64.0).unwrap_err().starts_with("GPU_FAULT:"));
            assert!(chart.load_series(vec![1.0], vec![2.0]).unwrap_err().starts_with("GPU_FAULT:"));
            assert!(chart.dispose().unwrap_err().starts_with("SURFACE_BUSY:"));
            assert_eq!(chart.stats().allocated_surfaces, 2);
            assert!(chart.release_frame(frame.frame_id as f64).unwrap());
            assert!(!chart.release_frame(frame.frame_id as f64).unwrap());
            chart.dispose().unwrap();
            chart.dispose().unwrap();
            assert_eq!(chart.stats().allocated_surfaces, 0);
            assert!(chart.render().unwrap_err().starts_with("DISPOSED:"));
        }
    }
}
