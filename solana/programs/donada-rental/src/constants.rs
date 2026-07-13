use anchor_lang::prelude::*;

#[constant]
pub const LISTING_SEED: &[u8] = b"listing";

#[constant]
pub const OWNER_SHARE_BPS: u64 = 9000;

#[constant]
pub const BPS_DENOMINATOR: u64 = 10000;
