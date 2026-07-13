use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Listing already has a renter")]
    AlreadyRented,
    #[msg("Listing has no renter")]
    NotRented,
    #[msg("Only the listing owner can perform this action")]
    Unauthorized,
    #[msg("The draw date has already passed")]
    DrawDatePassed,
    #[msg("The draw date has not been reached yet")]
    DrawDateNotReached,
    #[msg("Rental fee must be greater than zero")]
    InvalidRentalFee,
    #[msg("Draw date must be in the future")]
    InvalidDrawDate,
}
