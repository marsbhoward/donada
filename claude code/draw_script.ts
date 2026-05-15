// =============================================================================
// draw_script.ts
// =============================================================================
// Run by GitHub Actions on a schedule. Checks whether the nearest draw date
// in drawDates.csv has been reached — exits silently if not, executes the
// draw if yes. Safe to run on a cron without risk of an early draw.
//
// Environment variables (stored in GitHub Secrets):
//   NETWORK                            "Preview" or "Mainnet" (default: Preview)
//   OWNER_SEED_PHRASE                  24-word BIP39 seed phrase for the project wallet
//   REACT_APP_BlockFrost_API_KEY_Preview
//   REACT_APP_BlockFrost_API_KEY_Mainnet
//
// Participant sources (mirrors the browser draw logic):
//   1. On-chain rental UTxOs at the rental contract address
//   2. public/data/nft_holders.csv     (address,asset_id)
//   3. public/data/wallet_participants.csv  (address)
//
// Winner selection:
//   - Entropy: first block at or after the scheduled draw timestamp
//   - Shuffle: deterministic Fisher-Yates seeded from block hash (bytes 8-11)
//   - Index: SHA-256(blockHash:slot:poolSize) bytes 0-7 mod pool size
//
// Payout rules:
//   - Rental entry with active renter: 90% renter / 10% owner
//   - All other entries: 100% to winner address
// =============================================================================

import { Lucid, Blockfrost, Data, UTxO } from "lucid-cardano";
import type { ProtocolParameters } from "lucid-cardano";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Constants ─────────────────────────────────────────────────────────────────

const NETWORK  = (process.env.NETWORK ?? 'Preview') as 'Preview' | 'Mainnet';
const SEED     = (process.env.OWNER_SEED_PHRASE ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();

const BLOCKFROST_URL = NETWORK === 'Preview'
  ? 'https://cardano-preview.blockfrost.io/api/v0'
  : 'https://cardano-mainnet.blockfrost.io/api/v0';

const BLOCKFROST_KEY = NETWORK === 'Preview'
  ? (process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '')
  : (process.env.REACT_APP_BlockFrost_API_KEY_Mainnet ?? '');

const PROJECT_WALLET_ADDRESS = 'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RentalDatum {
  nft_policy:     string;
  nft_asset_name: string;
  owner:          string;
  renter:         string | null;
  rental_fee:     bigint;
  draw_date:      bigint;
  project_wallet: string;
}

type DrawParticipant =
  | { source: 'rental';     address: string; assetId: string; rental: { utxo: UTxO; datum: RentalDatum } }
  | { source: 'nft_holder'; address: string; assetId: string }
  | { source: 'wallet';     address: string; assetId: null };

// ── Conway era compatibility ───────────────────────────────────────────────────

class ConwayCompatBlockfrost extends Blockfrost {
  override async getProtocolParameters(): Promise<ProtocolParameters> {
    const params = await super.getProtocolParameters();
    const cm = params.costModels as Record<string, Record<string, number>> | undefined;
    if (!cm) return params;
    const patched = { ...cm };
    if (patched.PlutusV1) patched.PlutusV1 = Object.fromEntries(Object.entries(patched.PlutusV1).slice(0, 166));
    if (patched.PlutusV2) patched.PlutusV2 = Object.fromEntries(Object.entries(patched.PlutusV2).slice(0, 175));
    return { ...params, costModels: patched as ProtocolParameters['costModels'] };
  }
}

// ── Draw date check ───────────────────────────────────────────────────────────

interface ScheduledDraw {
  date:    Date;
  planned: boolean;
}

function loadScheduledDraw(): ScheduledDraw | null {
  const csvPath = join(__dirname, '..', 'public', 'data', 'drawDates.csv');
  const lines   = readFileSync(csvPath, 'utf-8').trim().split('\n').slice(1);
  const now     = new Date();

  const rows = lines.map(line => {
    const [, dateStr, timeStr, plannedRaw] = line.split(',');
    if (!dateStr || !timeStr) return null;
    const [year, month, day] = dateStr.trim().split('-').map(Number);
    const match = timeStr.trim().match(/(\d+):(\d+)(am|pm)/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (match[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    const planned = plannedRaw?.replace(/[^a-z]/gi, '').toLowerCase() === 'y';
    return { date: new Date(year, month - 1, day, hour, minute), planned };
  }).filter((r): r is ScheduledDraw => r !== null);

  // Return the nearest draw date to now (past or future)
  return rows.reduce<ScheduledDraw | null>((best, r) => {
    if (!best) return r;
    return Math.abs(r.date.getTime() - now.getTime()) < Math.abs(best.date.getTime() - now.getTime()) ? r : best;
  }, null);
}

// ── Validator loader ──────────────────────────────────────────────────────────

function loadContractAddress(lucid: Lucid): string {
  const blueprintPath = join(__dirname, '..', 'public', 'data', 'plutus.json');
  const blueprint     = JSON.parse(readFileSync(blueprintPath, 'utf-8'));
  const validator     = blueprint.validators?.find(
    (v: { title: string }) => v.title === 'rental_validator.rental.spend'
  );
  if (!validator) throw new Error('rental spend validator not found in plutus.json');
  return lucid.utils.credentialToAddress(lucid.utils.scriptHashToCredential(validator.hash));
}

// ── Datum helpers ─────────────────────────────────────────────────────────────

function decodeDatum(utxo: UTxO): RentalDatum {
  if (!utxo.datum) throw new Error('UTxO has no inline datum');
  return Data.from(utxo.datum) as unknown as RentalDatum;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function loadNftHolders(): Array<{ address: string; assetId: string }> {
  try {
    const path = join(__dirname, '..', 'public', 'data', 'nft_holders.csv');
    const seen = new Set<string>();
    return readFileSync(path, 'utf-8').trim().split('\n').slice(1)
      .map(l => {
        const [address, assetId] = l.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        return { address, assetId };
      })
      .filter(r => r.address && r.assetId)
      .filter(r => { const k = `${r.address}:${r.assetId}`; if (seen.has(k)) return false; seen.add(k); return true; });
  } catch { return []; }
}

function loadWalletParticipants(): string[] {
  try {
    const path = join(__dirname, '..', 'public', 'data', 'wallet_participants.csv');
    const seen = new Set<string>();
    return readFileSync(path, 'utf-8').trim().split('\n').slice(1)
      .map(l => l.trim().replace(/^"|"$/g, ''))
      .filter(l => l.length > 0)
      .filter(a => { if (seen.has(a)) return false; seen.add(a); return true; });
  } catch { return []; }
}

// ── Blockfrost fetch helper ───────────────────────────────────────────────────

async function blockfrostGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BLOCKFROST_URL}${path}`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SEED) throw new Error('OWNER_SEED_PHRASE is not set.');
  console.log(`Seed word count: ${SEED.split(' ').length}`);

  // Step 1 — Check draw date
  const scheduled = loadScheduledDraw();
  if (!scheduled) throw new Error('No draw dates found in drawDates.csv.');

  const now = new Date();
  if (scheduled.date > now) {
    console.log(`Draw not yet due. Next draw: ${scheduled.date.toISOString()} | Now: ${now.toISOString()}`);
    process.exit(0);
  }

  console.log(`\nExecuting draw scheduled for ${scheduled.date.toISOString()}`);

  // Step 2 — Initialise Lucid
  const lucid = await Lucid.new(new ConwayCompatBlockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWalletFromSeed(SEED);

  const signerAddress = await lucid.wallet.address();
  if (signerAddress !== PROJECT_WALLET_ADDRESS) {
    throw new Error(`Seed phrase resolves to ${signerAddress}, expected ${PROJECT_WALLET_ADDRESS}`);
  }

  // Step 3 — Build participant pool
  const contractAddress = loadContractAddress(lucid);
  console.log(`Contract address: ${contractAddress}`);

  const utxos = await lucid.utxosAt(contractAddress);
  const rentalParticipants: DrawParticipant[] = utxos.flatMap(u => {
    try {
      const datum = decodeDatum(u);
      return [{ source: 'rental' as const, address: datum.owner, assetId: datum.nft_asset_name, rental: { utxo: u, datum } }];
    } catch { return []; }
  });

  const nftHolderParticipants: DrawParticipant[] = loadNftHolders().map(
    r => ({ source: 'nft_holder' as const, address: r.address, assetId: r.assetId })
  );

  const walletParticipants: DrawParticipant[] = loadWalletParticipants().map(
    address => ({ source: 'wallet' as const, address, assetId: null })
  );

  const allParticipants: DrawParticipant[] = [...rentalParticipants, ...nftHolderParticipants, ...walletParticipants];

  if (allParticipants.length === 0) throw new Error('No participants found.');

  console.log(`Rental listings:  ${rentalParticipants.length}`);
  console.log(`NFT holders:      ${nftHolderParticipants.length}`);
  console.log(`Wallet entries:   ${walletParticipants.length}`);
  console.log(`Total pool:       ${allParticipants.length}`);

  // Step 4 — Entropy from block at draw timestamp
  const genesis = await blockfrostGet<{ system_start: number | string; slot_length: number }>('/genesis');
  const systemStartMs = typeof genesis.system_start === 'number'
    ? genesis.system_start * 1000
    : new Date(genesis.system_start).getTime();
  const drawSlot = Math.floor((scheduled.date.getTime() - systemStartMs) / (genesis.slot_length * 1000));
  console.log(`Draw slot: ${drawSlot}`);

  let entropyBlock: { hash: string; slot: number } | null = null;
  for (let s = drawSlot; s <= drawSlot + 200 && !entropyBlock; s++) {
    try {
      entropyBlock = await blockfrostGet<{ hash: string; slot: number }>(`/blocks/slot/${s}`);
    } catch { /* empty slot — try next */ }
  }
  if (!entropyBlock) throw new Error('Could not find a block at the draw slot.');

  console.log(`Entropy block hash: ${entropyBlock.hash}`);
  console.log(`Entropy block slot: ${entropyBlock.slot}`);

  // Step 5 — Deterministic shuffle + winner selection
  const entropyStr  = `${entropyBlock.hash}:${entropyBlock.slot}:${allParticipants.length}`;
  const hashBytes   = new Uint8Array(createHash('sha256').update(entropyStr).digest());

  let rngSeed = hashBytes.slice(8, 12).reduce((acc, b) => (acc * 256 + b) >>> 0, 0);
  const xorshift32 = () => {
    rngSeed ^= rngSeed << 13;
    rngSeed ^= rngSeed >>> 17;
    rngSeed ^= rngSeed << 5;
    rngSeed = rngSeed >>> 0;
    return rngSeed / 0x100000000;
  };

  const shuffled = [...allParticipants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(xorshift32() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const hashBigInt = hashBytes.slice(0, 8).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  const idx        = Number(hashBigInt % BigInt(shuffled.length));
  const winner     = shuffled[idx];

  console.log(`\nWinner source:  ${winner.source}`);
  console.log(`Winner address: ${winner.address}`);
  console.log(`Asset ID:       ${winner.assetId ?? '(wallet entry)'}`);

  // Step 6 — Payout
  const prizeLovelace = BigInt(process.env.PRIZE_LOVELACE ?? '0');
  if (prizeLovelace === 0n) throw new Error('PRIZE_LOVELACE env var not set or zero.');

  const activeRenter = winner.source === 'rental' ? (winner.rental.datum.renter ?? null) : null;
  const renterShare  = activeRenter ? prizeLovelace * 90n / 100n : 0n;
  const ownerShare   = prizeLovelace - renterShare;

  if (activeRenter) {
    console.log(`Renter (90%): ${renterShare} lovelace → ${activeRenter}`);
    console.log(`Owner  (10%): ${ownerShare} lovelace → ${winner.address}`);
  } else {
    console.log(`Winner (100%): ${prizeLovelace} lovelace → ${winner.address}`);
  }

  // Step 7 — Build, sign, submit
  let tx = lucid.newTx().payToAddress(winner.address, { lovelace: ownerShare });
  if (activeRenter) tx = tx.payToAddress(activeRenter, { lovelace: renterShare });
  tx = tx.addSigner(PROJECT_WALLET_ADDRESS);

  const built  = await tx.complete();
  const signed = await built.sign().complete();
  const txHash = await signed.submit();

  console.log(`\nDraw complete! Tx hash: ${txHash}`);
}

main().catch(err => {
  console.error('\nDraw failed:', err);
  process.exit(1);
});
