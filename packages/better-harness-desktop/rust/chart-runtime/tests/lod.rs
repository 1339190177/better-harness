use harness_chart_runtime::{
    dataset::{Dataset, Extremes},
    validation::{MAX_POINTS, Viewport, dimensions, integer},
};

fn oracle(data: &Dataset, a: usize, b: usize) -> Extremes {
    let mut min = a as u32;
    let mut max = min;
    for i in a as u32..=b as u32 {
        if data.value(i) < data.value(min) { min = i; }
        if data.value(i) > data.value(max) { max = i; }
    }
    Extremes { min, max }
}

fn viewport(a: f64, b: f64, data: &Dataset) -> Viewport {
    Viewport::new(a, b, data.len()).unwrap()
}

#[test]
fn range_queries_match_scan_oracle_across_block_boundaries() {
    let data = Dataset::generate(4099).unwrap();
    for a in (0..data.len()).step_by(31) {
        for b in (a..data.len()).step_by(47) {
            assert_eq!(data.range_extremes(a, b).unwrap(), oracle(&data, a, b));
        }
    }
    for (a, b) in [(0, 127), (0, 128), (127, 128), (128, 383), (4096, 4098)] {
        assert_eq!(data.range_extremes(a, b).unwrap(), oracle(&data, a, b));
    }
}

#[test]
fn bucket_outputs_match_independent_scan_oracle() {
    let data = Dataset::generate(2039).unwrap();
    for width in [1, 2, 3, 7, 127, 400, 4096] {
        for (a, b) in [(0.0, 2038.0), (0.1, 2037.9), (123.25, 789.5), (2.0, 3.0)] {
            let view = viewport(a, b, &data);
            let mut expected = vec![a.ceil() as u32, b.floor() as u32];
            for bucket in 0..width {
                let left = a + (b - a) * bucket as f64 / width as f64;
                let right = a + (b - a) * (bucket + 1) as f64 / width as f64;
                let members: Vec<_> = (a.ceil() as usize..=b.floor() as usize)
                    .filter(|&i| i as f64 >= left && ((i as f64) < right || bucket + 1 == width)).collect();
                if let (Some(&first), Some(&last)) = (members.first(), members.last()) {
                    let ex = oracle(&data, first, last);
                    expected.extend([ex.min, ex.max]);
                }
            }
            expected.sort_unstable();
            expected.dedup();
            assert_eq!(data.lod(view, width).unwrap().indices, expected);
        }
    }
}

#[test]
fn min_max_are_emitted_in_time_order_not_value_order() {
    let data = Dataset::from_values(vec![0.0, 9.0, -8.0, 1.0]).unwrap();
    assert_eq!(data.lod(viewport(0.0, 3.0, &data), 1).unwrap().indices, [0, 1, 2, 3]);
}

#[test]
fn endpoints_are_preserved_and_duplicates_removed() {
    let data = Dataset::from_values(vec![5.0; 2048]).unwrap();
    let lod = data.lod(viewport(0.0, 2047.0, &data), 13).unwrap();
    assert_eq!(lod.indices.first(), Some(&0));
    assert_eq!(lod.indices.last(), Some(&2047));
    assert!(lod.indices.windows(2).all(|v| v[0] < v[1]));
    assert!(lod.indices.len() <= 28);
    assert_eq!((lod.y_min, lod.y_max), (5.0, 5.0));
}

#[test]
fn visible_count_uses_real_ceil_floor_boundaries() {
    let data = Dataset::generate(20).unwrap();
    for (a, b, expected) in [(0.1, 8.9, 8), (0.0, 9.0, 10), (1.0, 1.0, 1), (1.01, 1.99, 0)] {
        assert_eq!(data.lod(viewport(a, b, &data), 8).unwrap().visible_points, expected);
    }
}

#[test]
fn sub_sample_and_singleton_ranges_are_finite() {
    let data = Dataset::generate(20).unwrap();
    let empty = data.lod(viewport(7.1, 7.9, &data), 4096).unwrap();
    assert!(empty.indices.is_empty());
    assert!(empty.y_min.is_finite() && empty.y_max.is_finite());
    let singleton = data.lod(viewport(7.0, 7.0, &data), 4096).unwrap();
    assert_eq!(singleton.indices, [7]);
    let data = Dataset::generate(1).unwrap();
    assert_eq!(data.lod(viewport(0.0, 0.0, &data), 1).unwrap().indices, [0]);
}

#[test]
fn invalid_ranges_reject_nan_infinity_and_reversal_before_clamping() {
    for (a, b) in [(f64::NAN, 1.0), (0.0, f64::INFINITY), (2.0, 1.0), (f64::NEG_INFINITY, 0.0)] {
        assert!(Viewport::new(a, b, 10).is_err());
    }
    assert!(Viewport::new(0.0, 1.0, 0).is_err());
    assert_eq!(Viewport::new(-1e100, 1e100, 10).unwrap(), Viewport { from: 0.0, to: 9.0 });
    assert_eq!(Viewport::new(20.0, 30.0, 10).unwrap(), Viewport { from: 9.0, to: 9.0 });
}

#[test]
fn extreme_sparse_spikes_survive_lod_without_float_overflow() {
    let mut values = vec![0.0; 10_000];
    values[128] = -f32::MAX;
    values[9897] = f32::MAX;
    let data = Dataset::from_values(values).unwrap();
    let lod = data.lod(viewport(0.0, 9999.0, &data), 1).unwrap();
    assert_eq!(lod.indices, [0, 128, 9897, 9999]);
    assert!((lod.y_max - lod.y_min).is_finite());
}

#[test]
fn ties_choose_earliest_original_index() {
    let data = Dataset::from_values(vec![2.0; 1000]).unwrap();
    assert_eq!(data.range_extremes(129, 900).unwrap(), Extremes { min: 129, max: 129 });
}

#[test]
fn hit_test_uses_nearest_original_not_lod() {
    let data = Dataset::from_values((0..1000).map(|i| i as f32 * 0.3).collect()).unwrap();
    for (timestamp, index) in [(-10.0, 0), (12.49, 12), (12.5, 13), (99999.0, 999)] {
        let hit = data.hit_test(timestamp).unwrap();
        assert_eq!(hit.index, index);
        assert_eq!(hit.timestamp, index as f64);
        assert_eq!(hit.value, data.value(index) as f64);
    }
    assert!(data.hit_test(f64::NAN).is_err());
    assert!(data.hit_test(f64::INFINITY).is_err());
}

#[test]
fn input_limits_reject_truncation_wrapping_empty_and_nonfinite_values() {
    for value in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, 4294967297.0] {
        assert!(integer(value, 1, 10_000_000, "points").is_err());
        assert!(dimensions(value, 100.0).is_err());
    }
    assert!(dimensions(4096.0, 4096.0).is_err());
    assert!(dimensions(4096.0, 2048.0).is_ok());
    assert!(dimensions(4097.0, 1.0).is_err());
    assert!(Dataset::generate(0).is_err());
    assert!(Dataset::generate(MAX_POINTS + 1).is_err());
    assert!(Dataset::from_values(vec![]).is_err());
    assert!(Dataset::from_values(vec![f32::NAN]).is_err());
    assert!(Dataset::from_values(vec![f32::INFINITY]).is_err());
}

#[test]
fn generation_is_deterministic_and_nonflat() {
    let a = Dataset::generate(1000).unwrap();
    let b = Dataset::generate(1000).unwrap();
    for i in 0..1000 { assert_eq!(a.value(i), b.value(i)); }
    let ex = a.range_extremes(0, 999).unwrap();
    assert!(a.value(ex.max) - a.value(ex.min) > 20.0);
}

#[test]
fn invalid_query_and_width_are_errors() {
    let data = Dataset::generate(10).unwrap();
    assert!(data.range_extremes(2, 1).is_err());
    assert!(data.range_extremes(0, 10).is_err());
    for width in [0, 4097, u32::MAX] {
        assert!(data.lod(viewport(0.0, 9.0, &data), width).is_err());
    }
}

#[test]
fn ten_million_points_remain_bounded_and_match_full_range_oracle() {
    let start = std::time::Instant::now();
    let data = Dataset::generate(MAX_POINTS).unwrap();
    let generation_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = std::time::Instant::now();
    let lod = data.lod(viewport(0.0, (MAX_POINTS - 1) as f64, &data), 1920).unwrap();
    let lod_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(lod.visible_points, 10_000_000);
    assert!(lod.indices.len() <= 3842);
    let ex = oracle(&data, 0, MAX_POINTS - 1);
    assert_eq!((lod.y_min, lod.y_max), (data.value(ex.min) as f64, data.value(ex.max) as f64));
    assert!(lod.indices.contains(&ex.min) && lod.indices.contains(&ex.max));
    eprintln!("10M generationMs={generation_ms:.3}, lodMs={lod_ms:.3}, vertices={}", lod.indices.len());
}
