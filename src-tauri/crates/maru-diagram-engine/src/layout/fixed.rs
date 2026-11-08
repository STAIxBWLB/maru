//! Fixed-point arithmetic at 1/64-pixel resolution.
//!
//! Floating-point values enter through `quantize_pixels`; geometry operations
//! after that boundary use integer arithmetic with checked `i64` intermediates.

use std::fmt;

pub type Coord = i32;
pub const FIXED_UNITS_PER_PIXEL: i64 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedPointError {
    NonFiniteInput,
    CoordinateOutOfRange,
    ArithmeticOverflow,
    DivisionByZero,
    NegativeDimension,
}

impl fmt::Display for FixedPointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.cause())
    }
}

impl std::error::Error for FixedPointError {}

impl FixedPointError {
    pub const fn cause(self) -> &'static str {
        match self {
            Self::NonFiniteInput => "coordinate input is not finite",
            Self::CoordinateOutOfRange => "coordinate does not fit the fixed-point range",
            Self::ArithmeticOverflow => "fixed-point arithmetic overflowed",
            Self::DivisionByZero => "fixed-point division by zero",
            Self::NegativeDimension => "geometry dimensions cannot be negative",
        }
    }

    pub const fn fix(self) -> &'static str {
        match self {
            Self::NonFiniteInput => "use a finite pixel coordinate",
            Self::CoordinateOutOfRange => {
                "keep the coordinate inside the supported fixed-point range"
            }
            Self::ArithmeticOverflow => "reduce the coordinate magnitude or split the operation",
            Self::DivisionByZero => "use a nonzero divisor",
            Self::NegativeDimension => "use nonnegative geometry dimensions",
        }
    }
}

/// Quantize pixels to 1/64-pixel units, rounding exact halves away from zero.
pub fn quantize_pixels(pixels: f64) -> Result<Coord, FixedPointError> {
    if !pixels.is_finite() {
        return Err(FixedPointError::NonFiniteInput);
    }
    let scaled = pixels * FIXED_UNITS_PER_PIXEL as f64;
    if !scaled.is_finite() {
        return Err(FixedPointError::CoordinateOutOfRange);
    }
    let rounded = if scaled >= 0.0 {
        (scaled + 0.5).floor()
    } else {
        (scaled - 0.5).ceil()
    };
    if rounded < Coord::MIN as f64 || rounded > Coord::MAX as f64 {
        return Err(FixedPointError::CoordinateOutOfRange);
    }
    let intermediate = rounded as i64;
    Coord::try_from(intermediate).map_err(|_| FixedPointError::CoordinateOutOfRange)
}

fn checked_coord(value: i64) -> Result<Coord, FixedPointError> {
    Coord::try_from(value).map_err(|_| FixedPointError::ArithmeticOverflow)
}

fn round_div_half_away_from_zero(numerator: i64, denominator: i64) -> Result<i64, FixedPointError> {
    if denominator == 0 {
        return Err(FixedPointError::DivisionByZero);
    }
    let quotient = numerator
        .checked_div(denominator)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    let remainder = numerator
        .checked_rem(denominator)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    let remainder_abs = remainder.unsigned_abs();
    let denominator_abs = denominator.unsigned_abs();
    let half_threshold = denominator_abs / 2 + denominator_abs % 2;
    if remainder_abs < half_threshold {
        return Ok(quotient);
    }
    let away_from_zero = if (numerator < 0) ^ (denominator < 0) {
        -1
    } else {
        1
    };
    quotient
        .checked_add(away_from_zero)
        .ok_or(FixedPointError::ArithmeticOverflow)
}

pub fn checked_add(left: Coord, right: Coord) -> Result<Coord, FixedPointError> {
    let value = (left as i64)
        .checked_add(right as i64)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    checked_coord(value)
}

pub fn checked_sub(left: Coord, right: Coord) -> Result<Coord, FixedPointError> {
    let value = (left as i64)
        .checked_sub(right as i64)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    checked_coord(value)
}

/// Multiply two fixed-point values and return a fixed-point result.
pub fn checked_mul(left: Coord, right: Coord) -> Result<Coord, FixedPointError> {
    let product = (left as i64)
        .checked_mul(right as i64)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    checked_coord(round_div_half_away_from_zero(
        product,
        FIXED_UNITS_PER_PIXEL,
    )?)
}

/// Divide two fixed-point values and return a fixed-point result.
pub fn checked_div(numerator: Coord, denominator: Coord) -> Result<Coord, FixedPointError> {
    if denominator == 0 {
        return Err(FixedPointError::DivisionByZero);
    }
    let scaled = (numerator as i64)
        .checked_mul(FIXED_UNITS_PER_PIXEL)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    checked_coord(round_div_half_away_from_zero(scaled, denominator as i64)?)
}

/// Scale a fixed-point value by a rational factor using deterministic rounding.
pub fn checked_scale(
    value: Coord,
    numerator: i64,
    denominator: i64,
) -> Result<Coord, FixedPointError> {
    let product = (value as i64)
        .checked_mul(numerator)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    checked_coord(round_div_half_away_from_zero(product, denominator)?)
}

pub fn checked_midpoint(left: Coord, right: Coord) -> Result<Coord, FixedPointError> {
    let sum = (left as i64)
        .checked_add(right as i64)
        .ok_or(FixedPointError::ArithmeticOverflow)?;
    checked_coord(round_div_half_away_from_zero(sum, 2)?)
}

pub fn checked_area(width: Coord, height: Coord) -> Result<i64, FixedPointError> {
    if width < 0 || height < 0 {
        return Err(FixedPointError::NegativeDimension);
    }
    (width as i64)
        .checked_mul(height as i64)
        .ok_or(FixedPointError::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantization_rounds_half_away_from_zero() {
        assert_eq!(quantize_pixels(0.5 / 64.0), Ok(1));
        assert_eq!(quantize_pixels(-0.5 / 64.0), Ok(-1));
        assert_eq!(quantize_pixels(1.49 / 64.0), Ok(1));
        assert_eq!(quantize_pixels(-1.49 / 64.0), Ok(-1));
    }

    #[test]
    fn quantization_rejects_nonfinite_and_out_of_range_inputs() {
        assert_eq!(
            quantize_pixels(f64::NAN),
            Err(FixedPointError::NonFiniteInput)
        );
        assert_eq!(
            quantize_pixels(f64::INFINITY),
            Err(FixedPointError::NonFiniteInput)
        );
        assert_eq!(
            quantize_pixels(f64::MAX),
            Err(FixedPointError::CoordinateOutOfRange)
        );
        assert_eq!(
            quantize_pixels((Coord::MAX as f64 + 2.0) / FIXED_UNITS_PER_PIXEL as f64),
            Err(FixedPointError::CoordinateOutOfRange)
        );
        let error = quantize_pixels(f64::MAX).unwrap_err();
        assert!(!error.cause().is_empty());
        assert!(!error.fix().is_empty());
    }

    #[test]
    fn arithmetic_uses_checked_intermediates_and_reports_overflow() {
        assert_eq!(
            checked_add(Coord::MAX, 1),
            Err(FixedPointError::ArithmeticOverflow)
        );
        assert_eq!(
            checked_sub(Coord::MIN, 1),
            Err(FixedPointError::ArithmeticOverflow)
        );
        assert_eq!(
            checked_mul(Coord::MAX, Coord::MAX),
            Err(FixedPointError::ArithmeticOverflow)
        );
        assert_eq!(
            checked_scale(Coord::MAX, i64::MAX, 1),
            Err(FixedPointError::ArithmeticOverflow)
        );
        assert_eq!(checked_div(1, 0), Err(FixedPointError::DivisionByZero));
        assert_eq!(checked_scale(1, 1, 0), Err(FixedPointError::DivisionByZero));
    }

    #[test]
    fn rational_scaling_and_midpoints_round_ties_away_from_zero() {
        assert_eq!(checked_scale(1, 1, 2), Ok(1));
        assert_eq!(checked_scale(-1, 1, 2), Ok(-1));
        assert_eq!(checked_midpoint(0, 1), Ok(1));
        assert_eq!(checked_midpoint(0, -1), Ok(-1));
    }

    #[test]
    fn area_requires_nonnegative_dimensions() {
        assert_eq!(checked_area(3, 4), Ok(12));
        assert_eq!(checked_area(-1, 4), Err(FixedPointError::NegativeDimension));
    }
}
