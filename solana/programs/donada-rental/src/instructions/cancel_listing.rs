use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::{constants::*, error::ErrorCode, state::Listing};

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [LISTING_SEED, listing.nft_mint.as_ref()],
        bump = listing.bump,
        has_one = owner,
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = listing,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_token_account.mint == nft_mint.key(),
        constraint = owner_token_account.owner == owner.key(),
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub nft_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
    require!(
        ctx.accounts.listing.renter.is_none(),
        ErrorCode::AlreadyRented
    );

    let nft_mint_key = ctx.accounts.listing.nft_mint;
    let bump = ctx.accounts.listing.bump;
    let seeds: &[&[u8]] = &[LISTING_SEED, nft_mint_key.as_ref(), &[bump]];
    let signer_seeds = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            signer_seeds,
        ),
        1,
    )?;

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        },
        signer_seeds,
    ))?;

    Ok(())
}
