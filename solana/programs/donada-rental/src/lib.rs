pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("8o1sEGV2TnVChXZTkMvnj5HGEhTmvMi7ih3YRvgzBumh");

#[program]
pub mod donada_rental {
    use super::*;

    pub fn initialize_listing(
        ctx: Context<InitializeListing>,
        rental_fee: u64,
        draw_date: i64,
    ) -> Result<()> {
        crate::instructions::initialize_listing::handle_initialize_listing(
            ctx, rental_fee, draw_date,
        )
    }

    pub fn rent_nft(ctx: Context<RentNft>) -> Result<()> {
        crate::instructions::rent_nft::handle_rent_nft(ctx)
    }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        crate::instructions::cancel_listing::handle_cancel_listing(ctx)
    }

    pub fn claim_back(ctx: Context<ClaimBack>) -> Result<()> {
        crate::instructions::claim_back::handle_claim_back(ctx)
    }
}
