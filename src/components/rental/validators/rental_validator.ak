// =============================================================================
// rental_validator.ak
// =============================================================================
// On-chain Aiken validator for the Donada NFT rental contract.
//
// One instance of this validator is deployed per rental listing. Each listing
// locks a "donada" policy NFT at the contract address with a RentalDatum
// stored inline on the UTXO. The validator enforces all rental rules:
//
//   CancelListing — owner withdraws their NFT before any renter joins
//   Rent          — a renter pays the rental fee; wallet is linked to the NFT
//   ClaimBack     — NFT is returned after draw_date (owner) or by the draw
//                   contract as part of post-draw cleanup
//
// Fee split on Rent:
//   90% of rental_fee → NFT owner  (immediate, same transaction)
//   10% of rental_fee → Donada project wallet  (immediate, same transaction)
//
// Winnings split is handled entirely by the draw contract (draw_validator.ak),
// not here. This validator only concerns itself with the rental fee.
//
// Deploy:
//   aiken build
//   aiken blueprint apply  (to parameterise with the draw contract script hash)
// =============================================================================

use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}

// ── Types ─────────────────────────────────────────────────────────────────────

/// Datum stored inline on the rental contract UTXO.
pub type RentalDatum {
  /// The "donada" minting policy ID — used to verify the correct NFT is locked.
  nft_policy: ByteArray,
  /// The specific asset name of the NFT being listed (e.g. "DonodaNFT001").
  nft_asset_name: ByteArray,
  /// The original NFT owner. Receives 90% of rental_fee and signs CancelListing.
  owner: Address,
  /// Set to Some(address) when a renter successfully calls the Rent redeemer.
  /// None at listing time. First-come-first-served — once set, cannot change.
  renter: Option<Address>,
  /// Rental fee in lovelace. Must be paid in full by the renter in one tx.
  rental_fee: Int,
  /// Cardano POSIX time in milliseconds. After this time the owner or draw
  /// contract can reclaim the NFT.
  draw_date: Int,
  /// Receives 10% of rental_fee on every Rent tx (the project's cold fees/
  /// treasury wallet). Payment destination only — never used as a signer.
  fee_recipient: Address,
  /// May co-sign ClaimBack after draw_date, alongside the owner. This is the
  /// automated draw/hot wallet — signer only, never receives funds here.
  claim_authority: Address,
}

/// The three actions that can be performed on a rental contract UTXO.
pub type RentalRedeemer {
  /// Owner reclaims their NFT before any renter has joined.
  CancelListing
  /// A renter pays the full rental_fee, associating their wallet with the NFT.
  Rent { renter_address: Address }
  /// Returns the NFT after the draw.
  ClaimBack
}

// ── Parameter ─────────────────────────────────────────────────────────────────

/// Script hash of the draw validator — injected at compile time via
/// `aiken blueprint apply`. Replace with the real hash after `aiken build`.
const draw_contract_script_hash: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

// ── Helper functions ──────────────────────────────────────────────────────────

/// Returns the total lovelace paid to a given address across all tx outputs.
fn lovelace_paid_to(tx: Transaction, recipient: Address) -> Int {
  list.foldl(
    tx.outputs,
    0,
    fn(output: Output, acc: Int) -> Int {
      if output.address == recipient {
        acc + assets.lovelace_of(output.value)
      } else {
        acc
      }
    },
  )
}

/// Checks that exactly one continuing output at the rental contract address
/// carries THIS listing's NFT, and that its inline datum records the new
/// renter with all other datum fields unchanged.
///
/// Matching on the unique NFT unit (rather than "exactly one output at the
/// script address") lets multiple rentals be batched into a single tx — each
/// script input binds to its own continuing output. It also guarantees the
/// NFT itself remains locked at the contract.
fn output_datum_has_renter(
  tx: Transaction,
  script_address: Address,
  original_datum: RentalDatum,
  renter_address: Address,
) -> Bool {
  let continuing_outputs =
    list.filter(
      tx.outputs,
      fn(output: Output) -> Bool {
        output.address == script_address && assets.quantity_of(
          output.value,
          original_datum.nft_policy,
          original_datum.nft_asset_name,
        ) == 1
      },
    )

  when continuing_outputs is {
    [output] ->
      when output.datum is {
        InlineDatum(raw_datum) -> {
          expect updated_datum: RentalDatum = raw_datum
          let renter_set       = updated_datum.renter         == Some(renter_address)
          let policy_unchanged = updated_datum.nft_policy     == original_datum.nft_policy
          let asset_unchanged  = updated_datum.nft_asset_name == original_datum.nft_asset_name
          let owner_unchanged  = updated_datum.owner          == original_datum.owner
          let fee_unchanged    = updated_datum.rental_fee     == original_datum.rental_fee
          let date_unchanged   = updated_datum.draw_date      == original_datum.draw_date
          let recipient_unchanged = updated_datum.fee_recipient   == original_datum.fee_recipient
          let authority_unchanged = updated_datum.claim_authority == original_datum.claim_authority

          renter_set       &&
          policy_unchanged &&
          asset_unchanged  &&
          owner_unchanged  &&
          fee_unchanged    &&
          date_unchanged   &&
          recipient_unchanged &&
          authority_unchanged
        }
        _ -> False
      }
    _ -> False
  }
}

/// Returns True if any tx input originates from the draw contract script address.
fn draw_contract_in_inputs(tx: Transaction) -> Bool {
  list.any(
    tx.inputs,
    fn(input) -> Bool {
      when input.output.address.payment_credential is {
        Script(script_hash) ->
          script_hash == draw_contract_script_hash
        _ -> False
      }
    },
  )
}

/// Lower bound of the tx validity range; -1 if unbounded.
fn tx_lower_bound(tx: Transaction) -> Int {
  when tx.validity_range.lower_bound.bound_type is {
    Finite(t) -> t
    _ -> -1
  }
}

/// Upper bound of the tx validity range; sentinel max if unbounded.
fn tx_upper_bound(tx: Transaction) -> Int {
  when tx.validity_range.upper_bound.bound_type is {
    Finite(t) -> t
    _ -> 9_999_999_999_999
  }
}

// ── Validator ─────────────────────────────────────────────────────────────────

validator rental {
  spend(
    opt_datum: Option<RentalDatum>,
    redeemer: RentalRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    // Datum must be present — listings always carry an inline datum.
    expect Some(datum) = opt_datum

    let tx = self

    // Recover the script's own address from the spend input so we can
    // identify continuing outputs without hardcoding the contract address.
    expect Some(own_input) =
      list.find(tx.inputs, fn(input) { input.output_reference == own_ref })
    let script_address = own_input.output.address

    when redeemer is {

      // ── CancelListing ──────────────────────────────────────────────────────
      // Owner withdraws their NFT before any renter has joined.
      CancelListing -> {
        let no_renter = datum.renter == None
        let signed_by_owner =
          when datum.owner.payment_credential is {
            VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
            _ -> False
          }
        no_renter && signed_by_owner
      }

      // ── Rent ───────────────────────────────────────────────────────────────
      // Renter pays rental_fee; fee split 90% owner / 10% fee_recipient.
      // NFT stays locked with datum updated to record the renter's address.
      Rent { renter_address } -> {
        let no_existing_renter = datum.renter == None
        let before_deadline    = tx_upper_bound(tx) < datum.draw_date
        let owner_minimum      = datum.rental_fee * 90 / 100
        let project_minimum    = datum.rental_fee * 10 / 100
        let owner_receives     = lovelace_paid_to(tx, datum.owner)         >= owner_minimum
        let project_receives   = lovelace_paid_to(tx, datum.fee_recipient) >= project_minimum
        let datum_updated      =
          output_datum_has_renter(tx, script_address, datum, renter_address)

        no_existing_renter &&
        before_deadline    &&
        owner_receives     &&
        project_receives   &&
        datum_updated
      }

      // ── ClaimBack ──────────────────────────────────────────────────────────
      // Three valid scenarios:
      //   a. draw_date passed AND owner signs (independent owner reclaim)
      //   b. draw_date passed AND claim_authority signs (automated post-draw cleanup)
      //   c. draw contract is present as a tx input (future bulk-return contract)
      ClaimBack -> {
        let deadline_passed = tx_lower_bound(tx) > datum.draw_date
        let signed_by_owner =
          when datum.owner.payment_credential is {
            VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
            _ -> False
          }
        let signed_by_authority =
          when datum.claim_authority.payment_credential is {
            VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
            _ -> False
          }
        let called_by_draw_contract = draw_contract_in_inputs(tx)

        ( deadline_passed && signed_by_owner ) ||
        ( deadline_passed && signed_by_authority ) ||
        called_by_draw_contract
      }
    }
  }

  else(_ctx) {
    fail
  }
}
