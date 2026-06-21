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
//   2. Live Blockfrost query — all wallets holding DONADA_POLICY_ID NFTs
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

import {
  Lucid, type LucidEvolution, Blockfrost,
  Data, Constr, type UTxO,
  toText, applyDoubleCborEncoding,
  validatorToAddress, credentialToAddress,
} from '@lucid-evolution/lucid';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

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
const DONADA_POLICY_ID       = '474b3f587a9eca8fecd1c0525f61e63e5124b0ec535a3b70072ea5de';

const EMAILJS_SERVICE_ID  = process.env.REACT_APP_EMAILJS_SERVICE_ID  ?? '';
const EMAILJS_TEMPLATE_ID = process.env.REACT_APP_EMAILJS_TEMPLATE_ID ?? '';
const EMAILJS_PUBLIC_KEY  = process.env.REACT_APP_EMAILJS_PUBLIC_KEY  ?? '';

async function notifyDrawComplete(params: {
  source:    string;
  address:   string;
  assetId:   string | null;
  drawDate:  Date;
  txHash:    string;
}): Promise<void> {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) return;
  const drawAt = params.drawDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  try {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id:  EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id:     EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email:   'donada.cnft@gmail.com',
          event_type: 'Draw Complete',
          subject:    `Draw Complete — ${drawAt}`,
          details: [
            `Draw Date:  ${drawAt}`,
            `Method:     ${params.source}`,
            `Winner:     ${params.address}`,
            `Asset ID:   ${params.assetId ?? '(wallet entry — no asset)'}`,
            `Tx Hash:    ${params.txHash}`,
          ].join('\n'),
        },
      }),
    });
    if (!res.ok) console.warn(`EmailJS notification failed: ${res.status} ${await res.text()}`);
    else console.log('Draw completion email sent.');
  } catch (err) {
    console.warn('EmailJS notification error:', err);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface RentalDatum {
  nft_policy:         string;
  nft_asset_name:     string;
  nft_asset_name_hex: string;
  owner:              string;
  renter:             string | null;
  rental_fee:         bigint;
  draw_date:          bigint;
  project_wallet:     string;
}

type DrawParticipant =
  | { source: 'rental';     address: string; assetId: string; rental: { utxo: UTxO; datum: RentalDatum } }
  | { source: 'nft_holder'; address: string; assetId: string }
  | { source: 'wallet';     address: string; assetId: null };

// ── Validator / contract address ──────────────────────────────────────────────

function loadValidator(): { contractAddress: string; compiledCode: string } {
  const blueprintPath = join(__dirname, '..', 'public', 'data', 'plutus.json');
  const blueprint     = JSON.parse(readFileSync(blueprintPath, 'utf-8'));
  const validator     = blueprint.validators?.find(
    (v: { title: string }) => v.title === 'rental_validator.rental.spend'
  );
  if (!validator) throw new Error('rental spend validator not found in plutus.json');
  const compiledCode    = applyDoubleCborEncoding(validator.compiledCode as string);
  const contractAddress = validatorToAddress(NETWORK, { type: 'PlutusV3', script: compiledCode });
  return { contractAddress, compiledCode };
}

// ── Datum helpers ─────────────────────────────────────────────────────────────

function dataToAddress(data: Data): string {
  const constr        = data as Constr<Data>;
  const paymentConstr = constr.fields[0] as Constr<Data>;
  const stakeConstr   = constr.fields[1] as Constr<Data>;
  const paymentHash   = paymentConstr.fields[0] as string;
  const paymentCred   = paymentConstr.index === 0
    ? { type: 'Key' as const,    hash: paymentHash }
    : { type: 'Script' as const, hash: paymentHash };
  let stakeCred: { type: 'Key' | 'Script'; hash: string } | undefined;
  if (stakeConstr.index === 0) {
    const inner = (stakeConstr.fields[0] as Constr<Data>).fields[0] as Constr<Data>;
    stakeCred = inner.index === 0
      ? { type: 'Key' as const,    hash: inner.fields[0] as string }
      : { type: 'Script' as const, hash: inner.fields[0] as string };
  }
  return credentialToAddress(NETWORK, paymentCred, stakeCred);
}

function decodeDatum(utxo: UTxO): RentalDatum {
  if (!utxo.datum) throw new Error('UTxO has no inline datum');
  const constr       = Data.from(utxo.datum) as Constr<Data>;
  const f            = constr.fields;
  const renterConstr = f[3] as Constr<Data>;
  const assetHex     = f[1] as string;
  return {
    nft_policy:         f[0] as string,
    nft_asset_name:     toText(assetHex),
    nft_asset_name_hex: assetHex,
    owner:              dataToAddress(f[2]),
    renter:             renterConstr.index === 0 ? dataToAddress(renterConstr.fields[0]) : null,
    rental_fee:         BigInt(f[4] as bigint),
    draw_date:          BigInt(f[5] as bigint),
    project_wallet:     dataToAddress(f[6]),
  };
}

// ── Draw date helpers ─────────────────────────────────────────────────────────

const CSV_PATH         = join(__dirname, '..', 'public', 'data', 'drawDates.csv');
const WINNERS_CSV_PATH = join(__dirname, '..', 'public', 'data', 'winners.csv');

function parseChicagoTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(candidate);
    const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0');
    if (get('year') === year && get('month') === month && get('day') === day &&
        get('hour') % 24 === hour && get('minute') === minute) return candidate;
  }
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

function parseCsvRowToUtc(line: string): { date: Date; complete: boolean } | null {
  const [, dateStr, timeStr, completedRaw] = line.split(',');
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = dateStr.trim().split('-').map(Number);
  const match = timeStr.trim().match(/(\d+):(\d+)(am|pm)/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
  const complete = completedRaw?.replace(/[^a-z]/gi, '').toLowerCase() === 'y';
  return { date: parseChicagoTime(year, month, day, hour, minute), complete };
}

function loadScheduledDraw(): { date: Date; complete: boolean } | null {
  const rows = readFileSync(CSV_PATH, 'utf-8').trim().split('\n').slice(1)
    .map(parseCsvRowToUtc)
    .filter((r): r is { date: Date; complete: boolean } => r !== null);
  const incomplete = rows.filter(r => !r.complete).sort((a, b) => a.date.getTime() - b.date.getTime());
  return incomplete[0] ?? null;
}

function markDrawComplete(drawDate: Date, winnerAddress: string): void {
  const repoRoot = join(__dirname, '..');
  const drawMs   = drawDate.getTime();

  const drawLines   = readFileSync(CSV_PATH, 'utf-8').split('\n');
  const updatedDraw = drawLines.map(line => {
    const parsed = parseCsvRowToUtc(line);
    if (parsed && parsed.date.getTime() === drawMs) {
      const parts = line.split(',');
      parts[3] = '"y"';
      return parts.slice(0, 4).join(',');
    }
    return line;
  });
  writeFileSync(CSV_PATH, updatedDraw.join('\n'));
  console.log(`Marked draw ${drawDate.toISOString()} as complete in CSV.`);

  const drawRow    = updatedDraw.find(line => { const p = parseCsvRowToUtc(line); return p && p.date.getTime() === drawMs; });
  const collection = drawRow ? drawRow.split(',')[0] : 'DONADA Test';
  const [y, mo, d] = new Date(drawMs).toISOString().slice(0, 10).split('-');
  const timeStr = (() => {
    const h = new Date(drawMs).getUTCHours();
    const m = new Date(drawMs).getUTCMinutes();
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')}${period}`;
  })();
  const winnerLine     = `${collection},${y}-${mo}-${d},${timeStr},${winnerAddress}`;
  const winnersContent = readFileSync(WINNERS_CSV_PATH, 'utf-8');
  writeFileSync(WINNERS_CSV_PATH, winnersContent.trimEnd() + '\n' + winnerLine + '\n');
  console.log(`Recorded winner ${winnerAddress} in winners.csv.`);

  try {
    execSync('git config user.email "actions@github.com"', { cwd: repoRoot });
    execSync('git config user.name "GitHub Actions"',      { cwd: repoRoot });
    execSync('git add public/data/drawDates.csv public/data/winners.csv', { cwd: repoRoot });
    execSync(
      `git commit -m ${JSON.stringify(`Mark draw complete: ${drawDate.toISOString()}`)}`,
      { cwd: repoRoot },
    );
    try {
      execSync('git push', { cwd: repoRoot });
    } catch {
      execSync('git pull --rebase', { cwd: repoRoot });
      execSync('git push',          { cwd: repoRoot });
    }
    console.log('CSVs committed and pushed.');
  } catch (err) {
    throw new Error(`Failed to commit/push draw-complete CSVs: ${err}`);
  }
}

// ── Blockfrost helpers ────────────────────────────────────────────────────────

async function blockfrostGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BLOCKFROST_URL}${path}`, { headers: { project_id: BLOCKFROST_KEY } });
  if (!res.ok) throw new Error(`Blockfrost ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function waitForTxConfirmed(txHash: string, maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  console.log(`  Waiting for tx ${txHash.slice(0, 12)}… to confirm...`);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000));
    try { await blockfrostGet(`/txs/${txHash}`); console.log('  Tx confirmed.'); return; }
    catch { /* not yet indexed */ }
  }
  console.warn(`  Tx not confirmed within ${maxWaitMs / 1000}s — proceeding anyway`);
}

async function waitForUtxoIndexed(address: string, txHash: string, maxWaitMs = 180_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  console.log(`  Waiting for UTxO outputs of ${txHash.slice(0, 12)}… to be indexed...`);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000));
    try {
      const utxos = await blockfrostGet(`/addresses/${address}/utxos`) as Array<{ tx_hash: string }>;
      if (utxos.some(u => u.tx_hash === txHash)) { console.log('  UTxOs indexed.'); return; }
    } catch { /* address may have no UTxOs yet */ }
  }
  console.warn(`  UTxO index did not update within ${maxWaitMs / 1000}s — proceeding anyway`);
}

// ── Participant sources ───────────────────────────────────────────────────────

async function fetchLiveNftHolders(
  excludeAddresses: Set<string>,
): Promise<Array<{ address: string; assetId: string }>> {
  let assets: Array<{ asset: string }> = [];
  for (let page = 1; ; page++) {
    const pageData = await blockfrostGet<Array<{ asset: string }>>(
      `/assets/policy/${DONADA_POLICY_ID}?page=${page}&count=100`
    );
    assets = assets.concat(pageData);
    if (pageData.length < 100) break;
  }

  const seen = new Set<string>();
  const holders: Array<{ address: string; assetId: string }> = [];
  for (const { asset } of assets) {
    const assetId = toText(asset.slice(56));
    let addresses: Array<{ address: string }> = [];
    for (let page = 1; ; page++) {
      const pageData = await blockfrostGet<Array<{ address: string }>>(
        `/assets/${asset}/addresses?page=${page}&count=100`
      );
      addresses = addresses.concat(pageData);
      if (pageData.length < 100) break;
    }
    for (const { address } of addresses) {
      const key = `${address}:${assetId}`;
      if (!excludeAddresses.has(address) && !seen.has(key)) {
        seen.add(key);
        holders.push({ address, assetId });
      }
    }
  }
  console.log(`Fetched ${holders.length} live NFT holder(s) from Blockfrost.`);
  return holders;
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

// ── Claim-back ────────────────────────────────────────────────────────────────

const CLAIM_BACK_CHUNK_SIZE = 15;

async function claimBackRentalUtxos(
  lucid:        LucidEvolution,
  rentalUtxos:  UTxO[],
  compiledCode: string,
): Promise<void> {
  if (rentalUtxos.length === 0) { console.log('No rental UTxOs to claim back.'); return; }

  const chunks: UTxO[][] = [];
  for (let i = 0; i < rentalUtxos.length; i += CLAIM_BACK_CHUNK_SIZE) {
    chunks.push(rentalUtxos.slice(i, i + CLAIM_BACK_CHUNK_SIZE));
  }
  console.log(`\nClaiming back ${rentalUtxos.length} rental UTxO(s) across ${chunks.length} tx(s)…`);

  for (let c = 0; c < chunks.length; c++) {
    const chunk  = chunks[c];
    const datums = chunk.map(decodeDatum);
    console.log(`  Chunk ${c + 1}/${chunks.length}: ${chunk.length} UTxO(s)`);
    datums.forEach(d => console.log(`    ${d.nft_asset_name} → ${d.owner.slice(0, 24)}…`));

    const maxDrawDate = datums.reduce((max, d) => d.draw_date > max ? d.draw_date : max, datums[0].draw_date);

    let txBuilder = lucid.newTx()
      .collectFrom(chunk, Data.to(new Constr(2, [])))
      .attach.SpendingValidator({ type: 'PlutusV3', script: compiledCode })
      .addSigner(PROJECT_WALLET_ADDRESS)
      .validFrom(Number(maxDrawDate) + 1000);

    for (let i = 0; i < chunk.length; i++) {
      txBuilder = txBuilder.pay.ToAddress(datums[i].owner, chunk[i].assets);
    }

    const tx     = await txBuilder.complete();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log(`  Chunk ${c + 1} done. Tx: ${txHash}`);
    await waitForTxConfirmed(txHash);
    if (c < chunks.length - 1) await waitForUtxoIndexed(PROJECT_WALLET_ADDRESS, txHash);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SEED) throw new Error('OWNER_SEED_PHRASE is not set.');
  console.log(`Seed word count: ${SEED.split(' ').length}`);

  // Step 1 — Check draw date
  const scheduled = loadScheduledDraw();
  if (!scheduled) {
    console.warn('No pending draw dates found in drawDates.csv — nothing to execute.');
    process.exit(0);
  }

  const now = new Date();
  if (scheduled.date > now) {
    console.log(`Draw not yet due. Next draw: ${scheduled.date.toISOString()} | Now: ${now.toISOString()}`);
    process.exit(0);
  }
  console.log(`\nExecuting draw scheduled for ${scheduled.date.toISOString()}`);

  // Step 2 — Initialise Lucid
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromSeed(SEED);

  const signerAddress = await lucid.wallet().address();
  if (signerAddress !== PROJECT_WALLET_ADDRESS) {
    throw new Error(`Seed phrase resolves to ${signerAddress}, expected ${PROJECT_WALLET_ADDRESS}`);
  }

  // Step 3 — Build participant pool
  const { contractAddress, compiledCode } = loadValidator();
  console.log(`Contract address: ${contractAddress}`);

  const utxos = await lucid.utxosAt(contractAddress);
  const rentalParticipants: DrawParticipant[] = utxos.flatMap(u => {
    try {
      const datum = decodeDatum(u);
      return [{ source: 'rental' as const, address: datum.owner, assetId: datum.nft_asset_name, rental: { utxo: u, datum } }];
    } catch { return []; }
  });

  const liveHolders = await fetchLiveNftHolders(new Set([contractAddress, PROJECT_WALLET_ADDRESS]));
  const nftHolderParticipants: DrawParticipant[] = liveHolders.map(
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
  for (let s = drawSlot; s <= drawSlot + 500 && !entropyBlock; s++) {
    try { entropyBlock = await blockfrostGet<{ hash: string; slot: number }>(`/blocks/slot/${s}`); }
    catch { /* empty slot — try next */ }
  }
  if (!entropyBlock) throw new Error('Could not find a block at the draw slot.');
  console.log(`Entropy block hash: ${entropyBlock.hash}`);
  console.log(`Entropy block slot: ${entropyBlock.slot}`);

  // Step 5 — Deterministic shuffle + winner selection
  const entropyStr = `${entropyBlock.hash}:${entropyBlock.slot}:${allParticipants.length}`;
  const hashBytes  = new Uint8Array(createHash('sha256').update(entropyStr).digest());

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
  const prizeLovelace = BigInt((process.env.PRIZE_LOVELACE ?? '').replace(/[^0-9]/g, '') || '0');
  if (prizeLovelace === 0n) throw new Error('PRIZE_LOVELACE env var not set or zero.');

  const walletUtxos   = await lucid.wallet().getUtxos();
  const walletBalance = walletUtxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
  if (walletBalance < prizeLovelace) {
    throw new Error(`Insufficient balance: ${walletBalance} lovelace available, ${prizeLovelace} required.`);
  }

  const activeRenter = winner.source === 'rental' ? (winner.rental.datum.renter ?? null) : null;
  const renterShare  = activeRenter ? prizeLovelace * 90n / 100n : 0n;
  const ownerShare   = prizeLovelace - renterShare;

  if (activeRenter) {
    console.log(`Renter (90%): ${renterShare} lovelace → ${activeRenter}`);
    console.log(`Owner  (10%): ${ownerShare} lovelace → ${winner.address}`);
  } else {
    console.log(`Winner (100%): ${prizeLovelace} lovelace → ${winner.address}`);
  }

  // Step 7 — Build, sign, submit payout
  let tx = lucid.newTx().pay.ToAddress(winner.address, { lovelace: ownerShare });
  if (activeRenter) tx = tx.pay.ToAddress(activeRenter, { lovelace: renterShare });
  tx = tx.addSigner(PROJECT_WALLET_ADDRESS);

  const built  = await tx.complete();
  const signed = await built.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`\nPayout submitted. Tx hash: ${txHash}`);

  await waitForTxConfirmed(txHash);
  await waitForUtxoIndexed(PROJECT_WALLET_ADDRESS, txHash);

  markDrawComplete(scheduled.date, winner.address);
  await notifyDrawComplete({ source: winner.source, address: winner.address, assetId: winner.assetId ?? null, drawDate: scheduled.date, txHash });
  console.log('Draw complete!');

  // Step 8 — Return rental NFTs to owners
  const drawDateMs          = BigInt(scheduled.date.getTime());
  const rentalUtxosToReturn = rentalParticipants
    .filter((p): p is Extract<DrawParticipant, { source: 'rental' }> => p.source === 'rental')
    .filter(p => p.rental.datum.draw_date <= drawDateMs)
    .map(p => p.rental.utxo);
  await claimBackRentalUtxos(lucid, rentalUtxosToReturn, compiledCode);
}

main().catch(err => {
  console.error('\nDraw failed:', err);
  process.exit(1);
});
