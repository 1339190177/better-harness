use crate::{
    ChartResult,
    validation::{MAX_API_POINTS, MAX_DIMENSION, MAX_POINTS, Viewport, unit_position},
};

const BLOCK: usize = 128;
const NONE: u32 = u32::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Extremes {
    pub min: u32,
    pub max: u32,
}

impl Extremes {
    const EMPTY: Self = Self { min: NONE, max: NONE };
    fn single(index: usize) -> Self {
        Self { min: index as u32, max: index as u32 }
    }

    fn merge(self, other: Self, values: &[f64]) -> Self {
        if self.min == NONE { return other; }
        if other.min == NONE { return self; }
        let min = if (values[self.min as usize], self.min) <= (values[other.min as usize], other.min) {
            self.min
        } else {
            other.min
        };
        let max = if values[self.max as usize] > values[other.max as usize]
            || (values[self.max as usize] == values[other.max as usize] && self.max < other.max)
        {
            self.max
        } else {
            other.max
        };
        Self { min, max }
    }
}

pub struct Dataset {
    timestamps: Vec<f64>,
    values: Vec<f64>,
    tree: Vec<Extremes>,
    leaf_base: usize,
    // 由构造入口决定兼容策略，不能通过时间戳恰好等于样本索引来推断。
    implicit_timestamps: bool,
}

#[derive(Debug)]
pub struct Lod {
    pub indices: Vec<u32>,
    pub visible_points: u32,
    pub y_min: f64,
    pub y_max: f64,
}

#[derive(Debug, PartialEq)]
pub struct Hit {
    pub index: u32,
    pub timestamp: f64,
    pub value: f64,
}

impl Dataset {
    // 压力测试入口，不通过 N-API 暴露。
    pub fn generate(count: usize) -> ChartResult<Self> {
        if count == 0 || count > MAX_POINTS {
            return Err("INVALID_ARGUMENT: points 必须在 1..=10000000 范围内".into());
        }
        let mut values = Vec::with_capacity(count);
        let period = (count / 37).max(31);
        let spike_width = (period / 180).max(1);
        for i in 0..count {
            let t = i as f64 / (count.saturating_sub(1).max(1)) as f64;
            let phase = std::f64::consts::TAU;
            // 大周期轮廓、调频中频、细纹理以及交替正负的稀疏三角尖峰。
            let base = 55.0
                + 11.0 * (phase * 3.0 * t).sin()
                + 4.5 * (phase * (23.0 * t + 7.0 * t * t)).sin()
                + 1.7 * (phase * 149.0 * t).sin()
                + 0.65 * (i as f64 * 0.073).sin();
            let distance = (i % period).abs_diff(period / 2);
            let spike = if distance < spike_width {
                let sign = if (i / period).is_multiple_of(2) { 1.0 } else { -1.0 };
                sign * 19.0 * (1.0 - distance as f64 / spike_width as f64)
            } else { 0.0 };
            values.push((base + spike) as f32);
        }
        Self::from_values(values)
    }

    pub fn from_values(values: Vec<f32>) -> ChartResult<Self> {
        let timestamps = (0..values.len()).map(|i| i as f64).collect();
        let mut dataset = Self::from_series(timestamps, values.into_iter().map(f64::from).collect())?;
        dataset.implicit_timestamps = true;
        Ok(dataset)
    }

    pub fn from_api_series(timestamps: Vec<f64>, values: Vec<f64>) -> ChartResult<Self> {
        if timestamps.is_empty() || timestamps.len() > MAX_API_POINTS || values.len() > MAX_API_POINTS {
            return Err("INVALID_ARGUMENT: loadSeries 数据量必须在 1..=20000 范围内".into());
        }
        Self::from_series(timestamps, values)
    }

    pub fn from_series(timestamps: Vec<f64>, values: Vec<f64>) -> ChartResult<Self> {
        if values.is_empty() || values.len() > MAX_POINTS || timestamps.len() != values.len() {
            return Err("INVALID_ARGUMENT: 时间和值必须等长，数据量在 1..=10000000 范围内".into());
        }
        if values.iter().any(|v| !v.is_finite()) || timestamps.iter().any(|v| !v.is_finite()) {
            return Err("INVALID_ARGUMENT: 时间戳和样本必须有限".into());
        }
        if timestamps.windows(2).any(|pair| pair[0] > pair[1]) {
            return Err("INVALID_ARGUMENT: 时间戳必须非递减".into());
        }
        let leaf_base = values.len().div_ceil(BLOCK).next_power_of_two();
        let mut tree = vec![Extremes::EMPTY; 2 * leaf_base];
        for (i, _) in values.iter().enumerate() {
            let leaf = leaf_base + i / BLOCK;
            tree[leaf] = tree[leaf].merge(Extremes::single(i), &values);
        }
        for i in (1..leaf_base).rev() {
            tree[i] = tree[i * 2].merge(tree[i * 2 + 1], &values);
        }
        Ok(Self { timestamps, values, tree, leaf_base, implicit_timestamps: false })
    }

    pub fn len(&self) -> usize { self.values.len() }
    pub fn is_empty(&self) -> bool { self.values.is_empty() }
    pub fn value(&self, index: u32) -> f64 { self.values[index as usize] }
    pub fn timestamp(&self, index: u32) -> f64 { self.timestamps[index as usize] }
    pub fn domain(&self) -> (f64, f64) { (self.timestamps[0], self.timestamps[self.len() - 1]) }
    pub fn viewport(&self, from: f64, to: f64) -> ChartResult<Viewport> {
        if self.implicit_timestamps {
            Viewport::new(from, to, self.len())
        } else {
            // 显式数据由调用方管理视域；LOD、GPU 坐标及回执共用未经 clamp 的请求。
            Viewport::unclamped(from, to)
        }
    }

    // 两端至多扫描 2×127 点，中间整块做 O(log N) 精确线段树查询。
    pub fn range_extremes(&self, first: usize, last: usize) -> ChartResult<Extremes> {
        if first > last || last >= self.len() {
            return Err("INVALID_ARGUMENT: 极值查询范围越界或为空".into());
        }
        let mut result = Extremes::EMPTY;
        let full_start = first.div_ceil(BLOCK);
        let full_end = (last + 1) / BLOCK;
        if full_start >= full_end {
            for i in first..=last {
                result = result.merge(Extremes::single(i), &self.values);
            }
            return Ok(result);
        }
        for i in first..full_start * BLOCK {
            result = result.merge(Extremes::single(i), &self.values);
        }
        for i in full_end * BLOCK..=last {
            result = result.merge(Extremes::single(i), &self.values);
        }
        let mut left = self.leaf_base + full_start;
        let mut right = self.leaf_base + full_end;
        while left < right {
            if left % 2 == 1 {
                result = result.merge(self.tree[left], &self.values);
                left += 1;
            }
            if right % 2 == 1 {
                right -= 1;
                result = result.merge(self.tree[right], &self.values);
            }
            left /= 2;
            right /= 2;
        }
        Ok(result)
    }

    pub fn lod(&self, viewport: Viewport, width: u32) -> ChartResult<Lod> {
        if width == 0 || width > MAX_DIMENSION {
            return Err("INVALID_ARGUMENT: LOD 宽度必须在 1..=4096 范围内".into());
        }
        let viewport = self.viewport(viewport.from, viewport.to)?;
        let first = self.timestamps.partition_point(|&t| t < viewport.from);
        let end_visible = self.timestamps.partition_point(|&t| t <= viewport.to);
        if first == end_visible {
            return Ok(Lod { indices: vec![], visible_points: 0, y_min: 0.0, y_max: 1.0 });
        }
        let last = end_visible - 1;
        let mut indices = Vec::with_capacity(2 * width as usize + 2);
        indices.push(first as u32);
        let mut start = first;
        let span = viewport.to - viewport.from;
        for bucket in 0..width {
            // 时间桶左闭右开，最后一桶含 to；二分不拆散重复时间戳。
            // 不把 epoch 加回桶边界，以免亚毫秒边界被大绝对时间舍入。
            let end = if bucket + 1 == width {
                end_visible
            } else {
                start + self.timestamps[start..end_visible].partition_point(|&t| {
                    if (span * f64::from(width)).is_finite() {
                        // 交叉乘法不生成绝对时间边界，也避免极小时间跨度的除法下溢。
                        (t - viewport.from) * f64::from(width) < span * f64::from(bucket + 1)
                    } else {
                        unit_position(t, viewport.from, viewport.to) < f64::from(bucket + 1) / f64::from(width)
                    }
                })
            };
            if start < end {
                let extrema = self.range_extremes(start, end - 1)?;
                indices.extend([extrema.min, extrema.max]);
            }
            start = end;
        }
        indices.push(last as u32);
        indices.sort_unstable();
        // 只按样本索引去重，绝不按时间戳去重；同时间的 min/max 都保留。
        indices.dedup();
        let extrema = self.range_extremes(first, last)?;
        Ok(Lod {
            indices,
            visible_points: (last - first + 1) as u32,
            y_min: self.value(extrema.min),
            y_max: self.value(extrema.max),
        })
    }

    // GPU 与 oracle 共用实际绘制坐标，只有最终物理像素坐标转换为 f32。
    pub fn pixel_position(&self, index: u32, lod: &Lod, viewport: Viewport, width: u32, height: u32) -> [f32; 2] {
        let x = unit_position(self.timestamp(index), viewport.from, viewport.to);
        let y = 1.0 - unit_position(self.value(index), lod.y_min, lod.y_max);
        [
            (0.5 + x * width.saturating_sub(1) as f64) as f32,
            (0.5 + y * height.saturating_sub(1) as f64) as f32,
        ]
    }

    pub fn hit_test(&self, timestamp: f64) -> ChartResult<Hit> {
        if !timestamp.is_finite() {
            return Err("INVALID_ARGUMENT: timestamp 必须有限".into());
        }
        let right = self.timestamps.partition_point(|&t| t < timestamp);
        let nearest = if right == 0 { 0 } else if right == self.len() { right - 1 } else {
            let left_time = self.timestamps[right - 1];
            let right_time = self.timestamps[right];
            let left_distance = timestamp - left_time;
            let right_distance = right_time - timestamp;
            // 等距选较晚时间，与旧整数 helper 的 round 约定一致。
            if left_distance < right_distance { right - 1 } else { right }
        };
        let time = self.timestamps[nearest];
        // 包括左邻居和域外 clamp，重复时间始终选择第一个原始样本。
        let index = self.timestamps.partition_point(|&t| t < time) as u32;
        Ok(Hit { index, timestamp: time, value: self.value(index) })
    }
}
