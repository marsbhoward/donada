/// <reference types="node" />
import React, { useState, useEffect, useRef } from 'react';
import RentModal from '../components/RentModal';
import TxConfirmModal from '../components/TxConfirmModal';
import { fetchNftMetadata, ipfsToHttp, ipfsImgFallback, preloadImages } from '../utils/nftMetadata';
import { notifyListingCreated, notifyRentalConfirmed } from '../utils/notifications';
import {
  Lucid, type LucidEvolution, Blockfrost,
  fromText, toText, Data, Constr, type UTxO,
  applyDoubleCborEncoding,
  validatorToAddress, getAddressDetails, credentialToAddress,
  makeWalletFromAPI, type WalletApi,
} from '@lucid-evolution/lucid';

// ── Contract constants ────────────────────────────────────────────────────────

// Legacy policy ID (DonodaNFT001–003): 21b36156acd6aaea44bf6b7c9ed3cbb818e74794a6081b32a267358a
const DONADA_POLICY_ID   = '474b3f587a9eca8fecd1c0525f61e63e5124b0ec535a3b70072ea5de';

const COLLECTION_FALLBACK = 'DONADA';
const PARTNER_POLICY_ID  = ''; // fill in partner policy ID when available
const POLICY_IDS         = [DONADA_POLICY_ID, PARTNER_POLICY_ID].filter(Boolean) as string[];
const PROJECT_WALLET: Record<string, string> = {
  Mainnet: 'addr1qxe9axlq4re87nmdzxz3ya8kl768gje8le3qkm285vqgu742dr25m5q8guvug3f5az3aprznessarfr0xpdlvxqpmcjqdrky5q',
  Preview: 'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388',
};

// Addresses that can view the admin panel (project wallet + read-only admin)
const ADMIN_ADDRESSES = new Set([
  PROJECT_WALLET.Mainnet,
  PROJECT_WALLET.Preview,
  'addr1q9xr3h98vqz25ekzh038ukk957x54ajn48yzzwlkaqsxypkk922y3ntnfnk2p7qe8ds9648ja9hadnyp0g5tfem3xe0qqy8qkx',
  'addr1q8nt3e6qwx56e2t7qqv5va396dcdut0s3ytzty8ae040g746ha2ue745hcqxzy9qcrfa08u4yl67p9y7wm9nn7g3e06sjy8q0s',
]);

// ── Validator loader — derives contract address from compiled plutus.json ─────

interface ValidatorSetup {
  contractAddress: string;
  compiledCode: string; // raw single-CBOR hex for witness set injection
}

let _validatorCache: ValidatorSetup | null = null;

async function loadRentalValidator(network: Network): Promise<ValidatorSetup> {
  if (_validatorCache) return _validatorCache;

  const resp = await fetch('/data/plutus.json');
  if (!resp.ok) throw new Error('Could not load /data/plutus.json — run `aiken build` first.');
  const blueprint = await resp.json();

  const spendValidator = blueprint.validators?.find(
    (v: { title: string }) => v.title === 'rental_validator.rental.spend'
  );
  if (!spendValidator) throw new Error('rental spend validator not found in plutus.json');

  const compiledCode = applyDoubleCborEncoding(spendValidator.compiledCode);
  const contractAddress = validatorToAddress(network, { type: 'PlutusV3', script: compiledCode });

  _validatorCache = {
    contractAddress,
    compiledCode,
  };
  return _validatorCache;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WalletInfo {
  key: string;
  name: string;
  icon: string | null;
}

interface ConnectedWalletState {
  name: string;
  api: unknown; // enabled CIP-30 API passed to lucid.selectWallet.fromAPI()
  address: string;
}

interface NftAsset {
  policyId: string;
  assetName: string;
  name?: string;
  image?: string;
  rentalFee?: bigint; // lovelace — set on listed NFTs fetched from the contract
  walletKey?: string; // which connected wallet.name owns this NFT
}

interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

interface RentalDatum {
  nft_policy: string;
  nft_asset_name: string;
  owner: string;
  renter: string | null; // null = no renter registered yet
  rental_fee: bigint;
  draw_date: bigint;
  project_wallet: string;
}

interface InteractionResult {
  success: true;
  txHash: string;
  message: string;
}

// ── Lucid initialisation helper ───────────────────────────────────────────────

type Network = 'Mainnet' | 'Preview';

// Module-level network tracker — set by initLucid, used by standalone address helpers.
let _currentNetwork: Network = 'Preview';

function blockfrostConfig(network: Network): { url: string; apiKey: string } {
  return network === 'Preview'
    ? { url: 'https://cardano-preview.blockfrost.io/api/v0', apiKey: process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '' }
    : { url: 'https://cardano-mainnet.blockfrost.io/api/v0', apiKey: process.env.REACT_APP_BlockFrost_API_KEY_Mainnet ?? '' };
}

let _lucidCacheNetwork: Network | null = null;
let _lucidCachePromise: Promise<LucidEvolution> | null = null;

async function initLucid(network: Network): Promise<LucidEvolution> {
  if (_lucidCacheNetwork === network && _lucidCachePromise) return _lucidCachePromise;
  _lucidCacheNetwork = network;
  _currentNetwork = network;
  const { url, apiKey } = blockfrostConfig(network);
  _lucidCachePromise = Lucid(new Blockfrost(url, apiKey), network);
  return _lucidCachePromise;
}

// ── Datum helpers (shared by listing and rental flows) ────────────────────────

// Converts a bech32 address to the Plutus Constr representation that Aiken
// expects for the Address type: Constr(0, [PaymentCredential, Option<StakeCredential>])
function addressToData(address: string): Constr<Data> {
  const { paymentCredential, stakeCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error(`No payment credential in address: ${address}`);

  const paymentData = paymentCredential.type === 'Key'
    ? new Constr(0, [paymentCredential.hash])
    : new Constr(1, [paymentCredential.hash]);

  const stakeData = stakeCredential
    ? new Constr(0, [new Constr(0, [
        stakeCredential.type === 'Key'
          ? new Constr(0, [stakeCredential.hash])
          : new Constr(1, [stakeCredential.hash])
      ])])
    : new Constr(1, []);

  return new Constr(0, [paymentData, stakeData]);
}

// Converts a decoded Plutus Address Constr back to a bech32 address string.
function dataToAddress(data: Data): string {
  const constr = data as Constr<Data>;
  const paymentConstr = constr.fields[0] as Constr<Data>;
  const stakeConstr   = constr.fields[1] as Constr<Data>;

  const paymentHash = paymentConstr.fields[0] as string;
  const paymentCred = paymentConstr.index === 0
    ? { type: 'Key' as const,    hash: paymentHash }
    : { type: 'Script' as const, hash: paymentHash };

  let stakeCred: { type: 'Key' | 'Script'; hash: string } | undefined;
  if (stakeConstr.index === 0) {
    const inner = (stakeConstr.fields[0] as Constr<Data>).fields[0] as Constr<Data>;
    stakeCred = inner.index === 0
      ? { type: 'Key' as const,    hash: inner.fields[0] as string }
      : { type: 'Script' as const, hash: inner.fields[0] as string };
  }

  return credentialToAddress(_currentNetwork, paymentCred, stakeCred);
}

function encodeDatum(datum: RentalDatum): string {
  return Data.to(
    new Constr(0, [
      datum.nft_policy,
      fromText(datum.nft_asset_name),
      addressToData(datum.owner),
      datum.renter !== null
        ? new Constr(0, [addressToData(datum.renter)])
        : new Constr(1, []),
      datum.rental_fee,
      datum.draw_date,
      addressToData(datum.project_wallet),
    ])
  );
}

function decodeDatum(utxo: UTxO): RentalDatum {
  if (!utxo.datum) throw new Error(`UTxO ${utxo.txHash}#${utxo.outputIndex} has no inline datum.`);
  const constr = Data.from(utxo.datum) as Constr<Data>;
  const f = constr.fields;

  const renterConstr = f[3] as Constr<Data>;
  const renter = renterConstr.index === 0 ? dataToAddress(renterConstr.fields[0]) : null;

  return {
    nft_policy:     f[0] as string,
    nft_asset_name: toText(f[1] as string),
    owner:          dataToAddress(f[2]),
    renter,
    rental_fee:     f[4] as bigint,
    draw_date:      f[5] as bigint,
    project_wallet: dataToAddress(f[6]),
  };
}

// ── Listing helpers (owner lists their NFT) ───────────────────────────────────

function adaToLovelace(ada: string | number): bigint {
  const adaFloat = typeof ada === 'number' ? ada : parseFloat(ada);
  if (isNaN(adaFloat) || adaFloat <= 0) {
    throw new Error(`Invalid rental_fee_ada "${ada}". Must be a positive number.`);
  }
  return BigInt(Math.round(adaFloat * 1_000_000));
}

// Lists one or more NFTs in a single transaction. Listing outputs don't
// execute the validator, so the batch size is bounded only by tx size —
// all NFTs must come from the same signing wallet.
async function submitListing(
  nft_asset_names: string[],
  owner_address: string,
  rental_fee_ada: string | number,
  drawDateMs: number,
  contractAddress: string,
  lucid: LucidEvolution,
  network: Network
): Promise<string> {
  let txBuilder = lucid.newTx();

  for (const nft_asset_name of nft_asset_names) {
    const datum: RentalDatum = {
      nft_policy:     DONADA_POLICY_ID,
      nft_asset_name,
      owner:          owner_address,
      renter:         null,
      rental_fee:     adaToLovelace(rental_fee_ada),
      draw_date:      BigInt(drawDateMs),
      project_wallet: PROJECT_WALLET[network],
    };
    txBuilder = txBuilder.pay.ToContract(
      contractAddress,
      { kind: 'inline', value: encodeDatum(datum) },
      {
        lovelace: BigInt(2000000),
        [DONADA_POLICY_ID + fromText(nft_asset_name)]: BigInt(1),
      }
    );
  }

  const tx = await txBuilder.addSigner(owner_address).complete();
  const signed = await tx.sign.withWallet().complete();
  return signed.submit();
}

// ── Rental interaction helpers (renter pays fee, owner cancels) ───────────────

async function fetchRentalUtxo(nftAssetName: string, contractAddress: string, lucid: LucidEvolution): Promise<UTxO> {
  const unit = DONADA_POLICY_ID + fromText(nftAssetName);
  const utxos = await lucid.utxosAtWithUnit(contractAddress, unit);

  if (utxos.length === 0) {
    throw new Error(`No active listing found for "${nftAssetName}".`);
  }
  return utxos[0];
}

function buildRentRedeemer(renterAddress: string): string {
  // RentalRedeemer::Rent is index 1 in the Aiken enum: Constr(1, [renter_address])
  return Data.to(new Constr(1, [addressToData(renterAddress)]));
}


async function rentNft(
  nftAssetName: string,
  renterAddress: string,
  validator: ValidatorSetup,
  lucid: LucidEvolution
): Promise<InteractionResult> {
  const { contractAddress, compiledCode } = validator;
  const rentalUtxo = await fetchRentalUtxo(nftAssetName, contractAddress, lucid);
  const datum = decodeDatum(rentalUtxo);

  if (datum.renter !== null) {
    throw new Error(`"${nftAssetName}" already has a registered renter.`);
  }
  if (datum.draw_date <= BigInt(Date.now())) {
    throw new Error(`"${nftAssetName}" draw date has passed — this listing can no longer be rented.`);
  }

  // 90% to owner, 10% to project; integer division matches the on-chain validator.
  const ownerShare   = datum.rental_fee * BigInt(90) / BigInt(100);
  const projectShare = datum.rental_fee - ownerShare;
  const updatedDatum: RentalDatum = { ...datum, renter: renterAddress };

  // validTo must be strictly before draw_date (validator: tx_upper_bound < draw_date).
  // Cap at 5 minutes or 60 seconds before the draw, whichever is sooner.
  const fiveMin = Date.now() + 5 * 60 * 1000;
  const drawMs  = Number(datum.draw_date);
  const validTo = Math.min(fiveMin, drawMs - 60_000);

  const tx = await lucid.newTx()
    .collectFrom([rentalUtxo], buildRentRedeemer(renterAddress))
    .attach.SpendingValidator({ type: 'PlutusV3', script: compiledCode })
    .pay.ToContract(
      contractAddress,
      { kind: 'inline', value: encodeDatum(updatedDatum) },
      {
        lovelace: rentalUtxo.assets.lovelace,
        [DONADA_POLICY_ID + fromText(nftAssetName)]: BigInt(1),
      }
    )
    .pay.ToAddress(datum.owner,          { lovelace: ownerShare })
    .pay.ToAddress(datum.project_wallet, { lovelace: projectShare })
    .addSigner(renterAddress)
    .validTo(validTo)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    success: true,
    txHash,
    message: `Successfully rented "${nftAssetName}". Your wallet is registered for the draw.`,
  };
}

// Rents several NFTs in one transaction. Each consumed listing runs the
// validator once, so the batch is capped well below the tx execution budget
// (the claim-back path proved 15 inputs fit; renting is heavier, hence 10).
const BATCH_RENT_CAP = 10;

async function rentNftsBatch(
  nftAssetNames: string[],
  renterAddress: string,
  validator: ValidatorSetup,
  lucid: LucidEvolution
): Promise<InteractionResult> {
  const { contractAddress, compiledCode } = validator;
  if (nftAssetNames.length === 0) throw new Error('No NFTs selected to rent.');
  if (nftAssetNames.length > BATCH_RENT_CAP) {
    throw new Error(`Batch rentals are limited to ${BATCH_RENT_CAP} NFTs per transaction.`);
  }

  const wantedUnits = new Map(nftAssetNames.map(n => [DONADA_POLICY_ID + fromText(n), n]));
  const contractUtxos = await lucid.utxosAt(contractAddress);
  const rentals: Array<{ utxo: UTxO; datum: RentalDatum; unit: string }> = [];
  for (const u of contractUtxos) {
    const unit = Object.keys(u.assets).find(k => wantedUnits.has(k));
    if (!unit) continue;
    const datum = decodeDatum(u);
    if (datum.renter !== null) throw new Error(`"${datum.nft_asset_name}" was just rented by someone else — lower your budget or retry.`);
    if (datum.draw_date <= BigInt(Date.now())) throw new Error(`"${datum.nft_asset_name}" can no longer be rented — the draw date has passed.`);
    rentals.push({ utxo: u, datum, unit });
  }
  if (rentals.length !== nftAssetNames.length) {
    throw new Error('Some selected listings are no longer available — please retry.');
  }

  // Aggregate fee payouts per address: the validator sums all outputs to an
  // address, so one combined output per owner (and one for the project
  // wallet) satisfies every input while keeping the tx small.
  const payouts = new Map<string, bigint>();
  const addPayout = (addr: string, amt: bigint) => payouts.set(addr, (payouts.get(addr) ?? 0n) + amt);
  for (const { datum } of rentals) {
    const ownerShare = datum.rental_fee * 90n / 100n;
    addPayout(datum.owner, ownerShare);
    addPayout(datum.project_wallet, datum.rental_fee - ownerShare);
  }

  // validTo must precede the EARLIEST draw date in the batch.
  const minDrawMs = rentals.reduce((min, r) => r.datum.draw_date < min ? r.datum.draw_date : min, rentals[0].datum.draw_date);
  const validTo = Math.min(Date.now() + 5 * 60 * 1000, Number(minDrawMs) - 60_000);

  let txBuilder = lucid.newTx()
    .collectFrom(rentals.map(r => r.utxo), buildRentRedeemer(renterAddress))
    .attach.SpendingValidator({ type: 'PlutusV3', script: compiledCode });

  for (const { utxo, datum, unit } of rentals) {
    txBuilder = txBuilder.pay.ToContract(
      contractAddress,
      { kind: 'inline', value: encodeDatum({ ...datum, renter: renterAddress }) },
      { lovelace: utxo.assets.lovelace, [unit]: 1n }
    );
  }
  for (const [addr, amt] of payouts) {
    txBuilder = txBuilder.pay.ToAddress(addr, { lovelace: amt });
  }

  const tx = await txBuilder.addSigner(renterAddress).validTo(validTo).complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    success: true,
    txHash,
    message: `Successfully rented ${rentals.length} NFTs. Your wallet is registered for the draw.`,
  };
}

// Polls Blockfrost until a submitted tx appears on-chain (max ~5 min).
async function waitForTxOnChain(
  txHash: string,
  blockfrostBase: string,
  blockfrostKey: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress(`Waiting for ${txHash.slice(0, 12)}… to confirm on-chain…`);
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise<void>(r => setTimeout(r, 5000));
    const res = await fetch(`${blockfrostBase}/txs/${txHash}`, {
      headers: { project_id: blockfrostKey },
    });
    if (res.ok) { onProgress('Confirmed.'); return; }
  }
  throw new Error(`Tx ${txHash} not confirmed after 5 minutes.`);
}

const CLAIM_BACK_CHUNK_SIZE = 15;

async function claimBackExpiredRentals(
  projectWalletAddress: string,
  validator: ValidatorSetup,
  lucid: LucidEvolution,
  onProgress: (msg: string) => void,
): Promise<string[]> {
  const { contractAddress, compiledCode } = validator;
  const utxos = await lucid.utxosAt(contractAddress);
  const now = BigInt(Date.now());

  const expired = utxos.filter(u => {
    try { return decodeDatum(u).draw_date <= now; }
    catch { return false; }
  });

  if (expired.length === 0) throw new Error('No expired rental UTxOs found at the contract address.');

  const chunks: typeof expired[] = [];
  for (let i = 0; i < expired.length; i += CLAIM_BACK_CHUNK_SIZE) {
    chunks.push(expired.slice(i, i + CLAIM_BACK_CHUNK_SIZE));
  }

  onProgress(`Found ${expired.length} expired rental UTxO(s) — submitting ${chunks.length} tx(s)…`);

  const txHashes: string[] = [];

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (chunks.length > 1) onProgress(`Tx ${c + 1}/${chunks.length}: returning ${chunk.length} NFT(s)…`);

    const datums = chunk.map(u => decodeDatum(u));
    datums.forEach(d => onProgress(`  Returning ${d.nft_asset_name}…`));

    const maxDrawDate = datums.reduce((max, d) => d.draw_date > max ? d.draw_date : max, datums[0].draw_date);

    let txBuilder = lucid.newTx()
      .collectFrom(chunk, Data.to(new Constr(2, [])))
      .attach.SpendingValidator({ type: 'PlutusV3', script: compiledCode })
      .addSigner(projectWalletAddress)
      .validFrom(Number(maxDrawDate) + 1000)
      .validTo(Date.now() + 2 * 60 * 60 * 1000);

    for (let i = 0; i < chunk.length; i++) {
      txBuilder = txBuilder.pay.ToAddress(datums[i].owner, chunk[i].assets);
    }

    const tx = await txBuilder.complete();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    txHashes.push(txHash);
    onProgress(`Tx ${c + 1}/${chunks.length} done: ${txHash.slice(0, 12)}…`);
    // Wait for confirmation before next chunk so the change output is spendable.
    if (c < chunks.length - 1) await lucid.awaitTx(txHash);
  }

  return txHashes;
}

// Queries Blockfrost for all wallets holding any NFT under DONADA_POLICY_ID,
// excluding the contract address (those are already counted as rental UTxOs).
async function fetchLiveNftHolders(
  blockfrostBase: string,
  blockfrostKey: string,
  excludeAddresses: Set<string>,
): Promise<Array<{ address: string; assetId: string }>> {
  const bf = async <T,>(path: string): Promise<T> => {
    const res = await fetch(`${blockfrostBase}${path}`, { headers: { project_id: blockfrostKey } });
    if (!res.ok) throw new Error(`Blockfrost ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  };

  // Collect all assets under the policy (paginated, 100/page)
  const assets: Array<{ asset: string }> = [];
  for (let page = 1; ; page++) {
    const page_data = await bf<Array<{ asset: string }>>(`/assets/policy/${DONADA_POLICY_ID}?page=${page}&count=100`);
    assets.push(...page_data);
    if (page_data.length < 100) break;
  }

  // One addresses-lookup per asset — run through a small worker pool instead
  // of serially (Blockfrost sustains 10 req/s; 5 workers stays well under).
  const perAsset: Array<Array<{ address: string; assetId: string }>> = new Array(assets.length);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < assets.length) {
      const i = nextIdx++;
      const { asset } = assets[i];
      const assetId = toText(asset.slice(56));
      const addresses: Array<{ address: string }> = [];
      for (let page = 1; ; page++) {
        const page_data = await bf<Array<{ address: string }>>(`/assets/${asset}/addresses?page=${page}&count=100`);
        addresses.push(...page_data);
        if (page_data.length < 100) break;
      }
      perAsset[i] = addresses
        .filter(({ address }) => !excludeAddresses.has(address))
        .map(({ address }) => ({ address, assetId }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, assets.length) }, worker));
  return perAsset.flat();
}

async function cancelListingNft(
  nftAssetName: string,
  ownerAddress: string,
  validator: ValidatorSetup,
  lucid: LucidEvolution
): Promise<InteractionResult> {
  const { contractAddress, compiledCode } = validator;
  const listingUtxo = await fetchRentalUtxo(nftAssetName, contractAddress, lucid);

  const datum = decodeDatum(listingUtxo);
  if (datum.renter !== null) {
    throw new Error(`Cannot cancel "${nftAssetName}" — a renter is already registered.`);
  }

  const tx = await lucid.newTx()
    .collectFrom([listingUtxo], Data.to(new Constr(0, [])))
    .attach.SpendingValidator({ type: 'PlutusV3', script: compiledCode })
    .addSigner(ownerAddress)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    success: true,
    txHash,
    message: `Listing for "${nftAssetName}" cancelled. Your NFT will return to your wallet.`,
  };
}

function selectWallet(lucid: LucidEvolution, cip30Api: unknown): void {
  lucid.selectWallet.fromAPI(cip30Api as WalletApi);
}

// Serialises operations that select a wallet on the shared Lucid instance.
// Background prefetch and the entries effect both run selectWallet + query
// concurrently; without a lock one effect's selection can hijack another's
// in-flight query and attribute UTxOs to the wrong wallet.
let _walletOpChain: Promise<unknown> = Promise.resolve();
function withWalletLock<T>(op: () => Promise<T>): Promise<T> {
  const run = _walletOpChain.then(op, op);
  _walletOpChain = run.then((): void => undefined, (): void => undefined);
  return run;
}

// Stable identity for an NFT list — used to skip state updates (and the modal
// resets they trigger) when a background revalidation returns identical data.
const nftListKey = (list: NftAsset[]) =>
  list.map(n => `${n.policyId}:${n.assetName}:${n.rentalFee ?? ''}:${n.walletKey ?? ''}`).sort().join('|');

// Extracts a readable message from any thrown value, including CIP-30 APIError
// objects ({ code: number, info: string }) that aren't Error instances.
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.info === 'string' && e.info) return e.info;
    if (typeof e.message === 'string' && e.message) return e.message;
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(err);
}

// ── Wallet detection ──────────────────────────────────────────────────────────

// Brand colours for common Cardano wallets — used as border/glow on hover.
const WALLET_BRAND_COLORS: Record<string, string> = {
  eternl:     '#1d2d50',
  lace:       '#7b4dff',
  nami:       '#349ea3',
  yoroi:      '#1a44b7',
  flint:      '#ea580c',
  typhon:     '#5b4ee9',
  vespr:      '#3b82f6',
  gerowallet: '#10b981',
  nufi:       '#4f46e5',
  begin:      '#06b6d4',
};

// Cardano addresses start with addr1 (mainnet) or addr_test1 (testnet).
// Solana addresses are base58-encoded 32-byte public keys (~44 chars, no prefix).
const isCardanoAddress = (addr: string) => /^addr(_test)?1/.test(addr);
const isSolanaAddress  = (addr: string) => !isCardanoAddress(addr) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);

const WALLET_DOWNLOADS: { key: string; name: string; url: string }[] = [
  { key: 'eternl',     name: 'Eternl',     url: 'https://eternl.io' },
  { key: 'lace',       name: 'Lace',       url: 'https://www.lace.io' },
  { key: 'vespr',      name: 'Vespr',      url: 'https://vespr.xyz' },
  { key: 'nami',       name: 'Nami',       url: 'https://namiwallet.io' },
  { key: 'flint',      name: 'Flint',      url: 'https://flint-wallet.com' },
  { key: 'typhon',     name: 'Typhon',     url: 'https://typhonwallet.io' },
  { key: 'yoroi',      name: 'Yoroi',      url: 'https://yoroi-wallet.com' },
  { key: 'gerowallet', name: 'GeroWallet', url: 'https://gerowallet.io' },
  { key: 'nufi',       name: 'NuFi',       url: 'https://nu.fi' },
  { key: 'begin',      name: 'Begin',      url: 'https://begin.is' },
];

function getAvailableWallets(): WalletInfo[] {
  if (!window.cardano) return [];
  return Object.entries(window.cardano as Record<string, { enable?: unknown; name?: string; icon?: string }>)
    .filter(([, w]) => w && typeof w.enable === 'function')
    .map(([key, w]) => ({ key, name: w.name || key, icon: w.icon || null }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DonadaPlatform() {
  // Network (toggled in admin panel; defaults to Mainnet for production)
  const [network, setNetwork] = useState<Network>('Preview');

  // Draw date / countdown
  const [nextDrawDate, setNextDrawDate] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [drawPlanned, setDrawPlanned] = useState(false);
  // Canonical draw timestamp — retained after countdown expires so entropy is tied to draw time.
  const [scheduledDrawDate, setScheduledDrawDate] = useState<Date | null>(null);
  const [lastWinnerAddress, setLastWinnerAddress] = useState<string | null>(null);
  const [lastWinnerDrawDate, setLastWinnerDrawDate] = useState<Date | null>(null);
  const lastWinnerDrawDateRef = useRef<Date | null>(null);
  const [drawDatesLoaded, setDrawDatesLoaded] = useState(false);

  // Cardano wallet
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [connectedWallets, setConnectedWallets] = useState<ConnectedWalletState[]>([]);
  const connectedWalletsRef = useRef<ConnectedWalletState[]>([]);

  // Modal
  const [showRentModal, setShowRentModal] = useState(false);
  const [rentMode, setRentMode] = useState(false); // true = renter flow, false = owner listing flow
  const [showConnectPrompt, setShowConnectPrompt] = useState(false);
  const [promptWallets, setPromptWallets] = useState<WalletInfo[]>([]);

  // Owner listing flow
  const [ownedNfts, setOwnedNfts] = useState<NftAsset[]>([]);
  const [ownedNftsReady, setOwnedNftsReady] = useState(false); // background prefetch landed
  const [loadingOwnedNfts, setLoadingOwnedNfts] = useState(false);
  const [isListing, setIsListing] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);

  // Renter flow
  const [listedNfts, setListedNfts] = useState<NftAsset[]>([]);
  const [listedNftsReady, setListedNftsReady] = useState(false); // background prefetch landed
  const [loadingListedNfts, setLoadingListedNfts] = useState(false);
  const [isRenting, setIsRenting] = useState(false);
  const [rentError, setRentError] = useState<string | null>(null);

  // Cancel listing flow
  const [cancelNfts, setCancelNfts] = useState<NftAsset[]>([]);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [loadingCancelListings, setLoadingCancelListings] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Whether the connected wallet owns any un-rented listings (controls section visibility)
  const [hasActiveListings, setHasActiveListings] = useState(false);

  // Admin draw flow (only shown when project wallet is connected)
  const [drawPrizeAda, setDrawPrizeAda] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);

  // Tx confirmation modal + on-chain confirmed toast
  const [txConfirm, setTxConfirm] = useState<{ title: string; txHash: string } | null>(null);
  const [txConfirmedToast, setTxConfirmedToast] = useState<{ txHash: string } | null>(null);
  const [showNoWalletModal, setShowNoWalletModal] = useState(false);
  const [drawLog, setDrawLog] = useState<string[]>([]);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);

  // Admin claim-back flow
  const [isClaimingBack, setIsClaimingBack] = useState(false);
  const [claimBackLog, setClaimBackLog] = useState<string[]>([]);
  const [claimBackError, setClaimBackError] = useState<string | null>(null);

  // Admin holder sync
  const [isSyncingHolders, setIsSyncingHolders] = useState(false);
  const [holderPreview, setHolderPreview] = useState<string | null>(null);
  const [holderSyncError, setHolderSyncError] = useState<string | null>(null);

  // On-chain NFT stats (total supply + open rental listings)
  const [nftStats, setNftStats] = useState<{ total: number; openRentals: number; activeRentals: number; expiredRentals: number } | null>(null);
  // Featured image + collection name — first NFT under the policy, loaded from on-chain metadata
  const [featuredNftImage, setFeaturedNftImage] = useState<string | null>(null);
  const [collectionName, setCollectionName] = useState<string>(COLLECTION_FALLBACK);

  // Theme
  const [isDarkMode, setIsDarkMode] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [isDimming, setIsDimming] = useState(false);
  const [logoDropdownOpen, setLogoDropdownOpen] = useState(false);
  const logoDropdownRef = useRef<HTMLDivElement>(null);
  const [walletDropdownOpen, setWalletDropdownOpen] = useState(false);
  const [walletDropdownScreen, setWalletDropdownScreen] = useState<'main' | 'add-cardano' | 'disconnect-pick'>('main');
  const [walletPickerNotice, setWalletPickerNotice] = useState<string | null>(null);
  const walletDropdownRef = useRef<HTMLDivElement>(null);

  // Connected wallet's total raffle entries across all sources
  const [userEntries, setUserEntries] = useState<{
    listed: number; renting: number; participated: number; holding: number; total: number;
    freeEntrySnapshotTaken: boolean;
  } | null>(null);
  const [entriesExpanded, setEntriesExpanded] = useState(false);

  // Invalidate caches whenever the network changes so addresses are re-derived
  useEffect(() => { _validatorCache = null; _lucidCachePromise = null; _lucidCacheNetwork = null; }, [network]);

  // Auto-close the connect prompt once a wallet successfully connects
  useEffect(() => {
    if (connectedWallets.length > 0 && showConnectPrompt) {
      setShowConnectPrompt(false);
      setPromptWallets([]);
    }
  }, [connectedWallets, showConnectPrompt]);

  // ----- Fetch on-chain NFT stats -----
  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const { url: bfBase, apiKey: bfKey } = blockfrostConfig(network);

        // Policy scan (mint count + featured image) and contract scan are
        // independent Blockfrost queries — run them concurrently.
        const policyScan = (async () => {
          let total = 0;
          let firstAsset: string | null = null;
          for (let page = 1; ; page++) {
            const res = await fetch(
              `${bfBase}/assets/policy/${DONADA_POLICY_ID}?page=${page}&count=100`,
              { headers: { project_id: bfKey } },
            );
            if (!res.ok) break;
            const data: Array<{ asset: string }> = await res.json();
            if (page === 1 && data.length > 0) firstAsset = data[0].asset;
            total += data.length;
            if (data.length < 100) break;
          }

          // Featured image: first asset's on-chain CIP-25 metadata
          if (firstAsset && !cancelled) {
            const assetRes = await fetch(`${bfBase}/assets/${firstAsset}`, {
              headers: { project_id: bfKey },
            });
            if (assetRes.ok) {
              const assetData = await assetRes.json();
              const onchainMeta = assetData.onchain_metadata ?? {};
              const rawImage = onchainMeta.image;
              if (rawImage && !cancelled) {
                setFeaturedNftImage(ipfsToHttp(rawImage, 900));
              }
              if (onchainMeta.Collection && !cancelled) {
                setCollectionName(String(onchainMeta.Collection));
              }
            }
          }
          return total;
        })();

        const contractScan = (async () => {
          const lucid = await initLucid(network);
          const { contractAddress } = await loadRentalValidator(network);
          const utxos = await lucid.utxosAt(contractAddress);
          const now = BigInt(Date.now());
          let openRentals = 0, activeRentals = 0, expiredRentals = 0;
          for (const u of utxos) {
            try {
              const d = decodeDatum(u);
              if (d.draw_date <= now) { expiredRentals++; continue; }
              if (d.renter === null) openRentals++; else activeRentals++;
            } catch { /* skip malformed UTxOs */ }
          }
          return { openRentals, activeRentals, expiredRentals };
        })();

        const [total, rentals] = await Promise.all([policyScan, contractScan]);
        if (!cancelled) setNftStats({ total, ...rentals });
      } catch (err) {
        console.error('Failed to fetch NFT stats:', err);
      }
    };
    fetchStats();
    return () => { cancelled = true; };
  }, [network]);

  // ----- Compute all connected wallets' total raffle entries -----
  // Also derives hasActiveListings from the same contract query — previously a
  // separate effect issued a second identical utxosAt on every wallet change.
  useEffect(() => {
    if (connectedWallets.length === 0) { setUserEntries(null); setHasActiveListings(false); return; }
    let cancelled = false;

    const fetchEntries = async () => {
      try {
        const lucid = await initLucid(network);
        const { contractAddress } = await loadRentalValidator(network);
        const allAddresses = connectedWallets.map(w => w.address);
        const payHashes = new Set(
          connectedWallets
            .map(w => getAddressDetails(w.address).paymentCredential?.hash)
            .filter((h): h is string => !!h)
        );

        const [utxosResult, wpResult, holdingResult] = await Promise.allSettled([
          lucid.utxosAt(contractAddress),
          fetch('/data/socials_participants.csv').then(r => r.text()),
          (async (): Promise<number> => {
            // Sequential + locked: initLucid returns a single shared instance,
            // so a concurrent selectWallet (here or in the NFT prefetch) would
            // race and count the wrong wallet's UTxOs.
            let total = 0;
            for (const w of connectedWalletsRef.current) {
              total += await withWalletLock(async () => {
                const walletLucid = await initLucid(network);
                selectWallet(walletLucid, w.api);
                const utxos = await walletLucid.wallet().getUtxos();
                return utxos.reduce((n, u) =>
                  n + Object.keys(u.assets).filter(unit => unit.startsWith(DONADA_POLICY_ID)).length
                , 0);
              });
            }
            return total;
          })(),
        ]);

        let listed = 0, renting = 0, hasCancellable = false;
        if (utxosResult.status === 'fulfilled') {
          for (const u of utxosResult.value) {
            try {
              const d = decodeDatum(u);
              if (allAddresses.includes(d.owner)) listed++;
              if (d.renter && allAddresses.includes(d.renter)) renting++;
              if (d.renter === null) {
                const ownerPayHash = getAddressDetails(d.owner).paymentCredential?.hash;
                if (ownerPayHash != null && payHashes.has(ownerPayHash)) hasCancellable = true;
              }
            } catch { /* skip malformed */ }
          }
        }
        if (!cancelled) setHasActiveListings(hasCancellable);

        let participated = 0, freeEntrySnapshotTaken = false;
        if (wpResult.status === 'fulfilled') {
          const wpRows = wpResult.value.trim().split('\n').slice(1).filter(l => l.trim());
          freeEntrySnapshotTaken = wpRows.length > 0;
          participated = wpRows.filter(line => allAddresses.includes(line.replace(/"/g, '').trim())).length;
        }

        const holding = holdingResult.status === 'fulfilled' ? holdingResult.value : 0;

        if (!cancelled) setUserEntries({ listed, renting, participated, holding, total: listed + renting + participated + holding, freeEntrySnapshotTaken });
      } catch (err) {
        console.error('fetchEntries failed:', err);
        if (!cancelled) setUserEntries({ listed: 0, renting: 0, participated: 0, holding: 0, total: 0, freeEntrySnapshotTaken: false });
      }
    };

    fetchEntries();
    return () => { cancelled = true; };
  }, [connectedWallets, network]);

  // ----- Load next draw date and latest winner from CSVs -----
  useEffect(() => {
    // CSV times are authored in Central Time. Uses Intl to resolve the correct
    // UTC offset for the specific date, handling CDT (UTC-5) and CST (UTC-6) automatically.
    const parseChicagoTime = (y: number, mo: number, d: number, h: number, mi: number): Date => {
      for (const offset of [5, 6]) {
        const candidate = new Date(Date.UTC(y, mo - 1, d, h + offset, mi));
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago',
          year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: 'numeric', hour12: false,
        }).formatToParts(candidate);
        const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0');
        if (get('year') === y && get('month') === mo && get('day') === d &&
            get('hour') % 24 === h && get('minute') === mi) return candidate;
      }
      return new Date(Date.UTC(y, mo - 1, d, h + 5, mi)); // CDT fallback
    };
    const parseTimeStr = (dateStr: string, timeStr: string): Date | null => {
      const [year, month, day] = dateStr.trim().split('-').map(Number);
      const match = timeStr.trim().match(/(\d+):(\d+)(am|pm)/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      if (match[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
      if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
      return parseChicagoTime(year, month, day, hour, minute);
    };

    const load = async () => {
      const bust = `_=${Date.now()}`;
      try {
        const [drawRes, winRes] = await Promise.all([
          fetch(`/data/drawDates.csv?${bust}`),
          fetch(`/data/winners.csv?${bust}`),
        ]);
        const now = new Date();

        // ── drawDates.csv ──
        const drawLines = (await drawRes.text()).trim().split('\n').slice(1);
        const incomplete = drawLines
          .map(line => {
            const [, dateStr, timeStr, completedRaw] = line.split(',');
            if (!dateStr || !timeStr) return null;
            const date = parseTimeStr(dateStr, timeStr);
            if (!date) return null;
            const complete = completedRaw?.replace(/[^a-z]/gi, '').toLowerCase() === 'y';
            return { date, complete };
          })
          .filter((r): r is { date: Date; complete: boolean } => r !== null && !r.complete)
          .sort((a, b) => a.date.getTime() - b.date.getTime());

        if (incomplete.length > 0) {
          setScheduledDrawDate(incomplete[0].date);
          setDrawPlanned(true);
        }

        const nextIncomplete = incomplete.find(r => r.date > now);
        if (nextIncomplete) {
          setNextDrawDate(nextIncomplete.date);
          // Only clear winner if the new draw is on the same calendar day as the last draw.
          const wdd = lastWinnerDrawDateRef.current;
          const sameDay = !wdd || nextIncomplete.date.toLocaleDateString() === wdd.toLocaleDateString();
          if (sameDay) {
            setLastWinnerAddress(null);
            setLastWinnerDrawDate(null);
            lastWinnerDrawDateRef.current = null;
          }
        }

        // ── winners.csv ──
        const winLines = (await winRes.text()).trim().split('\n').slice(1).filter(Boolean);
        if (winLines.length > 0 && !nextIncomplete) {
          const lastWin = winLines[winLines.length - 1].split(',');
          const addr = lastWin[3]?.trim();
          const date = parseTimeStr(lastWin[1]?.trim() ?? '', lastWin[2]?.trim() ?? '');
          if (addr) setLastWinnerAddress(addr);
          if (date) { setLastWinnerDrawDate(date); lastWinnerDrawDateRef.current = date; }
        }
        setDrawDatesLoaded(true);
      } catch (err) {
        console.error('Failed to load draw dates', err);
        setDrawDatesLoaded(true);
      }
    };
    load();
    const poll = setInterval(load, 60_000);
    return () => clearInterval(poll);
  }, []);

  // ----- Countdown ticker -----
  useEffect(() => {
    if (!nextDrawDate) return;
    const interval = setInterval(() => {
      const diff = nextDrawDate.getTime() - Date.now();
      if (diff <= 0) { setCountdown(null); setNextDrawDate(null); clearInterval(interval); return; }
      const totalSeconds = Math.floor(diff / 1000);
      setCountdown({
        days:    Math.floor(totalSeconds / (24 * 3600)),
        hours:   Math.floor((totalSeconds % (24 * 3600)) / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [nextDrawDate]);

  // ----- Wallet handlers -----
  const disconnectCardano = (address?: string) => {
    if (address) {
      setConnectedWallets(prev => prev.filter(w => w.address !== address));
    } else {
      setConnectedWallets([]);
    }
    setOwnedNfts([]);
  };

  const handleWalletBtnClick = () => {
    setWalletDropdownOpen(v => !v);
    setWalletDropdownScreen('main');
  };

  const handleConnectCardano = () => {
    const detected = getAvailableWallets();
    console.log('[handleConnectCardano] detected:', detected.map(w => w.key), 'connected:', connectedWallets.map(w => w.name));
    if (detected.length === 0) { setShowNoWalletModal(true); setWalletDropdownOpen(false); return; }
    setWallets(detected);
    // Auto-connect only on first connection with a single wallet.
    // When wallets are already connected, always show the picker so the user
    // can select which extension to call enable() on (e.g. after switching accounts).
    if (detected.length === 1 && connectedWallets.length === 0) {
      connectWallet(detected[0].key); // dropdown closed by connectWallet on success
    } else {
      console.log('[handleConnectCardano] opening add-cardano picker');
      setWalletDropdownScreen('add-cardano');
    }
  };

  const handleDisconnectFlow = () => {
    if (connectedWallets.length > 1) {
      setWalletDropdownScreen('disconnect-pick');
    } else {
      disconnectCardano();
      setWalletDropdownOpen(false);
    }
  };

  const connectWallet = async (walletKey: string) => {
    console.log('[connectWallet] called with', walletKey);
    try {
      console.log('[connectWallet] calling enable()…');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = await (window as any).cardano[walletKey].enable();
      console.log('[connectWallet] enable() resolved, deriving address…');
      const address = await makeWalletFromAPI({} as any, api as WalletApi).address() ?? '';
      console.log('[connectWallet] address:', address);
      // Deduplicate by address — allows multiple accounts from same extension
      if (connectedWalletsRef.current.some(w => w.address === address)) {
        console.log('[connectWallet] address already connected, skipping');
        setWalletPickerNotice('This account is already connected. If you are using Lace, it does not support multiple accounts per dApp — try Eternl or a different wallet extension instead.');
        return;
      }
      setWalletPickerNotice(null);
      setConnectedWallets(prev => [...prev, { name: walletKey, api, address }]);
      setWallets([]);
      setWalletDropdownOpen(false);
    } catch (err) {
      console.error('[connectWallet] error:', err);
      raiseWalletNotice(err);
    }
  };

  // Keep ref in sync so retry lambdas always read the latest wallet list
  useEffect(() => {
    connectedWalletsRef.current = connectedWallets;
  }, [connectedWallets]);

  // Listen for account-change events fired by wallet extensions (CIP-30 experimental).
  // When a connected wallet signals an account switch, re-call enable() and add the
  // new account if it isn't already in the list.
  useEffect(() => {
    if (connectedWallets.length === 0) return;
    const cleanups: (() => void)[] = [];

    for (const w of connectedWallets) {
      const ext = (window as any).cardano?.[w.name];
      const on = ext?.experimental?.on ?? ext?.on;
      const off = ext?.experimental?.off ?? ext?.off;
      if (typeof on !== 'function') continue;

      const handler = async () => {
        try {
          const api = await ext.enable();
          const address = await makeWalletFromAPI({} as any, api as WalletApi).address() ?? '';
          if (!address || connectedWalletsRef.current.some(cw => cw.address === address)) return;
          setConnectedWallets(prev => [...prev, { name: w.name, api, address }]);
        } catch { /* ignore */ }
      };

      on('accountChange', handler);
      if (typeof off === 'function') cleanups.push(() => { try { off('accountChange', handler); } catch { /* ignore */ } });
    }

    return () => cleanups.forEach(fn => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedWallets.map(w => w.address).join(',')]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      if (logoDropdownRef.current && !logoDropdownRef.current.contains(e.target as Node)) {
        setLogoDropdownOpen(false);
      }
      if (walletDropdownRef.current && !walletDropdownRef.current.contains(e.target as Node)) {
        setWalletDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, []);

  // Re-enables the CIP-30 API for a specific wallet (triggers unlock UI).
  const refreshWallet = async (address: string): Promise<boolean> => {
    try {
      const entry = connectedWalletsRef.current.find(w => w.address === address);
      if (!entry) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = await (window as any).cardano[entry.name].enable();
      const updater = (w: ConnectedWalletState) => w.address === address ? { ...w, api } : w;
      setConnectedWallets(prev => prev.map(updater));
      connectedWalletsRef.current = connectedWalletsRef.current.map(updater);
      return true;
    } catch {
      return false;
    }
  };

  const raiseWalletNotice = (err: unknown) => {
    const code = (err as any)?.code;
    if (code === -3) setWalletNotice('locked');
    else if (code === -2) setWalletNotice('disconnected');
  };

  // Runs op(); if it throws APIError -3 (wallet locked), refreshes that wallet then retries once.
  const withWalletRetry = async <T,>(address: string, op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      if ((err as any)?.code !== -3) throw err;
      const ok = await refreshWallet(address);
      if (!ok) throw err;
      return await op();
    }
  };

  const closeModal = () => {
    setShowRentModal(false);
    setRentMode(false);
  };

  // ----- Data loaders (shared by background prefetch and modal-open paths) -----

  const fetchOwnedNftsData = async (): Promise<NftAsset[]> => {
    const allNfts: NftAsset[] = [];
    for (const w of connectedWalletsRef.current) {
      const walletUtxos = await withWalletLock(async () => {
        const lucid = await initLucid(network);
        selectWallet(lucid, w.api);
        return withWalletRetry(w.address, () => lucid.wallet().getUtxos());
      });
      const seen = new Set<string>();
      walletUtxos.flatMap(u =>
        Object.keys(u.assets).filter(unit => {
          if (!POLICY_IDS.some(p => unit.startsWith(p))) return false;
          if (seen.has(unit)) return false;
          seen.add(unit);
          return true;
        }).map(unit => ({ policyId: unit.slice(0, 56), assetName: toText(unit.slice(56)), walletKey: w.address } as NftAsset))
      ).forEach(n => allNfts.push(n));
    }
    return (await Promise.all(
      allNfts.map((a: NftAsset) => fetchNftMetadata(a.policyId, a.assetName, network))
    )).map((r: any, i: number) =>
      r.error
        ? { ...allNfts[i], name: allNfts[i].assetName } as NftAsset
        : { ...r, walletKey: allNfts[i].walletKey } as NftAsset
    );
  };

  const fetchListedNftsData = async (): Promise<NftAsset[]> => {
    // Read-only Lucid — no wallet selection needed for querying UTxOs.
    const lucid = await initLucid(network);
    const { contractAddress } = await loadRentalValidator(network);
    const utxos = await lucid.utxosAt(contractAddress);

    const available = utxos.flatMap((u) => {
      if (!u.datum) return [];
      try {
        const datum = decodeDatum(u);
        if (datum.renter !== null) return [];                      // already rented
        if (datum.draw_date <= BigInt(Date.now())) return [];      // draw date passed
        return [{
          policyId: datum.nft_policy,
          assetName: datum.nft_asset_name,
          name: datum.nft_asset_name,
          rentalFee: datum.rental_fee,
        } as NftAsset];
      } catch {
        return [];
      }
    });

    return Promise.all(
      available.map(async (a: NftAsset) => {
        const meta = await fetchNftMetadata(a.policyId, a.assetName, network);
        return (meta as any).error
          ? a
          : { ...a, image: (meta as any).image ?? undefined, name: (meta as any).name ?? a.name } as NftAsset;
      })
    );
  };

  // Quiet refresh: only touch state (which resets the open modal's carousel)
  // when the data actually changed.
  const revalidateOwnedNfts = () => {
    fetchOwnedNftsData()
      .then(fresh => setOwnedNfts(prev => nftListKey(prev) === nftListKey(fresh) ? prev : fresh))
      .catch(() => { /* background refresh — modal already has usable data */ });
  };
  const revalidateListedNfts = () => {
    fetchListedNftsData()
      .then(fresh => setListedNfts(prev => nftListKey(prev) === nftListKey(fresh) ? prev : fresh))
      .catch(() => { /* background refresh — modal already has usable data */ });
  };

  // ----- Prefetch: owned NFTs load in the background on wallet connect, and
  // rental listings on page load, so the modals open without a fetch delay.
  useEffect(() => {
    if (connectedWallets.length === 0) { setOwnedNfts([]); setOwnedNftsReady(false); return; }
    let cancelled = false;
    setOwnedNftsReady(false);
    fetchOwnedNftsData()
      .then(nfts => { if (!cancelled) { setOwnedNfts(nfts); setOwnedNftsReady(true); preloadImages(nfts); } })
      .catch(err => console.warn('Owned-NFT prefetch failed — will load on demand:', err));
    return () => { cancelled = true; };
  }, [connectedWallets, network]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setListedNftsReady(false);
    fetchListedNftsData()
      .then(nfts => { if (!cancelled) { setListedNfts(nfts); setListedNftsReady(true); preloadImages(nfts); } })
      .catch(err => console.warn('Listings prefetch failed — will load on demand:', err));
    return () => { cancelled = true; };
  }, [network]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Owner: open listing modal (instant when prefetched) -----
  const loadOwnedNftsForListing = async () => {
    if (connectedWalletsRef.current.length === 0) return;
    setListingError(null);

    if (ownedNftsReady) {
      setRentMode(false);
      setShowRentModal(true);
      revalidateOwnedNfts(); // stale-while-revalidate
      return;
    }

    // Prefetch hasn't finished yet — load with the spinner as before.
    try {
      setLoadingOwnedNfts(true);
      const nfts = await fetchOwnedNftsData();
      setOwnedNfts(nfts);
      setOwnedNftsReady(true);
      setRentMode(false);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load NFTs', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setListingError('Failed to load your NFTs — try again.');
    } finally {
      setLoadingOwnedNfts(false);
    }
  };

  // ----- Renter: open rent modal (instant when prefetched) -----
  const loadListedNfts = async () => {
    setRentError(null);

    if (listedNftsReady) {
      setRentMode(true);
      setShowRentModal(true);
      revalidateListedNfts(); // stale-while-revalidate
      return;
    }

    try {
      setLoadingListedNfts(true);
      const nfts = await fetchListedNftsData();
      setListedNfts(nfts);
      setListedNftsReady(true);
      setRentMode(true);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load listed NFTs:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setRentError('Failed to load listings — try again.');
    } finally {
      setLoadingListedNfts(false);
    }
  };

  // ----- Owner: confirm listing modal → submit listing transaction -----
  // quantity > 1 lists the selected NFT plus the next NFTs from the same
  // wallet (one tx = one signer) at the same price.
  const handleCreateListing = async ({ nft, rentalPrice, quantity = 1 }: { nft: NftAsset; rentalPrice: string; quantity?: number }) => {
    if (connectedWallets.length === 0) { closeModal(); setShowConnectPrompt(true); return; }
    if (!nextDrawDate) return;
    const ownerAddr = nft.walletKey ?? connectedWalletsRef.current[0].address;
    const sameWallet = ownedNfts.filter(n => (n.walletKey ?? connectedWalletsRef.current[0].address) === ownerAddr);
    const batch = [nft, ...sameWallet.filter(n => n.assetName !== nft.assetName)].slice(0, Math.max(1, quantity));
    const names = batch.map(n => n.name ?? n.assetName);
    closeModal();
    setIsListing(true);
    setListingError(null);
    try {
      const txHash = await withWalletRetry(ownerAddr, async () => {
        const lucid = await initLucid(network);
        const w = connectedWalletsRef.current.find(cw => cw.address === ownerAddr)!;
        selectWallet(lucid, w.api);
        const { contractAddress } = await loadRentalValidator(network);
        return submitListing(names, w.address, rentalPrice, Math.floor(nextDrawDate.getTime()), contractAddress, lucid, network);
      });
      const n = names.length;
      setTxConfirm({ title: n > 1 ? `${n} Listings Created!` : 'Listing Created!', txHash });
      setHasActiveListings(true);
      setNftStats(prev => prev ? { ...prev, openRentals: prev.openRentals + n } : prev);
      setUserEntries(prev => prev ? { ...prev, listed: prev.listed + n, holding: Math.max(0, prev.holding - n), total: prev.total } : prev);
      // Keep the prefetched cache accurate: listed NFTs have left the wallet.
      setOwnedNfts(prev => prev.filter(o => !names.includes(o.name ?? o.assetName)));
      notifyListingCreated({ nftName: n > 1 ? `${names[0]} +${n - 1} more` : names[0], price: rentalPrice, owner: ownerAddr, txHash });
    } catch (err) {
      console.error('Failed to list NFT:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setListingError(errMsg(err));
    } finally {
      setIsListing(false);
    }
  };

  // ----- Renter: confirm rent modal → submit rent transaction -----
  const handleRentNft = async ({ nft }: { nft: NftAsset; rentalPrice: string }) => {
    if (connectedWallets.length === 0) { closeModal(); setShowConnectPrompt(true); return; }
    const payerAddr = connectedWalletsRef.current[0].address;
    closeModal();
    setIsRenting(true);
    setRentError(null);
    try {
      const result = await withWalletRetry(payerAddr, async () => {
        const lucid = await initLucid(network);
        const w = connectedWalletsRef.current[0];
        selectWallet(lucid, w.api);
        const validator = await loadRentalValidator(network);
        return rentNft(nft.assetName, w.address, validator, lucid);
      });
      setTxConfirm({ title: 'NFT Rented!', txHash: result.txHash });
      setNftStats(prev => prev ? { ...prev, openRentals: Math.max(0, prev.openRentals - 1), activeRentals: prev.activeRentals + 1 } : prev);
      setUserEntries(prev => prev ? { ...prev, renting: prev.renting + 1, total: prev.total + 1 } : prev);
      // Keep the prefetched cache accurate: this listing is no longer available.
      setListedNfts(prev => prev.filter(l => l.assetName !== nft.assetName));
      const { url: bfUrl, apiKey: bfKey } = blockfrostConfig(network);
      waitForTxOnChain(result.txHash, bfUrl, bfKey, () => {}).then(() => {
        setTxConfirmedToast({ txHash: result.txHash });
        setTimeout(() => setTxConfirmedToast(null), 8000);
      }).catch(() => {});
      notifyRentalConfirmed({ nftName: nft.name ?? nft.assetName, fee: nft.rentalFee != null ? (Number(nft.rentalFee) / 1_000_000).toFixed(2) : '—', renter: payerAddr, owner: '—', txHash: result.txHash });
    } catch (err) {
      console.error('Failed to rent NFT:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setRentError(errMsg(err));
    } finally {
      setIsRenting(false);
    }
  };

  // ----- Renter: budget-based batch rent → one tx for up to BATCH_RENT_CAP NFTs -----
  const handleBatchRent = async (selection: NftAsset[]) => {
    if (connectedWallets.length === 0) { closeModal(); setShowConnectPrompt(true); return; }
    if (selection.length === 0) return;
    const payerAddr = connectedWalletsRef.current[0].address;
    closeModal();
    setIsRenting(true);
    setRentError(null);
    try {
      const result = await withWalletRetry(payerAddr, async () => {
        const lucid = await initLucid(network);
        const w = connectedWalletsRef.current[0];
        selectWallet(lucid, w.api);
        const validator = await loadRentalValidator(network);
        return rentNftsBatch(selection.map(n => n.assetName), w.address, validator, lucid);
      });
      const n = selection.length;
      setTxConfirm({ title: n > 1 ? `${n} NFTs Rented!` : 'NFT Rented!', txHash: result.txHash });
      setNftStats(prev => prev ? { ...prev, openRentals: Math.max(0, prev.openRentals - n), activeRentals: prev.activeRentals + n } : prev);
      setUserEntries(prev => prev ? { ...prev, renting: prev.renting + n, total: prev.total + n } : prev);
      // Keep the prefetched cache accurate: these listings are no longer available.
      const rentedNames = new Set(selection.map(s => s.assetName));
      setListedNfts(prev => prev.filter(l => !rentedNames.has(l.assetName)));
      const { url: bfUrl, apiKey: bfKey } = blockfrostConfig(network);
      waitForTxOnChain(result.txHash, bfUrl, bfKey, () => {}).then(() => {
        setTxConfirmedToast({ txHash: result.txHash });
        setTimeout(() => setTxConfirmedToast(null), 8000);
      }).catch(() => {});
      const totalFee = selection.reduce((s, x) => s + Number(x.rentalFee ?? 0), 0);
      notifyRentalConfirmed({ nftName: `${selection[0].name ?? selection[0].assetName} +${n - 1} more`, fee: (totalFee / 1_000_000).toFixed(2), renter: payerAddr, owner: '—', txHash: result.txHash });
    } catch (err) {
      console.error('Failed to batch rent:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setRentError(errMsg(err));
    } finally {
      setIsRenting(false);
    }
  };

  // ----- Owner: load cancellable listings from all connected wallets -----
  const loadCancellableListings = async () => {
    if (connectedWalletsRef.current.length === 0) return;
    setCancelError(null);
    setLoadingCancelListings(true);
    try {
      const lucid = await initLucid(network);
      const { contractAddress } = await loadRentalValidator(network);
      const utxos = await lucid.utxosAt(contractAddress);
      const allAddresses = connectedWalletsRef.current.map(w => w.address);
      const raw = utxos.flatMap(u => {
        try {
          const datum = decodeDatum(u);
          if (!allAddresses.includes(datum.owner) || datum.renter !== null) return [];
          const ownerW = connectedWalletsRef.current.find(w => w.address === datum.owner);
          return [{ policyId: datum.nft_policy, assetName: datum.nft_asset_name, name: datum.nft_asset_name, walletKey: ownerW?.address } as NftAsset];
        } catch { return []; }
      });
      const owned = await Promise.all(
        raw.map(async (a: NftAsset) => {
          const meta = await fetchNftMetadata(a.policyId, a.assetName, network);
          return (meta as any).error ? a : { ...a, image: (meta as any).image ?? undefined, name: (meta as any).name ?? a.name } as NftAsset;
        })
      );
      setCancelNfts(owned);
      setShowCancelModal(true);
    } catch (err) {
      console.error('Failed to load cancellable listings:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setCancelError('Failed to load listings — try again.');
    } finally {
      setLoadingCancelListings(false);
    }
  };

  // ----- Owner: confirm cancel modal → submit CancelListing transaction -----
  const handleCancelNft = async ({ nft }: { nft: NftAsset; rentalPrice: string }) => {
    if (connectedWallets.length === 0) return;
    const ownerAddr = nft.walletKey ?? connectedWalletsRef.current[0].address;
    setShowCancelModal(false);
    setIsCancelling(true);
    setCancelError(null);
    try {
      const result = await withWalletRetry(ownerAddr, async () => {
        const lucid = await initLucid(network);
        const w = connectedWalletsRef.current.find(cw => cw.address === ownerAddr)!;
        selectWallet(lucid, w.api);
        const validator = await loadRentalValidator(network);
        return cancelListingNft(nft.assetName, w.address, validator, lucid);
      });
      setTxConfirm({ title: 'Listing Cancelled!', txHash: result.txHash });
      setNftStats(prev => prev ? { ...prev, openRentals: Math.max(0, prev.openRentals - 1) } : prev);
      setCancelNfts(prev => {
        const updated = prev.filter(n => n.assetName !== nft.assetName);
        setHasActiveListings(updated.length > 0);
        return updated;
      });
      setUserEntries(prev => prev ? { ...prev, listed: Math.max(0, prev.listed - 1), holding: prev.holding + 1, total: prev.total } : prev);
      // Keep the prefetched caches accurate: the listing is gone from the
      // contract and the NFT is on its way back to the owner's wallet.
      setListedNfts(prev => prev.filter(l => l.assetName !== nft.assetName));
      setOwnedNfts(prev => prev.some(o => o.assetName === nft.assetName)
        ? prev
        : [...prev, { ...nft, rentalFee: undefined, walletKey: ownerAddr }]);
    } catch (err) {
      console.error('Cancel failed:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) setCancelError(errMsg(err));
    } finally {
      setIsCancelling(false);
    }
  };

  // ----- Admin: execute draw (seed-based signing) -----
  const handleExecuteDraw = async () => {
    const seed = (process.env.REACT_APP_OWNER_SEED_PHRASE ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!seed) {
      setDrawError('REACT_APP_OWNER_SEED_PHRASE not set in .env — restart the dev server after adding it.');
      return;
    }
    const prizeFloat = parseFloat(drawPrizeAda);
    if (isNaN(prizeFloat) || prizeFloat <= 0) {
      setDrawError('Enter a valid prize amount in ADA.');
      return;
    }
    setIsDrawing(true);
    setDrawError(null);
    setDrawLog([]);

    const log = (msg: string) => setDrawLog(prev => [...prev, msg]);

    if (countdown && scheduledDrawDate) {
      const msUntilDraw = scheduledDrawDate.getTime() - Date.now();
      if (msUntilDraw > 0) {
        log(`Draw armed — waiting until ${scheduledDrawDate.toLocaleTimeString()} to select winner…`);
        await new Promise<void>(resolve => setTimeout(resolve, msUntilDraw));
        log('Draw time reached — selecting winner now.');
      }
    }

    try {
      const lucid = await initLucid(network);
      lucid.selectWallet.fromSeed(seed);

      const { contractAddress } = await loadRentalValidator(network);

      // Each source produces independent tickets. The same address can hold
      // multiple entries (one per NFT owned, one per rental, one as a wallet
      // participant). Deduplication applies only within each source, keyed on
      // the ticket's unique identifier (asset_id for NFT sources, address for
      // wallet entries). The presence or absence of an asset_id determines the
      // payout path — entries with no asset_id are always paid 100% directly.

      type DrawParticipant =
        | { source: 'rental';     address: string; assetId: string; rental: { utxo: UTxO; datum: RentalDatum } }
        | { source: 'nft_holder'; address: string; assetId: string }
        | { source: 'wallet';     address: string; assetId: null };

      // ── Source 1: on-chain rental UTxOs (unique per NFT asset) ───────────────
      const utxos = await lucid.utxosAt(contractAddress);
      const rentalParticipants: DrawParticipant[] = utxos.flatMap(u => {
        try {
          const datum = decodeDatum(u);
          return [{ source: 'rental' as const, address: datum.owner, assetId: datum.nft_asset_name, rental: { utxo: u, datum } }];
        } catch { return []; }
      });

      // ── Source 2: live on-chain NFT holders (Blockfrost policy query) ──────────
      // Excludes the contract address (counted as rental) and project wallet.
      const { url: blockfrostBase, apiKey: blockfrostKey } = blockfrostConfig(network);
      log('Fetching live NFT holders from chain…');
      const nftHolderRows = await fetchLiveNftHolders(
        blockfrostBase,
        blockfrostKey,
        new Set([contractAddress, PROJECT_WALLET[network]]),
      );

      // ── Source 3: socials participants (address only, no asset_id) ──────────
      // CSV may contain both Cardano and Solana addresses. Only Cardano addresses
      // can receive ADA payouts — Solana addresses are counted for participation
      // but excluded from the on-chain payout pool.
      const parseSocialsCsv = async (): Promise<{ cardano: string[]; solana: string[] }> => {
        try {
          const res = await fetch('/data/socials_participants.csv');
          if (!res.ok) return { cardano: [], solana: [] };
          const text = await res.text();
          const seen = new Set<string>();
          const addrs = text.trim().split('\n')
            .slice(1)
            .map(l => l.trim().replace(/^"|"$/g, ''))
            .filter(l => l.length > 0)
            .filter(a => { if (seen.has(a)) return false; seen.add(a); return true; });
          return {
            cardano: addrs.filter(isCardanoAddress),
            solana:  addrs.filter(isSolanaAddress),
          };
        } catch { return { cardano: [], solana: [] }; }
      };

      const { cardano: cardanoSocialAddrs, solana: solanaSocialAddrs } = await parseSocialsCsv();
      const walletAddresses = cardanoSocialAddrs;
      void solanaSocialAddrs; // counted in entries but not eligible for ADA payout

      const nftHolderParticipants: DrawParticipant[] = nftHolderRows.map(
        r => ({ source: 'nft_holder' as const, address: r.address, assetId: r.assetId })
      );
      const walletParticipants: DrawParticipant[] = walletAddresses.map(
        address => ({ source: 'wallet' as const, address, assetId: null as null })
      );

      const allParticipants: DrawParticipant[] = [
        ...rentalParticipants,
        ...nftHolderParticipants,
        ...walletParticipants,
      ];

      if (allParticipants.length === 0) {
        throw new Error('No participants found across rental listings, NFT holders, or wallet list.');
      }

      log(`Rental listings:  ${rentalParticipants.length}`);
      log(`NFT holders:      ${nftHolderParticipants.length}`);
      log(`Wallet entries:   ${walletParticipants.length}`);
      log(`Total pool:       ${allParticipants.length}`);

      // ── Select winner ─────────────────────────────────────────────────────────
      // Entropy is fixed to the first block produced AT OR AFTER the scheduled
      // draw timestamp. Because the draw can only execute after the countdown
      // expires, and the block is determined by the chain (not the admin), the
      // winner cannot be influenced by choosing when to press the button.

      if (!scheduledDrawDate) throw new Error('No scheduled draw date found — update drawDates.csv.');

      // Convert the draw timestamp to a Cardano slot using the network genesis.
      const genesisRes = await fetch(`${blockfrostBase}/genesis`, {
        headers: { project_id: blockfrostKey },
      });
      if (!genesisRes.ok) throw new Error(`Blockfrost /genesis failed: ${genesisRes.status}`);
      // Blockfrost returns system_start as a Unix timestamp in seconds (integer),
      // not an ISO string — multiply by 1000 to get milliseconds.
      const genesis = await genesisRes.json() as { system_start: number; slot_length: number };
      const systemStartMs = genesis.system_start * 1000;
      const drawSlot = Math.floor((scheduledDrawDate.getTime() - systemStartMs) / (genesis.slot_length * 1000));
      log(`Draw slot: ${drawSlot} (genesis start: ${new Date(systemStartMs).toISOString()})`);

      // Find the first block at or after the draw slot (not every slot has a block).
      let block: { hash: string; slot: number } | null = null;
      for (let s = drawSlot; s <= drawSlot + 500 && !block; s++) {
        const res = await fetch(`${blockfrostBase}/blocks/slot/${s}`, {
          headers: { project_id: blockfrostKey },
        });
        if (res.ok) block = await res.json() as { hash: string; slot: number };
      }
      if (!block) throw new Error('Could not find a block at the draw slot — try again shortly.');

      log(`Entropy block hash: ${block.hash}`);
      log(`Entropy block slot: ${block.slot}`);

      // SHA-256 of "blockHash:blockSlot:poolSize" produces 32 bytes of entropy.
      // Bytes  0-7  → BigInt index (which slot in the shuffled pool wins).
      // Bytes  8-11 → xorshift32 seed for the Fisher-Yates shuffle.
      // Using different byte ranges keeps the shuffle order and the winning
      // index independent of each other.
      const entropyStr = `${block.hash}:${block.slot}:${allParticipants.length}`;
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entropyStr));
      const hashBytes  = new Uint8Array(hashBuffer);

      // Deterministic Fisher-Yates shuffle — removes any influence from CSV order.
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

      // Pick winner from shuffled pool using the hash-derived index.
      const hashBigInt = hashBytes.slice(0, 8).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
      const idx = Number(hashBigInt % BigInt(shuffled.length));
      const winner = shuffled[idx];

      log(`Winner source:  ${winner.source}`);
      log(`Winner address: ${winner.address}`);
      log(`Asset ID:       ${winner.assetId ?? '(none — wallet entry)'}`);
      setLastWinnerAddress(winner.address);
      if (scheduledDrawDate) { setLastWinnerDrawDate(scheduledDrawDate); lastWinnerDrawDateRef.current = scheduledDrawDate; }

      // ── Calculate payout ──────────────────────────────────────────────────────
      // Rental entry with an active renter → 90/10 split.
      // All other entries (nft_holder or wallet, or rental with no renter) → 100% to address.
      const prizeLovelace = BigInt(Math.round(prizeFloat * 1_000_000));
      const activeRenter = winner.source === 'rental' ? (winner.rental.datum.renter ?? null) : null;
      const renterShare = activeRenter ? prizeLovelace * BigInt(90) / BigInt(100) : BigInt(0);
      const ownerShare  = prizeLovelace - renterShare;

      if (activeRenter) {
        log(`Renter (90%): ${renterShare} lovelace → ${activeRenter}`);
        log(`Owner  (10%): ${ownerShare} lovelace → ${winner.address}`);
      } else {
        log(`Winner (100%): ${prizeLovelace} lovelace → ${winner.address}`);
      }

      // ── Build and submit payout transaction ───────────────────────────────────
      let tx = lucid.newTx().pay.ToAddress(winner.address, { lovelace: ownerShare });
      if (activeRenter) {
        tx = tx.pay.ToAddress(activeRenter, { lovelace: renterShare });
      }
      tx = tx.addSigner(PROJECT_WALLET[network]);

      const built  = await tx.complete();
      const signed = await built.sign.withWallet().complete();
      const txHash = await signed.submit();

      log(`Done! Payout tx: ${txHash}`);
      setTxConfirm({ title: 'Draw Complete!', txHash });

      // Automatically return NFTs to owners for all expired rental UTxOs,
      // regardless of whether they had an active renter.
      log('Waiting for payout to confirm before returning NFTs…');
      await waitForTxOnChain(txHash, blockfrostBase, blockfrostKey, log);
      // Allow Blockfrost UTxO index and wallet extension cache to settle after payout
      log('Settling — waiting 60s for UTxO index to update before returning NFTs…');
      await new Promise<void>(r => setTimeout(r, 60_000));
      log('Returning rental NFTs to owners…');
      try {
        const claimLucid = await initLucid(network);
        const claimValidator = await loadRentalValidator(network);
        claimLucid.selectWallet.fromSeed(seed);
        const claimedHashes = await claimBackExpiredRentals(
            PROJECT_WALLET[network],
            claimValidator,
            claimLucid,
            msg => setDrawLog(prev => [...prev, msg]),
          );
        log(`Returned ${(claimedHashes as string[]).length} NFT(s) to owner(s).`);
      } catch (cbErr) {
        const cbMsg = cbErr instanceof Error ? cbErr.message : String(cbErr);
        // "No expired UTxOs" just means no rentals were active this cycle
        if (!cbMsg.includes('No expired')) {
          setDrawError(`NFT return failed — use "Claim Back" in admin to retry: ${cbMsg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Draw failed:', err);
      setDrawError(msg);
    } finally {
      setIsDrawing(false);
    }
  };

  // ----- Admin: claim back all expired rental UTxOs -----
  const handleClaimBack = async () => {
    const adminWallet = connectedWalletsRef.current.find(w => w.address === PROJECT_WALLET[network]);
    if (!adminWallet) return;
    setIsClaimingBack(true);
    setClaimBackLog([]);
    setClaimBackError(null);
    try {
      const lucid = await initLucid(network);
      selectWallet(lucid, adminWallet.api);
      const validator = await loadRentalValidator(network);
      await withWalletRetry(adminWallet.address, async () => {
        selectWallet(lucid, connectedWalletsRef.current.find(w => w.name === adminWallet.name)!.api);
        return claimBackExpiredRentals(
          adminWallet.address,
          validator,
          lucid,
          msg => setClaimBackLog(prev => [...prev, msg]),
        );
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('ClaimBack failed:', err);
      setClaimBackError(msg);
    } finally {
      setIsClaimingBack(false);
    }
  };

  // ----- Admin: preview live NFT holders from Blockfrost -----
  const handleSyncHolders = async () => {
    setIsSyncingHolders(true);
    setHolderPreview(null);
    setHolderSyncError(null);
    try {
      const { contractAddress } = await loadRentalValidator(network);
      const { url: blockfrostBase, apiKey: blockfrostKey } = blockfrostConfig(network);
      const holders = await fetchLiveNftHolders(
        blockfrostBase,
        blockfrostKey,
        new Set([contractAddress, PROJECT_WALLET[network]]),
      );
      const uniqueAddresses = new Set(holders.map(h => h.address)).size;
      setHolderPreview(`${holders.length} ticket(s) across ${uniqueAddresses} wallet(s)`);
    } catch (err) {
      setHolderSyncError(errMsg(err));
    } finally {
      setIsSyncingHolders(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className={`app-container${isDarkMode ? ' dark-mode' : ''}${isDimming ? ' dimming' : ''}`}>
      <header className="header">
        <div className="logo-group" ref={logoDropdownRef}>
          <button className="logo" onClick={() => setLogoDropdownOpen(o => !o)}>
            <img src="/Donada_Logo.png" alt="DONADA" className="logo-img" />
            <span><span className="logo-don">DON</span><span className="logo-ada">ADA</span></span>
          </button>
          {logoDropdownOpen && (
            <div className="logo-dropdown">
              <a className="logo-dropdown-item" href="https://donada.io">DONADA</a>
              <span className="logo-dropdown-item logo-dropdown-active">DONADA App <span className="logo-dropdown-dot" /></span>
              <a className="logo-dropdown-item" href="https://mint.donada.io">DONADA Mint</a>
            </div>
          )}
        </div>

        <div className="user-controls">
          <button className="theme-toggle" onClick={() => {
            setIsDimming(true);
            setTimeout(() => {
              setIsDarkMode(d => !d);
              setIsDimming(false);
            }, 150);
          }}>
            {isDarkMode ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
          {/* ── Wallet action button + dropdown ── */}
          <div className="wallet-action-wrapper" ref={walletDropdownRef}>
            <button className="select-btn" onClick={handleWalletBtnClick}>
              {connectedWallets.length > 0 ? 'Wallet Actions' : 'Sign In'}
            </button>

            {walletDropdownOpen && walletDropdownScreen === 'main' && (
              <div className="wallet-dropdown">
                {connectedWallets.map((cw, i) => (
                  <div
                    key={cw.address}
                    className="wallet-dropdown-item wallet-dropdown-item--connected"
                    style={{ '--wallet-color': WALLET_BRAND_COLORS[cw.name.toLowerCase()] ?? '#666' } as React.CSSProperties}
                  >
                    <div className="wallet-dropdown-connected-inner">
                      <span className="wallet-dropdown-connected-name">{cw.name}</span>
                      <span className="wallet-dropdown-connected-addr">
                        {cw.address ? `${cw.address.slice(0, 10)}…${cw.address.slice(-6)}` : cw.name}
                      </span>
                    </div>
                    {i === connectedWallets.length - 1 && (
                      <button
                        className="wallet-dropdown-add-btn"
                        title="Add another Cardano wallet"
                        onClick={e => { e.stopPropagation(); handleConnectCardano(); }}
                      >+</button>
                    )}
                  </div>
                ))}
                {connectedWallets.length > 0 && (
                  <div className="wallet-dropdown-divider" />
                )}
                {connectedWallets.length === 0 && (
                  <button className="wallet-dropdown-item" onClick={handleConnectCardano}>
                    Connect Cardano
                  </button>
                )}
                {connectedWallets.length > 0 && (
                  <>
                    <div className="wallet-dropdown-divider" />
                    <button className="wallet-dropdown-item wallet-dropdown-item--danger" onClick={handleDisconnectFlow}>
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            )}

            {walletDropdownOpen && walletDropdownScreen === 'add-cardano' && (
              <div className="wallet-dropdown">
                <button className="wallet-dropdown-back" onClick={() => { setWalletDropdownScreen('main'); setWalletPickerNotice(null); }}>← Back</button>
                <p className="wallet-dropdown-label">Choose Cardano Wallet</p>
                {connectedWallets.length > 0 && !walletPickerNotice && (
                  <p className="wallet-dropdown-hint">To add a second account, switch accounts in your wallet extension first. Note: Lace only supports one account per dApp — use Eternl or a different extension for multiple accounts.</p>
                )}
                {walletPickerNotice && (
                  <p className="wallet-dropdown-notice">{walletPickerNotice}</p>
                )}
                {wallets.map(w => (
                  <button
                    key={w.key}
                    className="wallet-dropdown-item"
                    onClick={() => { console.log('[picker] clicked', w.key); connectWallet(w.key); }}
                  >
                    {w.icon
                      ? <img src={w.icon} alt={w.name} className="wallet-dropdown-icon" />
                      : <span className="wallet-dropdown-icon-fallback">{w.name.slice(0, 2).toUpperCase()}</span>
                    }
                    {w.name}
                  </button>
                ))}
              </div>
            )}

            {walletDropdownOpen && walletDropdownScreen === 'disconnect-pick' && (
              <div className="wallet-dropdown">
                <button className="wallet-dropdown-back" onClick={() => setWalletDropdownScreen('main')}>← Back</button>
                <p className="wallet-dropdown-label">Disconnect which?</p>
                {connectedWallets.map(cw => (
                  <button
                    key={cw.address}
                    className="wallet-dropdown-item wallet-dropdown-item--danger"
                    onClick={() => { disconnectCardano(cw.address); setWalletDropdownOpen(false); }}
                  >
                    ◈ {cw.name} ({cw.address.slice(0, 8)}…)
                  </button>
                ))}
                <div className="wallet-dropdown-divider" />
                <button
                  className="wallet-dropdown-item wallet-dropdown-item--danger"
                  onClick={() => { disconnectCardano(); setWalletDropdownOpen(false); }}
                >
                  Disconnect All
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {walletNotice && (
        <div className="wallet-notice" role="alert">
          <button className="wallet-notice-close" onClick={() => setWalletNotice(null)}>✕</button>
          <p className="wallet-notice-title">Wallet Connection Issue</p>
          <p className="wallet-notice-body">
            {walletNotice === 'locked'
              ? 'Your wallet is locked. Please unlock it and refresh the page to reconnect.'
              : 'The wallet connection was lost. Please reconnect the dApp in your wallet extension, then refresh the page.'}
          </p>
          <button className="wallet-notice-refresh" onClick={() => window.location.reload()}>
            Refresh Page
          </button>
        </div>
      )}

      <main className="main-content">
        <div className="nft-card">
          <div className="nft-top-row">
            <div className="nft-image">
              <div className="nft-image-frame">
                <div className={`nft-image-inner${featuredNftImage ? ' has-image' : ''}`}>
                  {featuredNftImage
                    ? <img src={featuredNftImage} alt={collectionName} onError={ipfsImgFallback} />
                    : 'NFT IMAGE'}
                </div>
                <div className="nft-details">
                  <p className="mint-name">Collection: {collectionName}</p>
                  <p className="policy-id" title={DONADA_POLICY_ID}>
                    Policy ID: {DONADA_POLICY_ID.slice(0, 10)}…{DONADA_POLICY_ID.slice(-8)}
                  </p>
                  <p className="meta">
                    TOTAL # of NFTS: {nftStats != null ? nftStats.total : '—'}
                  </p>
                  <p className="meta">
                    # of available rentals: {nftStats != null ? nftStats.openRentals : '—'}
                  </p>
                </div>
              </div>
            </div>

            {connectedWallets.length > 0 && (
              <div className="entries-panel">
                <div className="entries-total">
                  {userEntries != null ? userEntries.total : '—'}
                </div>
                <div className="entries-label">Your Entries</div>
                <div className={`entries-expandable${entriesExpanded ? ' expanded' : ''}`}>
                  <div className="entries-breakdown">
                    <div className="entries-row">
                      <span>Listed</span><span>{userEntries?.listed ?? '—'}</span>
                    </div>
                    <div className="entries-row">
                      <span>Renting</span><span>{userEntries?.renting ?? '—'}</span>
                    </div>
                    <div className="entries-row">
                      <span>Free Entry</span>
                      <span>{!userEntries?.freeEntrySnapshotTaken ? '0' : (userEntries?.participated ?? '—')}</span>
                    </div>
                    <div className="entries-row">
                      <span>Holding</span>
                      <span>{userEntries?.holding ?? '—'}</span>
                    </div>
                  </div>
                </div>
                <button
                  className="entries-toggle"
                  onClick={() => setEntriesExpanded(e => !e)}
                  aria-label={entriesExpanded ? 'Collapse entries' : 'Expand entries'}
                >
                  {entriesExpanded ? '−' : '+'}
                </button>
              </div>
            )}
          </div>

          <div className="info-sections">
            <div className="left-section">
              <div className="info-block">
                <p className="label">Next Draw Date:</p>
                <p className="value">
                  {nextDrawDate
                    ? nextDrawDate.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })
                    : drawDatesLoaded ? 'TBD' : 'Loading...'}
                </p>
              </div>

              <hr className="section-break" />

              <div className="info-block">
                {!countdown && lastWinnerAddress && (!lastWinnerDrawDate || new Date().toLocaleDateString() === lastWinnerDrawDate.toLocaleDateString()) ? (
                  <>
                    <p className="label">Congratulations!</p>
                    <p className="value" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                      {lastWinnerAddress.slice(0, 12)}…{lastWinnerAddress.slice(-6)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="label">Countdown:</p>
                    <p className="value">
                      {countdown
                        ? `${countdown.days}D ${countdown.hours}H ${countdown.minutes}M ${countdown.seconds}S`
                        : '00D 00H 00M 00S'}
                    </p>
                  </>
                )}
              </div>
            </div>

            {!connectedWallets.some(w => ADMIN_ADDRESSES.has(w.address)) && <div className="right-section">
              <div className="action-block">
                <div className="action-text">Browse Rental Listings</div>
                <button
                  className="select-btn small"
                  disabled={!countdown || loadingListedNfts || isRenting}
                  onClick={loadListedNfts}
                >
                  {loadingListedNfts ? 'Loading...' : isRenting ? 'Renting...' : 'select'}
                </button>
              </div>

              {rentError && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
                    Error: {rentError}
                  </div>
                </div>
              )}

              <hr className="section-break" />

              <div className="action-block">
                <div className="action-text">Create Rental Listing</div>
                <button
                  className="select-btn small"
                  disabled={connectedWallets.length === 0 || loadingOwnedNfts || !countdown || isListing}
                  onClick={() => loadOwnedNftsForListing()}
                >
                  {loadingOwnedNfts ? 'Loading...' : isListing ? 'Listing...' : 'select'}
                </button>
              </div>

              {listingError && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
                    Error: {listingError}
                  </div>
                </div>
              )}

              {hasActiveListings && (
                <>
                  <hr className="section-break" />

                  <div className="action-block">
                    <div className="action-text">Cancel Listing</div>
                    <button
                      className="select-btn small"
                      disabled={connectedWallets.length === 0 || loadingCancelListings || isCancelling}
                      onClick={loadCancellableListings}
                    >
                      {loadingCancelListings ? 'Loading...' : isCancelling ? 'Cancelling...' : 'select'}
                    </button>
                  </div>

                  {cancelError && (
                    <div className="action-block">
                      <div className="action-text" style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
                        Error: {cancelError}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>}
          </div>
        </div>
      {connectedWallets.some(w => ADMIN_ADDRESSES.has(w.address)) && (
        <section className="admin-draw">
          <h3>Admin — Execute Draw</h3>
          {nftStats != null && (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: '0 0 0.5rem' }}>
              Active contracts: {nftStats.openRentals + nftStats.activeRentals}
              {' '}({nftStats.openRentals} listed, {nftStats.activeRentals} rented)
            </p>
          )}
          <div className="action-block" style={{ marginBottom: '0.5rem' }}>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Network:
              <button
                className="select-btn"
                style={{ padding: '0.2rem 0.75rem', fontSize: '0.8rem' }}
                onClick={() => setNetwork(n => n === 'Mainnet' ? 'Preview' : 'Mainnet')}
              >
                {network}
              </button>
            </label>
          </div>
          <div className="action-block">
            <input
              className="price-input"
              type="text"
              inputMode="decimal"
              placeholder="Prize amount (ADA)"
              value={drawPrizeAda}
              onChange={e => setDrawPrizeAda(e.target.value.replace(/[^0-9.]/g, ''))}
            />
            <button
              className="select-btn"
              disabled={isDrawing || !drawPrizeAda || (!!countdown && drawPlanned && !!scheduledDrawDate && scheduledDrawDate > new Date())}
              onClick={handleExecuteDraw}
            >
              {isDrawing ? 'Executing…' : 'Execute Draw'}
            </button>
          </div>
          {countdown && scheduledDrawDate && scheduledDrawDate > new Date() && (
            <p style={{ fontSize: '0.75rem', color: '#888' }}>
              Draw date not yet reached.
            </p>
          )}
          {drawLog.length > 0 && (
            <div style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
              {drawLog.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
          {drawError && (
            <p style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
              Error: {drawError}
            </p>
          )}

          <hr className="section-break" style={{ margin: '1rem 0' }} />

          <div className="action-block">
            <div className="action-text">Preview NFT Holders (live)</div>
            <button
              className="select-btn small"
              disabled={isSyncingHolders}
              onClick={handleSyncHolders}
            >
              {isSyncingHolders ? 'Fetching…' : 'Sync'}
            </button>
          </div>
          {holderPreview && (
            <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>{holderPreview}</p>
          )}
          {holderSyncError && (
            <p style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
              Error: {holderSyncError}
            </p>
          )}

          <hr className="section-break" style={{ margin: '1rem 0' }} />

          <div className="action-block">
            <div className="action-text">
              Claim Back Expired Rentals
              {nftStats != null && nftStats.expiredRentals > 0 && (
                <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', opacity: 0.7 }}>
                  ({nftStats.expiredRentals})
                </span>
              )}
            </div>
            <button
              className="select-btn small"
              disabled={isClaimingBack}
              onClick={handleClaimBack}
            >
              {isClaimingBack ? 'Claiming…' : 'Claim Back'}
            </button>
          </div>
          {claimBackLog.length > 0 && (
            <div style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
              {claimBackLog.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
          {claimBackError && (
            <p style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
              Error: {claimBackError}
            </p>
          )}

          <hr className="section-break" style={{ margin: '1rem 0' }} />

          <div className="action-block">
            <div className="action-text">Preview No-Wallet Popup</div>
            <button
              className="select-btn small"
              onClick={() => setShowNoWalletModal(true)}
            >
              Preview
            </button>
          </div>
        </section>
      )}

      </main>

      <RentModal
        isOpen={showRentModal}
        mode={rentMode ? 'rent' : 'list'}
        nfts={(rentMode ? listedNfts : ownedNfts) as any}
        onClose={closeModal}
        onConfirm={rentMode ? handleRentNft : handleCreateListing}
        onBatchRent={rentMode ? (handleBatchRent as any) : undefined}
        batchRentCap={BATCH_RENT_CAP}
        nextDrawDate={nextDrawDate as any}
        countdown={countdown as any}
      />

      <RentModal
        isOpen={showCancelModal}
        mode="cancel"
        nfts={cancelNfts as any}
        onClose={() => setShowCancelModal(false)}
        onConfirm={handleCancelNft}
        nextDrawDate={nextDrawDate as any}
      />

      <TxConfirmModal
        title={txConfirm?.title ?? ''}
        txHash={txConfirm?.txHash ?? null}
        network={network}
        onClose={() => setTxConfirm(null)}
      />

      {showConnectPrompt && (
        <div className="connect-prompt-overlay" onClick={() => { setShowConnectPrompt(false); setPromptWallets([]); }}>
          <div className="connect-prompt" onClick={e => e.stopPropagation()}>
            <button className="connect-prompt-close" onClick={() => { setShowConnectPrompt(false); setPromptWallets([]); }}>✕</button>
            <p className="connect-prompt-title">Connect your wallet</p>
            {promptWallets.length === 0 ? (
              <>
                <p className="connect-prompt-body">You need to connect a wallet before renting an NFT.</p>
                <button
                  className="connect-prompt-btn"
                  onClick={() => {
                    const detected = getAvailableWallets();
                    if (detected.length === 1) {
                      connectWallet(detected[0].key);
                    } else {
                      setPromptWallets(detected);
                    }
                  }}
                >
                  Connect Wallet
                </button>
              </>
            ) : (
              <div className="connect-prompt-wallet-list">
                {promptWallets.map(w => (
                  <button
                    key={w.key}
                    className="wallet-icon-btn"
                    onClick={() => connectWallet(w.key)}
                    style={{ '--wallet-color': WALLET_BRAND_COLORS[w.key.toLowerCase()] ?? '#111' } as React.CSSProperties}
                  >
                    {w.icon
                      ? <img src={w.icon} alt={w.name} />
                      : <span className="wallet-icon-btn__fallback">{w.name.slice(0, 2).toUpperCase()}</span>
                    }
                    <span className="wallet-icon-btn__name">{w.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {txConfirmedToast && (
        <div className="tx-toast">
          <span className="tx-toast-icon">✓</span>
          <span className="tx-toast-text">Transaction confirmed on-chain</span>
          <a
            className="tx-toast-link"
            href={`https://${network === 'Mainnet' ? '' : 'preview.'}cardanoscan.io/transaction/${txConfirmedToast.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View
          </a>
          <button className="tx-toast-close" onClick={() => setTxConfirmedToast(null)}>✕</button>
        </div>
      )}

      {showNoWalletModal && (
        <div className="connect-prompt-overlay" onClick={() => setShowNoWalletModal(false)}>
          <div className="connect-prompt" onClick={e => e.stopPropagation()}>
            <button className="connect-prompt-close" onClick={() => setShowNoWalletModal(false)}>✕</button>
            <p className="connect-prompt-title">No Wallet Detected</p>
            <p className="connect-prompt-body">
              No Cardano wallet extension was found in your browser. Install one to get started.
            </p>
            <div className="no-wallet-links">
              {WALLET_DOWNLOADS.map(({ key, name, url }) => (
                <a
                  key={key}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-wallet-link"
                  style={{ '--wallet-color': WALLET_BRAND_COLORS[key] ?? '#111' } as React.CSSProperties}
                >
                  {name}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
