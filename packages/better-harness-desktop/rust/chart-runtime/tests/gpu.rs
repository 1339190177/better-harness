#[cfg(target_os = "macos")]
mod macos {
    use harness_chart_runtime::chart::{Chart, Frame};
    use objc2_io_surface::{IOSurfaceLockOptions, IOSurfaceRef};

    // 仅测试中读取成品像素以证明 GPU 绘制。生产路径既不映射像素也不返回位图。
    fn inspect(frame: &Frame) -> (usize, u64) {
        let address = usize::from_ne_bytes(frame.handle.as_slice().try_into().unwrap());
        assert_ne!(address, 0);
        // frame 的租约仍有效，调用方在本函数返回之前不会 release 或写入此 surface。
        let surface = unsafe { &*(address as *const IOSurfaceRef) };
        assert_eq!((surface.width(), surface.height()), (frame.width as usize, frame.height as usize));
        assert_eq!(surface.pixel_format(), u32::from_be_bytes(*b"BGRA"));
        let options = IOSurfaceLockOptions::ReadOnly;
        assert_eq!(unsafe { surface.lock(options, std::ptr::null_mut()) }, 0);
        let mut colored = 0;
        let mut fingerprint = 0_u64;
        let stride = surface.bytes_per_row();
        let bytes = unsafe {
            std::slice::from_raw_parts(surface.base_address().as_ptr().cast::<u8>(), stride * surface.height())
        };
        for y in 0..surface.height() {
            for pixel in bytes[y * stride..y * stride + surface.width() * 4].chunks_exact(4) {
                if pixel[0] > pixel[2].saturating_add(20) { colored += 1; }
                fingerprint = fingerprint.wrapping_mul(31).wrapping_add(u32::from_ne_bytes(pixel.try_into().unwrap()) as u64);
            }
        }
        assert_eq!(unsafe { surface.unlock(options, std::ptr::null_mut()) }, 0);
        (colored, fingerprint)
    }

    #[test]
    fn metal_renders_real_iosurface_and_preserves_leases_across_resize() {
        let mut chart = Chart::new(320.0, 180.0).unwrap();
        assert!(chart.stats().backend.contains("Metal"));
        assert_eq!(chart.stats().allocated_surfaces, 0);
        assert!(chart.render().unwrap_err().contains("EMPTY_DATA"));
        chart.generate(10_000_000.0).unwrap();
        let first = chart.render().unwrap();
        let (colored, fingerprint) = inspect(&first);
        assert!(colored > 320, "应有真实蓝色曲线，实际像素数 {colored}");
        assert_eq!(first.raw_points, 10_000_000);
        assert!(first.rendered_vertices <= 642);
        for timing in [first.lod_ms, first.encode_ms, first.gpu_wait_ms] { assert!(timing.is_finite() && timing >= 0.0); }
        eprintln!("GPU backend={}, encodeMs={:.3}, gpuWaitMs={:.3}, coloredPixels={colored}", chart.stats().backend, first.encode_ms, first.gpu_wait_ms);
        let second = chart.render().unwrap();
        let third = chart.render().unwrap();
        assert_ne!(first.handle, second.handle);
        assert_ne!(second.handle, third.handle);
        assert_eq!((chart.stats().allocated_surfaces, chart.stats().in_flight), (3, 3));
        assert!(chart.render().unwrap_err().contains("SURFACE_BUSY"));
        assert!(chart.dispose().unwrap_err().contains("SURFACE_BUSY"));
        chart.resize(640.0, 256.0).unwrap();
        assert!(chart.render().unwrap_err().contains("SURFACE_BUSY"));
        assert_eq!(inspect(&first).1, fingerprint);
        assert!(chart.release_frame(second.frame_id as f64).unwrap());
        assert!(!chart.release_frame(second.frame_id as f64).unwrap());
        chart.set_theme(true).unwrap();
        let fourth = chart.render().unwrap();
        assert_eq!((fourth.width, fourth.height), (640, 256));
        assert_eq!(chart.stats().allocated_surfaces, 3);
        assert!(inspect(&fourth).0 > 640);
        assert_eq!(inspect(&first).1, fingerprint);
        assert!(!chart.release_frame(second.frame_id as f64).unwrap());
        for frame in [first, third, fourth] { assert!(chart.release_frame(frame.frame_id as f64).unwrap()); }
        assert_eq!((chart.stats().rendered_frames, chart.stats().released_frames), (4, 4));
        chart.dispose().unwrap();
        chart.dispose().unwrap();
        assert_eq!((chart.stats().allocated_surfaces, chart.stats().in_flight), (0, 0));
        assert!(chart.render().unwrap_err().contains("DISPOSED"));
        assert!(chart.generate(10.0).unwrap_err().contains("DISPOSED"));
        assert!(!chart.release_frame(1.0).unwrap());
    }

    #[test]
    fn fractional_singleton_empty_and_invalid_viewports_render_honestly() {
        let mut chart = Chart::new(160.0, 90.0).unwrap();
        assert!(chart.set_viewport(0.0, 1.0).is_err());
        assert!(chart.hit_test(0.0).is_err());
        chart.generate(1000.0).unwrap();
        chart.set_viewport(10.1, 12.9).unwrap();
        assert!(chart.set_viewport(f64::NAN, 20.0).is_err());
        assert!(chart.resize(1.5, 90.0).is_err());
        let frame = chart.render().unwrap();
        assert_eq!((frame.width, frame.visible_points, frame.from, frame.to), (160, 2, 10.1, 12.9));
        chart.release_frame(frame.frame_id as f64).unwrap();
        chart.set_viewport(10.0, 10.0).unwrap();
        let frame = chart.render().unwrap();
        assert_eq!(frame.rendered_vertices, 1);
        assert!(inspect(&frame).0 > 0);
        chart.release_frame(frame.frame_id as f64).unwrap();
        chart.set_viewport(10.1, 10.9).unwrap();
        let frame = chart.render().unwrap();
        assert_eq!((frame.visible_points, frame.rendered_vertices), (0, 0));
        assert_eq!(inspect(&frame).0, 0);
        chart.release_frame(frame.frame_id as f64).unwrap();
        chart.dispose().unwrap();
    }

    #[test]
    fn repeated_frames_reuse_idle_surface_and_report_real_counts() {
        let mut chart = Chart::new(128.0, 72.0).unwrap();
        chart.generate(10000.0).unwrap();
        let first = chart.render().unwrap();
        let handle = first.handle.clone();
        chart.release_frame(first.frame_id as f64).unwrap();
        for i in 1..25 {
            chart.set_viewport(i as f64 * 100.0, i as f64 * 100.0 + 50.0).unwrap();
            let frame = chart.render().unwrap();
            assert_eq!(frame.handle, handle);
            assert_eq!(frame.visible_points, 51);
            assert_eq!(frame.frame_id, i + 1);
            chart.release_frame(frame.frame_id as f64).unwrap();
        }
        assert_eq!(chart.stats().allocated_surfaces, 1);
        assert_eq!((chart.stats().rendered_frames, chart.stats().released_frames), (25, 25));
        chart.dispose().unwrap();
    }

    #[test]
    fn explicit_epoch_data_matches_relative_pixels_at_each_dpr_and_failed_load_is_atomic() {
        let mut chart = Chart::new(160.0, 90.0).unwrap();
        let times = vec![0.0, 0.125, 0.125, 20.0, 256.0, 1024.0];
        let values = vec![1.000000000001, 2.0, -3.0, 10.0, 2.0, 3.0];
        let epoch = 1_790_000_000_000.0;
        for dpr in [1.0, 1.25, 2.0] {
            chart.resize(160.0 * dpr, 90.0_f64.mul_add(dpr, 0.0).round()).unwrap();
            chart.load_series(times.clone(), values.clone()).unwrap();
            let relative = chart.render().unwrap();
            let fingerprint = inspect(&relative).1;
            let loaded = chart.load_series(times.iter().map(|t| t + epoch).collect(), values.clone()).unwrap();
            assert_eq!((loaded.raw_points, loaded.from, loaded.to), (6, epoch, epoch + 1024.0));
            assert!(loaded.load_ms.is_finite() && loaded.load_ms >= 0.0);
            assert_eq!(chart.hit_test(epoch).unwrap().value, values[0]);
            assert_eq!(chart.hit_test(epoch + 0.125).unwrap().index, 1);
            assert!(chart.load_series(vec![1.0, 0.0], vec![1.0, 2.0]).is_err());
            assert!(chart.load_series(vec![0.0; 20001], vec![0.0; 20001]).is_err());
            let absolute = chart.render().unwrap();
            assert_eq!((absolute.raw_points, absolute.from, absolute.to), (6, epoch, epoch + 1024.0));
            assert_eq!(inspect(&absolute).1, fingerprint);
            assert_eq!(inspect(&relative).1, fingerprint);
            chart.release_frame(relative.frame_id as f64).unwrap();
            chart.release_frame(absolute.frame_id as f64).unwrap();
        }
        chart.load_series(vec![epoch; 4], vec![1.0, 10.0, -10.0, 1.0]).unwrap();
        let same_time = chart.render().unwrap();
        assert_eq!((same_time.visible_points, same_time.rendered_vertices), (4, 4));
        assert!(inspect(&same_time).0 > 0);
        chart.release_frame(same_time.frame_id as f64).unwrap();
        chart.dispose().unwrap();
    }

    #[test]
    fn epoch_singleton_and_duplicates_render_padded_request_with_stable_hits_and_pixels() {
        let epoch = 1_790_000_000_000.25;
        let mut chart = Chart::new(160.0, 90.0).unwrap();
        let mut duplicates = vec![5.0; 513];
        duplicates[129] = -9.0;
        duplicates[385] = 12.0;
        for (values, vertices, min, max) in [
            (vec![2.500000000001], 1, 2.500000000001, 2.500000000001),
            (duplicates, 4, -9.0, 12.0),
            (vec![5.0; 129], 2, 5.0, 5.0),
        ] {
            let loaded = chart.load_series(vec![epoch; values.len()], values.clone()).unwrap();
            assert_eq!((loaded.from, loaded.to), (epoch, epoch));
            let zero_span = chart.render().unwrap();
            let pixels = inspect(&zero_span);
            assert!(pixels.0 > 0, "同时间样本必须真实可见，rawPoints={}", values.len());
            chart.release_frame(zero_span.frame_id as f64).unwrap();
            let request = (epoch - 500.0, epoch + 500.0);
            chart.set_viewport(request.0, request.1).unwrap();
            for _ in 0..3 {
                let frame = chart.render().unwrap();
                assert_eq!((frame.from, frame.to), request);
                assert_eq!((frame.from.to_bits(), frame.to.to_bits()), (request.0.to_bits(), request.1.to_bits()));
                assert_eq!((frame.raw_points, frame.visible_points), (values.len() as u32, values.len() as u32));
                assert_eq!((frame.rendered_vertices, frame.y_min, frame.y_max), (vertices, min, max));
                assert_eq!(inspect(&frame), pixels);
                for query in [request.0, epoch, request.1] {
                    let hit = chart.hit_test(query).unwrap();
                    assert_eq!((hit.index, hit.timestamp, hit.value), (0, epoch, values[0]));
                }
                assert!(chart.release_frame(frame.frame_id as f64).unwrap());
            }
            // 非对称 padding 必须真实移动几何，不能只改回执中的 from/to。
            let shifted_request = (epoch - 750.0, epoch + 250.0);
            chart.set_viewport(shifted_request.0, shifted_request.1).unwrap();
            let shifted = chart.render().unwrap();
            assert_eq!((shifted.from, shifted.to), shifted_request);
            assert!(inspect(&shifted).0 > 0);
            assert_ne!(inspect(&shifted).1, pixels.1);
            chart.release_frame(shifted.frame_id as f64).unwrap();
        }
        assert_eq!(chart.stats().in_flight, 0);
        assert_eq!(chart.stats().allocated_surfaces, 1);
        chart.dispose().unwrap();
    }

    #[test]
    fn explicit_irregular_external_and_empty_frames_echo_request_without_endpoint_clamp() {
        let epoch = 1_790_000_000_000.25;
        let mut chart = Chart::new(160.0, 90.0).unwrap();
        chart.load_series(
            vec![epoch, epoch, epoch + 0.125, epoch + 31.0, epoch + 5000.0, epoch + 5000.0],
            vec![2.0, -8.0, 4.0, 20.0, 5.0, -3.0],
        ).unwrap();
        for (from, to, visible, min, max) in [
            (epoch - 500.0, epoch + 5500.0, 6, -8.0, 20.0),
            (epoch - 500.0, epoch - 0.125, 0, 0.0, 1.0),
            (epoch - 500.0, epoch, 2, -8.0, 2.0),
            (epoch + 5000.125, epoch + 5500.0, 0, 0.0, 1.0),
            (epoch + 5000.0, epoch + 5500.0, 2, -3.0, 5.0),
            (epoch + 0.25, epoch + 30.875, 0, 0.0, 1.0),
            (epoch + 31.0, epoch + 31.0, 1, 20.0, 20.0),
        ] {
            chart.set_viewport(from, to).unwrap();
            // 非法更新不得破坏上一次合法请求，即使反转范围完全位于数据域外。
            assert!(chart.set_viewport(epoch - 1.0, epoch - 2.0).is_err());
            assert!(chart.set_viewport(f64::NAN, to).is_err());
            assert!(chart.set_viewport(from, f64::INFINITY).is_err());
            let frame = chart.render().unwrap();
            assert_eq!((frame.from, frame.to), (from, to));
            assert_eq!((frame.raw_points, frame.visible_points, frame.y_min, frame.y_max), (6, visible, min, max));
            if visible == 0 {
                assert_eq!(frame.rendered_vertices, 0);
                assert_eq!(inspect(&frame).0, 0);
            } else {
                assert!(frame.rendered_vertices > 0);
                assert!(inspect(&frame).0 > 0);
            }
            assert_eq!(chart.hit_test(epoch - 500.0).unwrap().index, 0);
            assert_eq!(chart.hit_test(epoch + 5500.0).unwrap().index, 4);
            assert_eq!(chart.hit_test(epoch + 15.5625).unwrap().index, 3);
            chart.release_frame(frame.frame_id as f64).unwrap();
        }
        chart.dispose().unwrap();
    }

    #[test]
    fn reloading_between_explicit_and_generated_data_switches_viewport_policy() {
        let mut chart = Chart::new(160.0, 90.0).unwrap();
        for _ in 0..2 {
            chart.load_series(vec![0.0, 1.0, 2.0], vec![1.0, 2.0, 3.0]).unwrap();
            chart.set_viewport(-500.0, 500.0).unwrap();
            let explicit = chart.render().unwrap();
            assert_eq!((explicit.from, explicit.to), (-500.0, 500.0));
            assert_eq!(explicit.visible_points, 3);
            chart.release_frame(explicit.frame_id as f64).unwrap();
            chart.generate(3.0).unwrap();
            for (from, to, expected) in [
                (-500.0, 500.0, (0.0, 2.0, 3)),
                (-500.0, -1.0, (0.0, 0.0, 1)),
                (3.0, 500.0, (2.0, 2.0, 1)),
            ] {
                chart.set_viewport(from, to).unwrap();
                let implicit = chart.render().unwrap();
                assert_eq!((implicit.from, implicit.to, implicit.visible_points), expected);
                chart.release_frame(implicit.frame_id as f64).unwrap();
            }
        }
        chart.dispose().unwrap();
    }

    #[test]
    fn semantic_colors_change_actual_pixels_and_invalid_updates_preserve_color() {
        let mut chart = Chart::new(160.0, 90.0).unwrap();
        chart.load_series(vec![0.0, 1.0], vec![0.0, 1.0]).unwrap();
        chart.set_colors(&[12.0, 37.0, 215.0], &[12.0, 37.0, 215.0]).unwrap();
        let blue = chart.render().unwrap();
        let blue_pixels = inspect(&blue);
        assert_eq!(blue_pixels.0, 160 * 90);
        assert!(chart.set_colors(&[0.0, 0.0, 0.0], &[256.0, 0.0, 0.0]).is_err());
        let unchanged = chart.render().unwrap();
        assert_eq!(inspect(&unchanged), blue_pixels);
        chart.release_frame(unchanged.frame_id as f64).unwrap();
        chart.set_colors(&[215.0, 37.0, 12.0], &[215.0, 37.0, 12.0]).unwrap();
        let red = chart.render().unwrap();
        assert_eq!(inspect(&red).0, 0);
        assert_ne!(inspect(&red).1, blue_pixels.1);
        assert_eq!(inspect(&blue), blue_pixels);
        chart.release_frame(red.frame_id as f64).unwrap();
        chart.release_frame(blue.frame_id as f64).unwrap();
        chart.dispose().unwrap();
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn native_renderer_is_explicitly_unsupported() {
    let error = harness_chart_runtime::chart::Chart::new(320.0, 180.0).err().unwrap();
    assert!(error.contains("UNSUPPORTED"));
}
