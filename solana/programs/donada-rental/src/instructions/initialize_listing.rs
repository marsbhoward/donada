use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{constants::*, error::ErrorCode, state::Listing};

#[derive(Accounts)]
pub struct InitializeListing<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub nft_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = owner_token_account.mint == nft_mint.key(),
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.amount == 1,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = nft_mint,
        associated_token::authority = listing,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// CHECK: stored on the listing for fee distribution, not read from in this instruction.
    pub project_wallet: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_listing(
    ctx: Context<InitializeListing>,
    rental_fee: u64,
    draw_date: i64,
) -> Result<()> {
    require!(rental_fee > 0, ErrorCode::InvalidRentalFee);
    require!(
        draw_date > Clock::get()?.unix_timestamp,
        ErrorCode::InvalidDrawDate
    );

    let listing = &mut ctx.accounts.listing;
    listing.nft_mint = ctx.accounts.nft_mint.key();
    listing.owner = ctx.accounts.owner.key();
    listing.renter = None;
    listing.rental_fee = rental_fee;
    listing.draw_date = draw_date;
    listing.project_wallet = ctx.accounts.project_wallet.key();
    listing.bump = ctx.bumps.listing;

    let cpi_accounts = Transfer {
        from: ctx.accounts.owner_token_account.to_account_info(),
        to: ctx.accounts.escrow_token_account.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token::transfer(cpi_ctx, 1)?;

    Ok(())
}
