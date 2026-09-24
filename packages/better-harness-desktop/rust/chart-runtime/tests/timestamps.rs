use harness_chart_runtime::{dataset::Dataset, validation::{Colors, MAX_API_POINTS, Viewport, dimensions}};

// 独立扫描 oracle：按真实时间做交叉乘法分桶，不调用数据层的二分/极值树/坐标函数。
fn assert_scan(data: &Dataset, view: Viewport, width: u32) {
    let visible: Vec<u32> = (0..data.len() as u32)
        .filter(|&i| data.timestamp(i) >= view.from && data.timestamp(i) <= view.to).collect();
    let mut buckets = vec![Vec::<u32>::new(); width as usize];
    for &i in &visible {
        let relative = (data.timestamp(i) - view.from) * f64::from(width);
        let span = view.to - view.from;
        let bucket = (0..width - 1).find(|b| relative < span * f64::from(b + 1)).unwrap_or(width - 1);
        buckets[bucket as usize].push(i);
    }
    let mut expected = Vec::new();
    for members in buckets {
        if let Some(&first) = members.first() {
            let (mut min, mut max) = (first, first);
            for i in members {
                if data.value(i) < data.value(min) { min = i; }
                if data.value(i) > data.value(max) { max = i; }
            }
            expected.extend([min, max]);
        }
    }
    if let (Some(&first), Some(&last)) = (visible.first(), visible.last()) { expected.extend([first, last]); }
    expected.sort_unstable();
    expected.dedup();
    let lod = data.lod(view, width).unwrap();
    assert_eq!(lod.indices, expected, "视域 {view:?}, 物理宽度 {width}");
    assert_eq!(lod.visible_points as usize, visible.len());
    assert!(lod.indices.len() <= 2 * width as usize + 2);
    if visible.is_empty() {
        assert_eq!((lod.y_min, lod.y_max), (0.0, 1.0));
    } else {
        let min = visible.iter().map(|&i| data.value(i)).fold(f64::INFINITY, f64::min);
        let max = visible.iter().map(|&i| data.value(i)).fold(f64::NEG_INFINITY, f64::max);
        assert_eq!((lod.y_min, lod.y_max), (min, max));
    }
}

#[test]
fn irregular_real_times_and_duplicates_match_scan_at_physical_pixel_widths() {
    let epoch = 1_790_000_000_000.0;
    let mut timestamp = epoch;
    let mut times = Vec::new();
    let mut values = Vec::new();
    for i in 0..4099 {
        timestamp += match i % 11 { 0..=3 => 0.0, 4..=6 => 0.125, 7 => 500.0, _ => 3.5 };
        times.push(timestamp);
        values.push(((i * 31) % 101) as f64 + (i % 7) as f64 * 1e-10);
    }
    let data = Dataset::from_series(times, values).unwrap();
    for width in [1, 2, 3, 7, 127, 320, 640, 4096] {
        for (a, b) in [(epoch, timestamp), (epoch + 0.125, epoch + 1030.875), (epoch + 2.5, epoch + 9.75)] {
            assert_scan(&data, data.viewport(a, b).unwrap(), width);
        }
    }
}

#[test]
fn timestamp_duplicates_keep_both_extrema_and_original_order() {
    let data = Dataset::from_series(vec![0.0, 10.0, 10.0, 10.0, 10.0, 20.0], vec![0.0, 2.0, 99.0, -80.0, 3.0, 0.0]).unwrap();
    for width in [1, 2, 3, 100] {
        let view = data.viewport(0.0, 20.0).unwrap();
        assert_scan(&data, view, width);
        let lod = data.lod(view, width).unwrap();
        assert!(lod.indices.contains(&2) && lod.indices.contains(&3));
    }
    let lod = data.lod(data.viewport(10.0, 10.0).unwrap(), 320).unwrap();
    assert_eq!(lod.visible_points, 4);
    assert_eq!(lod.indices, [1, 2, 3, 4]);
}

#[test]
fn single_all_equal_and_fractional_empty_views_remain_honest() {
    let epoch = 1_790_000_000_000.25;
    for values in [vec![2.5], vec![5.0, 9.0, -7.0, 5.0], vec![2.5; 129]] {
        let data = Dataset::from_series(vec![epoch; values.len()], values).unwrap();
        let view = data.viewport(epoch, epoch).unwrap();
        assert_scan(&data, view, 2);
        let lod = data.lod(view, 2).unwrap();
        for &i in &lod.indices { assert_eq!(data.pixel_position(i, &lod, view, 320, 180)[0], 160.0); }
        assert_eq!(data.hit_test(epoch + 10.0).unwrap().index, 0);
    }
    let data = Dataset::from_series(vec![epoch, epoch + 5.0, epoch + 5000.0], vec![1.0, 2.0, 3.0]).unwrap();
    for (a, b, n) in [(epoch + 0.125, epoch + 4.875, 0), (epoch + 4.875, epoch + 5.125, 1), (epoch, epoch + 5.0, 2)] {
        let view = data.viewport(a, b).unwrap();
        assert_scan(&data, view, 640);
        assert_eq!(data.lod(view, 640).unwrap().visible_points, n);
        assert_eq!((view.from, view.to), (a, b));
    }
}

#[test]
fn epoch_singleton_padded_viewport_keeps_request_and_centered_lod() {
    let epoch = 1_790_000_000_000.25;
    let value = 2.500000000001;
    let data = Dataset::from_api_series(vec![epoch], vec![value]).unwrap();
    let request = Viewport { from: epoch - 500.0, to: epoch + 500.0 };
    let view = data.viewport(request.from, request.to).unwrap();
    assert_eq!(view, request);
    assert_eq!(data.domain(), (epoch, epoch));
    for width in [1, 2, 7, 320, 4096] {
        assert_scan(&data, request, width);
        let lod = data.lod(view, width).unwrap();
        assert_eq!((lod.visible_points, lod.indices.as_slice()), (1, &[0][..]));
        assert_eq!((lod.y_min, lod.y_max), (value, value));
        assert_eq!(data.pixel_position(0, &lod, view, width, 180), [width as f32 / 2.0, 90.0]);
    }
    for query in [request.from, epoch, request.to] {
        let hit = data.hit_test(query).unwrap();
        assert_eq!((hit.index, hit.timestamp, hit.value), (0, epoch, value));
    }
}

#[test]
fn epoch_all_duplicate_padded_lod_retains_min_max_and_first_last() {
    let epoch = 1_790_000_000_000.25;
    let mut values = vec![5.0; 513];
    values[129] = -9.0;
    values[385] = 12.0;
    let data = Dataset::from_api_series(vec![epoch; values.len()], values).unwrap();
    let request = Viewport { from: epoch - 500.0, to: epoch + 500.0 };
    let view = data.viewport(request.from, request.to).unwrap();
    assert_eq!(view, request);
    for width in [1, 2, 7, 320, 4096] {
        assert_scan(&data, request, width);
        let lod = data.lod(view, width).unwrap();
        assert_eq!(lod.visible_points, 513);
        assert_eq!(lod.indices, [0, 129, 385, 512]);
        assert_eq!((lod.y_min, lod.y_max), (-9.0, 12.0));
        for &i in &lod.indices {
            let pixel = data.pixel_position(i, &lod, view, width, 180);
            assert_eq!(pixel[0], width as f32 / 2.0);
            assert!(pixel.into_iter().all(f32::is_finite));
        }
    }
    for query in [request.from, epoch, request.to] {
        let hit = data.hit_test(query).unwrap();
        assert_eq!((hit.index, hit.timestamp, hit.value), (0, epoch, 5.0));
    }
}

#[test]
fn explicit_irregular_viewports_keep_padding_and_empty_outside_ranges() {
    let epoch = 1_790_000_000_000.25;
    let data = Dataset::from_api_series(
        vec![epoch, epoch, epoch + 0.125, epoch + 31.0, epoch + 5000.0, epoch + 5000.0],
        vec![2.0, -8.0, 4.0, 20.0, 5.0, -3.0],
    ).unwrap();
    for (from, to, count) in [
        (epoch - 500.0, epoch + 5500.0, 6),
        (epoch - 500.0, epoch, 2),
        (epoch + 5000.0, epoch + 5500.0, 2),
        (epoch - 500.0, epoch - 0.125, 0),
        (epoch + 5000.125, epoch + 5500.0, 0),
        (epoch + 0.25, epoch + 30.875, 0),
        (epoch + 31.0, epoch + 31.0, 1),
        (epoch - 0.125, epoch - 0.125, 0),
        (epoch + 5000.125, epoch + 5000.125, 0),
    ] {
        let request = Viewport { from, to };
        assert_eq!(data.viewport(from, to).unwrap(), request);
        for width in [1, 3, 320, 4096] {
            assert_scan(&data, request, width);
            let lod = data.lod(request, width).unwrap();
            assert_eq!(lod.visible_points, count);
            for &i in &lod.indices {
                let pixel = data.pixel_position(i, &lod, request, width, 180);
                assert!(pixel.into_iter().all(f32::is_finite));
                assert!(pixel[0] >= 0.5 && pixel[0] <= width as f32 - 0.5);
            }
        }
    }
    assert_eq!(data.hit_test(epoch - 500.0).unwrap().index, 0);
    assert_eq!(data.hit_test(epoch + 5500.0).unwrap().index, 4);
    assert_eq!(data.domain(), (epoch, epoch + 5000.0));
}

#[test]
fn implicit_helpers_still_clamp_even_when_explicit_times_match_their_indices() {
    let explicit = Dataset::from_series(vec![0.0, 1.0, 2.0], vec![1.0, 2.0, 3.0]).unwrap();
    for implicit in [Dataset::from_values(vec![1.0, 2.0, 3.0]).unwrap(), Dataset::generate(3).unwrap()] {
        for (from, to, bounded, count) in [
            (-500.0, 502.0, Viewport { from: 0.0, to: 2.0 }, 3),
            (-500.0, -1.0, Viewport { from: 0.0, to: 0.0 }, 1),
            (3.0, 502.0, Viewport { from: 2.0, to: 2.0 }, 1),
        ] {
            let request = Viewport { from, to };
            assert_eq!(explicit.viewport(from, to).unwrap(), request);
            assert_scan(&explicit, request, 3);
            assert_eq!(implicit.viewport(from, to).unwrap(), bounded);
            assert_eq!(Viewport::new(from, to, 3).unwrap(), bounded);
            assert_eq!(Viewport::bounded(from, to, 0.0, 2.0).unwrap(), bounded);
            assert_eq!(implicit.lod(request, 3).unwrap().visible_points, count);
        }
    }
    let single = Dataset::generate(1).unwrap();
    assert_eq!(single.viewport(-500.0, 500.0).unwrap(), Viewport { from: 0.0, to: 0.0 });
}

#[test]
fn explicit_viewports_reject_nonfinite_and_reversed_ranges_without_clamping() {
    let data = Dataset::from_series(vec![10.0], vec![1.0]).unwrap();
    for (from, to) in [
        (f64::NAN, 10.0), (10.0, f64::NAN),
        (f64::NEG_INFINITY, 10.0), (10.0, f64::INFINITY),
        (-1.0, -2.0), (12.0, 11.0),
    ] {
        assert!(data.viewport(from, to).is_err());
        assert!(data.lod(Viewport { from, to }, 320).is_err());
    }
    let request = Viewport { from: -f64::MAX, to: f64::MAX };
    assert_eq!(data.viewport(request.from, request.to).unwrap(), request);
    let lod = data.lod(request, 320).unwrap();
    assert_eq!(lod.indices, [0]);
    assert!(data.pixel_position(0, &lod, request, 320, 180).into_iter().all(f32::is_finite));
}

#[test]
fn invalid_sorted_nonfinite_mismatched_and_api_lengths_are_rejected() {
    assert!(Dataset::from_series(vec![], vec![]).is_err());
    assert!(Dataset::from_series(vec![0.0], vec![]).is_err());
    assert!(Dataset::from_series(vec![1.0, 0.0], vec![1.0, 2.0]).is_err());
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(Dataset::from_series(vec![bad], vec![1.0]).is_err());
        assert!(Dataset::from_series(vec![1.0], vec![bad]).is_err());
    }
    assert!(Dataset::from_api_series(vec![1.0; MAX_API_POINTS], vec![2.0; MAX_API_POINTS]).is_ok());
    assert!(Dataset::from_api_series(vec![1.0; MAX_API_POINTS + 1], vec![2.0; MAX_API_POINTS + 1]).is_err());
    assert!(Dataset::from_api_series(vec![], vec![]).is_err());
    assert!(Dataset::from_series(vec![1.0; MAX_API_POINTS + 1], vec![2.0; MAX_API_POINTS + 1]).is_ok());
}

#[test]
fn f64_values_and_timestamps_are_not_rounded_to_f32_in_hits_or_extrema() {
    let base = 1_790_000_000_000.0;
    let values = [1.000000000001, 1.000000000003, 1.000000000002];
    let data = Dataset::from_series(vec![base, base + 0.125, base + 0.25], values.to_vec()).unwrap();
    assert_eq!(values[0] as f32, values[1] as f32);
    for (i, value) in values.into_iter().enumerate() {
        let hit = data.hit_test(base + i as f64 * 0.125).unwrap();
        assert_eq!(hit.index, i as u32);
        assert_eq!(hit.timestamp.to_bits(), (base + i as f64 * 0.125).to_bits());
        assert_eq!(hit.value.to_bits(), value.to_bits());
    }
    let lod = data.lod(data.viewport(base, base + 0.25).unwrap(), 1).unwrap();
    assert_eq!((lod.y_min, lod.y_max), (values[0], values[1]));
    assert_eq!(lod.indices, [0, 1, 2]);
}

#[test]
fn nearest_matches_raw_scan_with_right_ties_and_first_duplicate() {
    let times = [-5.0, -5.0, 0.125, 0.125, 20.0, 30.0, 30.0];
    let data = Dataset::from_series(times.to_vec(), (0..times.len()).map(|i| i as f64).collect()).unwrap();
    for step in -1000..=4000 {
        let query = step as f64 / 100.0;
        let mut best = 0;
        for i in 1..times.len() {
            let distance = (times[i] - query).abs();
            let previous = (times[best] - query).abs();
            if distance < previous || (distance == previous && times[i] > times[best]) { best = i; }
        }
        let hit = data.hit_test(query).unwrap();
        assert_eq!(hit.index as usize, best);
        assert_eq!((hit.timestamp, hit.value), (times[best], best as f64));
    }
    for (query, index) in [(10.0625, 4), (25.0, 5), (30.0, 5), (1e100, 5), (-1e100, 0)] {
        assert_eq!(data.hit_test(query).unwrap().index, index);
    }
}

#[test]
fn epoch_translation_and_dpr_use_identical_relative_geometry() {
    let times = vec![0.0, 0.125, 0.125, 1.0, 20.0, 256.0, 1024.0];
    let epoch = 1_790_000_000_000.0;
    let values = vec![1.0, 2.0, -3.0, 10.0, 2.0, 4.0, 3.0];
    let relative = Dataset::from_series(times.clone(), values.clone()).unwrap();
    let absolute = Dataset::from_series(times.iter().map(|t| t + epoch).collect(), values).unwrap();
    let a = relative.viewport(0.125, 1024.0).unwrap();
    let b = absolute.viewport(epoch + 0.125, epoch + 1024.0).unwrap();
    for dpr in [1.0, 1.25, 2.0, 3.0] {
        let (width, height) = dimensions(320.0 * dpr, 180.0 * dpr).unwrap();
        let ra = relative.lod(a, width).unwrap();
        let rb = absolute.lod(b, width).unwrap();
        assert_eq!(ra.indices, rb.indices);
        assert_scan(&absolute, b, width);
        for &i in &ra.indices {
            let p = absolute.pixel_position(i, &rb, b, width, height);
            assert_eq!(p, relative.pixel_position(i, &ra, a, width, height));
            assert!(p[0] >= 0.5 && p[0] <= width as f32 - 0.5);
            assert!(p[1] >= 0.5 && p[1] <= height as f32 - 0.5);
        }
    }
}

#[test]
fn extreme_f64_ranges_render_finite_relative_coordinates() {
    let data = Dataset::from_series(vec![-f64::MAX, 0.0, f64::MAX], vec![-f64::MAX, f64::MAX, 0.0]).unwrap();
    let view = data.viewport(-f64::MAX, f64::MAX).unwrap();
    let lod = data.lod(view, 320).unwrap();
    assert_eq!(lod.indices, [0, 1, 2]);
    assert_eq!((lod.y_min, lod.y_max), (-f64::MAX, f64::MAX));
    for i in 0..3 { assert!(data.pixel_position(i, &lod, view, 320, 180).into_iter().all(f32::is_finite)); }
    let tiny = f64::from_bits(1);
    let data = Dataset::from_series(vec![0.0, tiny, tiny * 2.0], vec![0.0, tiny, tiny * 2.0]).unwrap();
    let view = data.viewport(0.0, tiny * 2.0).unwrap();
    let lod = data.lod(view, 320).unwrap();
    assert_eq!(data.pixel_position(1, &lod, view, 320, 180), [160.0, 90.0]);
    let times: Vec<_> = (0..127).map(|i| tiny * i as f64).collect();
    let values = (0..127).map(|i| ((i * 17) % 31) as f64).collect();
    let data = Dataset::from_series(times, values).unwrap();
    for width in [1, 3, 7, 17, 320] {
        assert_scan(&data, data.viewport(0.0, tiny * 126.0).unwrap(), width);
    }
}

#[test]
fn semantic_color_channels_are_strict_integer_rgb_without_clamping() {
    let colors = Colors::new(&[0.0, 127.0, 255.0], &[255.0, 0.0, 42.0]).unwrap();
    assert_eq!(colors.background, [0, 127, 255]);
    assert_eq!(colors.line, [255, 0, 42]);
    for bad in [-1.0, 256.0, 1.5, f64::NAN, f64::INFINITY] {
        assert!(Colors::new(&[0.0, bad, 0.0], &[0.0; 3]).is_err());
        assert!(Colors::new(&[0.0; 3], &[0.0, bad, 0.0]).is_err());
    }
    for channels in [vec![], vec![1.0; 2], vec![1.0; 4]] {
        assert!(Colors::new(&channels, &[0.0; 3]).is_err());
        assert!(Colors::new(&[0.0; 3], &channels).is_err());
    }
}
