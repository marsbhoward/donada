use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    donada_rental::{accounts, instruction as ix_data, state::Listing, LISTING_SEED},
    litesvm::LiteSVM,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_program_pack::Pack,
    solana_signer::Signer,
    solana_transaction::Transaction,
    spl_associated_token_account_interface::{
        address::get_associated_token_address,
        instruction::create_associated_token_account,
        program::ID as ATA_PROGRAM_ID,
    },
    spl_token_interface::{instruction as token_ix, state::Mint as SplMint, ID as TOKEN_PROGRAM_ID},
};

const PROGRAM_ID: fn() -> Pubkey = donada_rental::id;
const RENTAL_FEE: u64 = 1_000_000_000; // 1 SOL
const TEN_SOL: u64 = 10_000_000_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

fn make_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let so = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/donada_rental.so"
    ))
    .expect("donada_rental.so not found — run `anchor build` first");
    svm.add_program(PROGRAM_ID(), &so).unwrap();
    svm
}

fn create_nft_mint(svm: &mut LiteSVM, payer: &Keypair) -> Keypair {
    let mint_kp = Keypair::new();
    let mint_pk = mint_kp.pubkey();
    let rent = svm.minimum_balance_for_rent_exemption(SplMint::LEN);

    let create_acc_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint_pk,
        rent,
        SplMint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init_mint_ix =
        token_ix::initialize_mint2(&TOKEN_PROGRAM_ID, &mint_pk, &payer.pubkey(), None, 0).unwrap();

    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[create_acc_ix, init_mint_ix],
        Some(&payer.pubkey()),
        &[payer, &mint_kp],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
    mint_kp
}

fn fund_owner_with_nft(svm: &mut LiteSVM, owner: &Keypair, mint_pk: &Pubkey, payer: &Keypair) {
    let owner_ata = get_associated_token_address(&owner.pubkey(), mint_pk);
    let create_ata_ix = create_associated_token_account(
        &payer.pubkey(),
        &owner.pubkey(),
        mint_pk,
        &TOKEN_PROGRAM_ID,
    );
    let mint_to_ix = token_ix::mint_to(
        &TOKEN_PROGRAM_ID,
        mint_pk,
        &owner_ata,
        &payer.pubkey(),
        &[],
        1,
    )
    .unwrap();

    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[create_ata_ix, mint_to_ix],
        Some(&payer.pubkey()),
        &[payer],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
}

fn initialize_listing(
    svm: &mut LiteSVM,
    owner: &Keypair,
    mint_pk: &Pubkey,
    project_wallet: &Pubkey,
    rental_fee: u64,
    draw_date: i64,
) {
    let program_id = PROGRAM_ID();
    let (listing_pda, _bump) =
        Pubkey::find_program_address(&[LISTING_SEED, mint_pk.as_ref()], &program_id);
    let owner_ata = get_associated_token_address(&owner.pubkey(), mint_pk);
    let escrow_ata = get_associated_token_address(&listing_pda, mint_pk);

    let accounts = accounts::InitializeListing {
        owner: owner.pubkey(),
        nft_mint: *mint_pk,
        owner_token_account: owner_ata,
        listing: listing_pda,
        escrow_token_account: escrow_ata,
        project_wallet: *project_wallet,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);

    let data = ix_data::InitializeListing {
        rental_fee,
        draw_date,
    }
    .data();

    let ix = Instruction {
        program_id,
        accounts,
        data,
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&owner.pubkey()),
        &[owner],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
}

fn listing_pda(mint_pk: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LISTING_SEED, mint_pk.as_ref()], &PROGRAM_ID()).0
}

fn decode_listing(svm: &LiteSVM, mint_pk: &Pubkey) -> Listing {
    let pda = listing_pda(mint_pk);
    let acc = svm.get_account(&pda).expect("listing account not found");
    Listing::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let acc = svm.get_account(ata);
    match acc {
        None => 0,
        Some(a) => {
            spl_token_interface::state::Account::unpack(&a.data)
                .map(|t| t.amount)
                .unwrap_or(0)
        }
    }
}

// ─── tests ────────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_listing_happy_path() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);

    let draw_date = 9_999_999_999i64;
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        draw_date,
    );

    let listing = decode_listing(&svm, &mint_kp.pubkey());
    assert_eq!(listing.nft_mint, mint_kp.pubkey());
    assert_eq!(listing.owner, owner.pubkey());
    assert!(listing.renter.is_none());
    assert_eq!(listing.rental_fee, RENTAL_FEE);
    assert_eq!(listing.draw_date, draw_date);
    assert_eq!(listing.project_wallet, project.pubkey());

    // NFT should now be in escrow, not owner's ATA
    let pda = listing_pda(&mint_kp.pubkey());
    let escrow_ata = get_associated_token_address(&pda, &mint_kp.pubkey());
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());
    assert_eq!(token_balance(&svm, &escrow_ata), 1);
    assert_eq!(token_balance(&svm, &owner_ata), 0);
}

#[test]
fn test_initialize_invalid_rental_fee() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);

    let program_id = PROGRAM_ID();
    let (listing_pda, _) =
        Pubkey::find_program_address(&[LISTING_SEED, mint_kp.pubkey().as_ref()], &program_id);
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());
    let escrow_ata = get_associated_token_address(&listing_pda, &mint_kp.pubkey());

    let accounts = accounts::InitializeListing {
        owner: owner.pubkey(),
        nft_mint: mint_kp.pubkey(),
        owner_token_account: owner_ata,
        listing: listing_pda,
        escrow_token_account: escrow_ata,
        project_wallet: project.pubkey(),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);

    let ix = Instruction {
        program_id,
        accounts,
        data: ix_data::InitializeListing {
            rental_fee: 0, // invalid
            draw_date: 9_999_999_999,
        }
        .data(),
    };

    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&owner.pubkey()),
        &[&owner],
        blockhash,
    );
    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "should fail with zero rental fee");
}

#[test]
fn test_initialize_invalid_draw_date() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);

    let program_id = PROGRAM_ID();
    let (listing_pda, _) =
        Pubkey::find_program_address(&[LISTING_SEED, mint_kp.pubkey().as_ref()], &program_id);
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());
    let escrow_ata = get_associated_token_address(&listing_pda, &mint_kp.pubkey());

    let accounts = accounts::InitializeListing {
        owner: owner.pubkey(),
        nft_mint: mint_kp.pubkey(),
        owner_token_account: owner_ata,
        listing: listing_pda,
        escrow_token_account: escrow_ata,
        project_wallet: project.pubkey(),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);

    let ix = Instruction {
        program_id,
        accounts,
        data: ix_data::InitializeListing {
            rental_fee: RENTAL_FEE,
            draw_date: 0, // past date
        }
        .data(),
    };

    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&owner.pubkey()),
        &[&owner],
        blockhash,
    );
    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "should fail with past draw date");
}

#[test]
fn test_rent_nft_happy_path() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let renter = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&renter.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        9_999_999_999,
    );

    let owner_bal_before = svm.get_balance(&owner.pubkey()).unwrap_or(0);
    let project_bal_before = svm.get_balance(&project.pubkey()).unwrap_or(0);

    let pda = listing_pda(&mint_kp.pubkey());
    let accounts = accounts::RentNft {
        renter: renter.pubkey(),
        listing: pda,
        owner: owner.pubkey(),
        project_wallet: project.pubkey(),
        system_program: system_program::ID,
    }
    .to_account_metas(None);

    let ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts,
        data: ix_data::RentNft {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&renter.pubkey()),
        &[&renter],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();

    // 90/10 split
    let owner_share = RENTAL_FEE * 9000 / 10000;
    let project_share = RENTAL_FEE - owner_share;
    assert_eq!(
        svm.get_balance(&owner.pubkey()).unwrap(),
        owner_bal_before + owner_share
    );
    assert_eq!(
        svm.get_balance(&project.pubkey()).unwrap(),
        project_bal_before + project_share
    );

    let listing = decode_listing(&svm, &mint_kp.pubkey());
    assert_eq!(listing.renter, Some(renter.pubkey()));
}

#[test]
fn test_rent_nft_already_rented() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let renter = Keypair::new();
    let renter2 = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&renter.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&renter2.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        9_999_999_999,
    );

    // first rent succeeds
    let pda = listing_pda(&mint_kp.pubkey());
    let rent_ix = |renter_kp: &Keypair| Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::RentNft {
            renter: renter_kp.pubkey(),
            listing: pda,
            owner: owner.pubkey(),
            project_wallet: project.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix_data::RentNft {}.data(),
    };

    let blockhash = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[rent_ix(&renter)],
        Some(&renter.pubkey()),
        &[&renter],
        blockhash,
    ))
    .unwrap();

    // second rent must fail
    let blockhash = svm.latest_blockhash();
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[rent_ix(&renter2)],
        Some(&renter2.pubkey()),
        &[&renter2],
        blockhash,
    ));
    assert!(result.is_err(), "double-rent should fail");
}

#[test]
fn test_rent_nft_draw_date_passed() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let renter = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&renter.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);

    let near_future = 1_000i64;
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        near_future,
    );

    // warp clock past draw_date
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = near_future + 1;
    svm.set_sysvar::<Clock>(&clock);

    let pda = listing_pda(&mint_kp.pubkey());
    let ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::RentNft {
            renter: renter.pubkey(),
            listing: pda,
            owner: owner.pubkey(),
            project_wallet: project.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix_data::RentNft {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[ix],
        Some(&renter.pubkey()),
        &[&renter],
        blockhash,
    ));
    assert!(result.is_err(), "rent after draw_date should fail");
}

#[test]
fn test_cancel_listing_happy_path() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        9_999_999_999,
    );

    let pda = listing_pda(&mint_kp.pubkey());
    let escrow_ata = get_associated_token_address(&pda, &mint_kp.pubkey());
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());

    let ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::CancelListing {
            owner: owner.pubkey(),
            listing: pda,
            escrow_token_account: escrow_ata,
            owner_token_account: owner_ata,
            nft_mint: mint_kp.pubkey(),
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: ix_data::CancelListing {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[ix],
        Some(&owner.pubkey()),
        &[&owner],
        blockhash,
    ))
    .unwrap();

    // NFT back in owner's ATA, listing and escrow closed
    assert_eq!(token_balance(&svm, &owner_ata), 1);
    assert_eq!(token_balance(&svm, &escrow_ata), 0);
    assert!(svm.get_account(&pda).is_none(), "listing PDA should be closed");
}

#[test]
fn test_cancel_listing_fails_when_rented() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let renter = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&renter.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        9_999_999_999,
    );

    // rent it first
    let pda = listing_pda(&mint_kp.pubkey());
    let rent_ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::RentNft {
            renter: renter.pubkey(),
            listing: pda,
            owner: owner.pubkey(),
            project_wallet: project.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix_data::RentNft {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[rent_ix],
        Some(&renter.pubkey()),
        &[&renter],
        blockhash,
    ))
    .unwrap();

    // now cancel should fail
    let escrow_ata = get_associated_token_address(&pda, &mint_kp.pubkey());
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());
    let cancel_ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::CancelListing {
            owner: owner.pubkey(),
            listing: pda,
            escrow_token_account: escrow_ata,
            owner_token_account: owner_ata,
            nft_mint: mint_kp.pubkey(),
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: ix_data::CancelListing {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[cancel_ix],
        Some(&owner.pubkey()),
        &[&owner],
        blockhash,
    ));
    assert!(result.is_err(), "cancel with active renter should fail");
}

#[test]
fn test_claim_back_happy_path() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let caller = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&caller.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);

    let draw_date = 1_000i64;
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        draw_date,
    );

    // warp past draw_date
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = draw_date + 1;
    svm.set_sysvar::<Clock>(&clock);

    let pda = listing_pda(&mint_kp.pubkey());
    let escrow_ata = get_associated_token_address(&pda, &mint_kp.pubkey());
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());

    let ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::ClaimBack {
            caller: caller.pubkey(),
            listing: pda,
            owner: owner.pubkey(),
            escrow_token_account: escrow_ata,
            owner_token_account: owner_ata,
            nft_mint: mint_kp.pubkey(),
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: ix_data::ClaimBack {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[ix],
        Some(&caller.pubkey()),
        &[&caller],
        blockhash,
    ))
    .unwrap();

    assert_eq!(token_balance(&svm, &owner_ata), 1);
    assert_eq!(token_balance(&svm, &escrow_ata), 0);
    assert!(svm.get_account(&pda).is_none(), "listing PDA should be closed");
}

#[test]
fn test_claim_back_too_early() {
    let mut svm = make_svm();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let caller = Keypair::new();
    let project = Keypair::new();
    svm.airdrop(&payer.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&owner.pubkey(), TEN_SOL).unwrap();
    svm.airdrop(&caller.pubkey(), TEN_SOL).unwrap();

    let mint_kp = create_nft_mint(&mut svm, &payer);
    fund_owner_with_nft(&mut svm, &owner, &mint_kp.pubkey(), &payer);
    initialize_listing(
        &mut svm,
        &owner,
        &mint_kp.pubkey(),
        &project.pubkey(),
        RENTAL_FEE,
        9_999_999_999,
    );

    let pda = listing_pda(&mint_kp.pubkey());
    let escrow_ata = get_associated_token_address(&pda, &mint_kp.pubkey());
    let owner_ata = get_associated_token_address(&owner.pubkey(), &mint_kp.pubkey());

    let ix = Instruction {
        program_id: PROGRAM_ID(),
        accounts: accounts::ClaimBack {
            caller: caller.pubkey(),
            listing: pda,
            owner: owner.pubkey(),
            escrow_token_account: escrow_ata,
            owner_token_account: owner_ata,
            nft_mint: mint_kp.pubkey(),
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: ix_data::ClaimBack {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[ix],
        Some(&caller.pubkey()),
        &[&caller],
        blockhash,
    ));
    assert!(result.is_err(), "claim_back before draw_date should fail");
}
