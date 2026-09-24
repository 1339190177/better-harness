use crate::ChartResult;

pub const MAX_POINTS: usize = 10_000_000;
pub const MAX_API_POINTS: usize = 20_000;
pub const MAX_DIMENSION: u32 = 4096;
pub const MAX_AREA: u64 = 8_388_608;

pub fn integer(value: f64, min: u32, max: u32, name: &str) -> ChartResult<u32> {
    if !value.is_finite() || value.fract() != 0.0 || value < min as f64 || value > max as f64 {
        return Err(format!("INVALID_ARGUMENT: {name} 必须是 {min}..={max} 的整数"));
    }
    Ok(value as u32)
}

pub fn dimensions(width: f64, height: f64) -> ChartResult<(u32, u32)> {
    let width = integer(width, 1, MAX_DIMENSION, "width")?;
    let height = integer(height, 1, MAX_DIMENSION, "height")?;
    if u64::from(width) * u64::from(height) > MAX_AREA {
        return Err(format!("INVALID_ARGUMENT: 像素面积不能超过 {MAX_AREA}"));
    }
    Ok((width, height))
}

pub fn rgb(channels: &[f64]) -> ChartResult<[u8; 3]> {
    if channels.len() != 3 {
        return Err("INVALID_ARGUMENT: RGB 必须包含三个通道".into());
    }
    Ok([
        integer(channels[0], 0, 255, "RGB")? as u8,
        integer(channels[1], 0, 255, "RGB")? as u8,
        integer(channels[2], 0, 255, "RGB")? as u8,
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Colors {
    pub background: [u8; 3],
    pub line: [u8; 3],
}

impl Colors {
    pub fn new(background: &[f64], line: &[f64]) -> ChartResult<Self> {
        Ok(Self { background: rgb(background)?, line: rgb(line)? })
    }

    // 只用于旧测试/兼容入口；正式 host 每次从 Studio 解析语义 token 后调用 setColors。
    pub fn legacy_theme(dark: bool) -> Self {
        if dark {
            Self { background: [40, 40, 45], line: [124, 188, 236] }
        } else {
            Self { background: [255, 255, 255], line: [22, 95, 146] }
        }
    }
}

// 先在 f64 中减去原点，再转换 GPU 坐标；跨越 ±f64::MAX 时缩放避免溢出。
pub fn unit_position(value: f64, from: f64, to: f64) -> f64 {
    if from == to {
        return 0.5;
    }
    let span = to - from;
    if span.is_finite() {
        (value - from) / span
    } else {
        (value * 0.5 - from * 0.5) / (to * 0.5 - from * 0.5)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub from: f64,
    pub to: f64,
}

impl Viewport {
    // 保留隐式整数时间测试 helper 的 clamp；显式时间戳使用 unclamped。
    pub fn new(from: f64, to: f64, count: usize) -> ChartResult<Self> {
        if count == 0 {
            return Err("EMPTY_DATA: 请先加载数据".into());
        }
        Self::bounded(from, to, 0.0, (count - 1) as f64)
    }

    // 只校验请求，不收敛数据域；允许单点 padding、域外视域和零跨度。
    pub fn unclamped(from: f64, to: f64) -> ChartResult<Self> {
        if !from.is_finite() || !to.is_finite() || from > to {
            return Err("INVALID_ARGUMENT: viewport 必须有限且 from <= to".into());
        }
        Ok(Self { from, to })
    }

    pub fn bounded(from: f64, to: f64, first: f64, last: f64) -> ChartResult<Self> {
        Self::unclamped(from, to)?;
        Self::unclamped(first, last)?;
        Ok(Self { from: from.clamp(first, last), to: to.clamp(first, last) })
    }

    pub fn visible_bounds(self) -> Option<(usize, usize)> {
        let first = self.from.ceil() as usize;
        let last = self.to.floor() as usize;
        (first <= last).then_some((first, last))
    }
}
