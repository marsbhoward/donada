use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub nft_mint: Pubkey,
    pub owner: Pubkey,
    pub renter: Option<Pubkey>,
    pub rental_fee: u64,
    pub draw_date: i64,
    pub project_wallet: Pubkey,
    pub bump: u8,
}
