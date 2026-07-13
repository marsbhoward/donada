# Donada Multichain Plan — Solana Integration

## Overview

Extend the Donada platform to support a single NFT collection split across Cardano and Solana. Both chains feed one unified draw pool with one prize. Minting lives in `donada-mint`; rental logic and the draw live here.

---

## Phase 1 — Anchor Rental Program (`/programs/donada-rental/`)

Solana equivalent of the existing Cardano `rental_validator` (PlutusV3).

### Instructions

| Instruction | Cardano equivalent |
|---|---|
| `initialize_listing` | `submitListing()` — locks NFT in PDA escrow, stores fee + draw_date |
| `rent_nft` | `rentNft()` — collects fee atomically (90% owner / 10% project), records renter |
| `cancel_listing` | `cancelListingNft()` — returns NFT to owner (only if no renter) |
| `claim_back` | `claimBackExpiredRentals()` — admin reclaims after draw_date passes |

### Accounts / PDAs

| Account | Description |
|---|---|
| `listing` PDA | Stores: nft_mint, owner, renter (Option), rental_fee, draw_date, project_wallet |
| `escrow_token_account` | PDA-owned token account holding the locked NFT |
| `owner_token_account` | Owner's associated token account |
| `renter` | Wallet that paid the rental fee |

### Fee Flow (rent_nft)

```
Renter wallet
  └─> rental_fee (SOL)
        ├─ 90% → owner wallet
        └─> 10% → project wallet
```

---

## Phase 2 — Frontend Wallet Layer

### New packages
- `@solana/wallet-adapter-react`
- `@solana/wallet-adapter-wallets` (Phantom, Solflare, Backpack)
- `@solana/web3.js`
- `@coral-xyz/anchor`

### New file: `src/contexts/WalletContext.tsx`
Wraps both wallet connections. Either or both can be active simultaneously.

```typescript
interface MultiWalletContext {
  cardanoWallet: ConnectedWalletState | null;
  solanaWallet: SolanaWalletState | null;
  connectCardano: (walletKey: string) => Promise<void>;
  connectSolana: () => Promise<void>;
  disconnectCardano: () => void;
  disconnectSolana: () => void;
}
```

### Solana wallets supported
Phantom, Solflare, Backpack — detected from `window.solana` / wallet adapter standard.

### Multi-wallet UI
- Header shows both connected wallets (chain badge + truncated address)
- "Add Wallet" button when only one chain is connected
- Disconnect per-chain independently

---

## Phase 3 — Unified Draw

Expand `handleExecuteDraw()` in `DonadaPlatform.tsx` to merge 4 participant sources:

| Source | Chain | Method |
|---|---|---|
| Active rental UTxOs | Cardano | Blockfrost query (existing) |
| Live NFT holders | Cardano | Blockfrost policy query (existing) |
| Active rental PDAs | Solana | Anchor program account fetch (new) |
| Live NFT holders | Solana | Solana RPC `getProgramAccounts` (new) |

All 4 pools merge before the deterministic Fisher-Yates shuffle. One winner selected. Payout goes to whichever chain the winner's NFT is on.

### Cross-chain payout logic
- Winner from Cardano rental → existing ADA payout flow
- Winner from Solana rental → SOL payout via Anchor `claim_back` + transfer
- Winner is a holder (not renter) → payout direct to their wallet on the respective chain

---

## Phase 4 — Chain-Aware UI

- NFT cards: chain badge (`ADA` / `SOL`)
- Action buttons (`List`, `Rent`, `Cancel`) route to Cardano or Solana functions based on NFT origin
- `TxConfirmModal`: links to CardanoScan (Cardano) or Solscan (Solana)
- Admin panel: network toggle controls both chains (Cardano Preview/Mainnet + Solana Devnet/Mainnet-beta)

---

## Network Config

| Chain | Dev | Production |
|---|---|---|
| Cardano | Preview | Mainnet |
| Solana | Devnet | Mainnet-beta |

Single admin toggle switches both chains simultaneously.

---

## Build Order

### Prerequisites (one-time local setup)
1. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. Install Solana CLI: `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`
3. Install Anchor: `cargo install --git https://github.com/coral-xyz/anchor avm && avm install latest`

### Steps
1. `anchor init programs/donada-rental` — scaffold Anchor workspace
2. Write + test `initialize_listing` on devnet
3. Write + test `rent_nft` on devnet
4. Write + test `cancel_listing` and `claim_back` on devnet
5. Install frontend Solana packages
6. Build `WalletContext.tsx` with dual-chain support
7. Update `handleExecuteDraw()` to merge Solana participants
8. Update UI for chain badges and chain-aware routing
9. Deploy Anchor program to devnet, wire frontend
10. Audit + deploy to mainnet-beta / Cardano mainnet together

---

## Out of Scope (handled in `donada-mint`)

- Minting new Solana NFTs
- Collection initialization and metadata upload
