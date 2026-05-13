# Donada

Donada is a Cardano-based business entity built around a community prize draw ecosystem. This repository contains the **rental contract platform** — one component of the broader Donada ecosystem — which enables NFT holders to list their assets for rent and participate in scheduled prize draws.

---

## Overview

The rental contract structure allows Donada NFT holders to generate yield on their assets by listing them for rent, while renters gain eligibility for prize draws. Non-NFT holders can also participate through the registered wallet programme, making the draw accessible across the full Donada community.

**Participant sources for each draw:**
- NFT owners with an active rental listing (on-chain, via the rental smart contract)
- NFT owners holding their asset without listing (registered via `nft_holders.csv`)
- Community wallet participants without an NFT (registered via `wallet_participants.csv`)

**Payout rules:**
- Rental listing wins with an active renter — 90% to the renter, 10% to the NFT owner
- Any other winning entry — 100% to the winner's address

---

## Setup

### Prerequisites
- Node.js 20+
- A Blockfrost API key for Preview and/or Mainnet ([blockfrost.io](https://blockfrost.io))
- A Cardano browser wallet (Nami, Eternl, etc.) for the owner interface

### Environment variables

Create a `.env` file in the project root:

```
REACT_APP_BlockFrost_API_KEY_Preview=previewXXXXXXXXXXXXXXXX
REACT_APP_BlockFrost_API_KEY_Mainnet=mainnetXXXXXXXXXXXXXXXX
OWNER_SEED_PHRASE="word1 word2 ... word24"
```

### Install and run

```bash
npm install
npm start
```

---

## Draw Configuration

Draw dates are managed via CSV files in `public/data/`. No redeployment is required — update the files and commit.

### `public/data/drawDates.csv`

Defines scheduled draw dates. The `p` column marks whether the draw is pre-planned (`y`) or can be armed early (`n`).

```
Label,date,time,p
next_draw_date,2026-08-01,06:00AM,"y"
```

Times are interpreted in the client's local timezone.

### `public/data/nft_holders.csv`

NFT owners participating without an active rental listing. One row per NFT — the same address can appear multiple times if they hold multiple NFTs.

```
address,asset_id
addr1q...,DonodaNFT001
addr1q...,DonodaNFT002
```

### `public/data/wallet_participants.csv`

Community wallets participating without an NFT. One address per row.

```
address
addr1q...
```

---

## Automated Draw (GitHub Actions)

The draw executes automatically at the scheduled time via GitHub Actions — no manual login required.

### GitHub Secrets required

| Secret | Value |
|---|---|
| `OWNER_SEED_PHRASE` | 24-word seed phrase for the Donada project wallet |
| `BLOCKFROST_API_KEY_PREVIEW` | Blockfrost Preview API key |
| `BLOCKFROST_API_KEY_MAINNET` | Blockfrost Mainnet API key |
| `PRIZE_LOVELACE` | Prize amount in lovelace (e.g. `1000000000` = 1000 ADA) |

The workflow (`.github/workflows/execute_draw.yml`) runs every 15 minutes, checks whether the draw date in `drawDates.csv` has been reached, and exits silently if not. When the draw time arrives it executes automatically.

Winner selection uses the hash of the first block produced at or after the scheduled draw timestamp as its entropy source — fixed to the draw time and independently verifiable by any participant.

---

## Network

The admin panel (visible only when the Donada project wallet is connected) includes a network toggle between **Preview** (testnet) and **Mainnet**. Mainnet is the default.

---

## Project Structure

```
public/data/
  drawDates.csv           — scheduled draw dates
  nft_holders.csv         — NFT holder participants
  wallet_participants.csv — wallet-only participants
  plutus.json             — compiled rental validator (Aiken)

src/containers/
  NewHome2.tsx            — main application interface

claude code/
  draw_script.ts          — server-side draw execution (used by GitHub Actions)
  mint_test_nft.ts        — testnet NFT minting utility

src/components/rental/
  validators/             — Aiken smart contract source
```
