//! Deterministic fixed-point layout primitives.

pub mod fixed;

pub use fixed::{
    checked_add, checked_area, checked_div, checked_midpoint, checked_mul, checked_scale,
    checked_sub, quantize_pixels, Coord, FixedPointError, FIXED_UNITS_PER_PIXEL,
};
