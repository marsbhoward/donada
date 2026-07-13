use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};

use crate::{constants::*, error::ErrorCode, state::Listing};

#[derive(Accounts)]
pub struct RentNft<'info> {
    #[account(mut)]
    pub renter: Signer<'info>,

    #[account(
        mut,
        seeds = [LISTING_SEED, listing.nft_mint.as_ref()],
        bump = listing.bump,
        has_one = owner,
        has_one = project_wallet,
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: validated via has_one on listing
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

    /// CHECK: validated via has_one on listing
    #[account(mut)]
    pub project_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_rent_nft(ctx: Context<RentNft>) -> Result<()> {
    require!(
        ctx.accounts.listing.renter.is_none(),
        ErrorCode::AlreadyRented
    );
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.listing.draw_date,
        ErrorCode::DrawDatePassed
    );

    let rental_fee = ctx.accounts.listing.rental_fee;
    let owner_share = rental_fee
        .checked_mul(OWNER_SHARE_BPS)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .unwrap();
    let project_share = rental_fee.checked_sub(owner_share).unwrap();

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            SystemTransfer {
                from: ctx.accounts.renter.to_account_info(),
                to: ctx.accounts.owner.to_account_info(),
            },
        ),
        owner_share,
    )?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            SystemTransfer {
                from: ctx.accounts.renter.to_account_info(),
                to: ctx.accounts.project_wallet.to_account_info(),
            },
        ),
        project_share,
    )?;

    ctx.accounts.listing.renter = Some(ctx.accounts.renter.key());

    Ok(())
}
