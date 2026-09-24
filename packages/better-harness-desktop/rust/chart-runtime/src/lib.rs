pub mod chart;
pub mod dataset;
mod platform;
mod pool;
pub mod validation;

#[cfg(feature = "addon")]
mod bindings;
#[cfg(feature = "addon")]
pub use bindings::NativeChart;

pub type ChartResult<T> = Result<T, String>;
