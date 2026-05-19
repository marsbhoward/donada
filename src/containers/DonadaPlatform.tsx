/// <reference types="node" />
import React, { useState, useEffect } from 'react';
import RentModal from '../components/RentModal';
import { BrowserWallet } from '@meshsdk/core';
import { fetchNftMetadata } from '../utils/nftMetadata';
import { Lucid, Blockfrost, fromText, toText, Data, Constr, UTxO, C, applyDoubleCborEncoding, fromHex, ProtocolParameters } from 'lucid-cardano';

// ── Contract constants ────────────────────────────────────────────────────────

const DONADA_POLICY_ID   = '21b36156acd6aaea44bf6b7c9ed3cbb818e74794a6081b32a267358a';
const PARTNER_POLICY_ID  = ''; // fill in partner policy ID when available
const POLICY_IDS         = [DONADA_POLICY_ID, PARTNER_POLICY_ID].filter(Boolean) as string[];
const PROJECT_WALLET_ADDRESS = 'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388';

// ── Validator loader — derives contract address from compiled plutus.json ─────

interface ValidatorSetup {
  contractAddress: string;
  compiledCode: string; // double-CBOR encoded hex for inline script attachment
}

let _validatorCache: ValidatorSetup | null = null;

async function loadRentalValidator(lucid: Lucid): Promise<ValidatorSetup> {
  if (_validatorCache) return _validatorCache;

  const resp = await fetch('/data/plutus.json');
  if (!resp.ok) throw new Error('Could not load /data/plutus.json — run `aiken build` first.');
  const blueprint = await resp.json();

  const spendValidator = blueprint.validators?.find(
    (v: { title: string }) => v.title === 'rental_validator.rental.spend'
  );
  if (!spendValidator) throw new Error('rental spend validator not found in plutus.json');

  const contractAddress = lucid.utils.credentialToAddress(
    lucid.utils.scriptHashToCredential(spendValidator.hash)
  );

  _validatorCache = {
    contractAddress,
    compiledCode: applyDoubleCborEncoding(spendValidator.compiledCode),
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
  wallet: BrowserWallet;
  api: unknown; // enabled CIP-30 API passed to lucid.selectWallet()
}

interface NftAsset {
  policyId: string;
  assetName: string;
  name?: string;
  image?: string;
  rentalFee?: bigint; // lovelace — set on listed NFTs fetched from the contract
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

function blockfrostConfig(network: Network): { url: string; apiKey: string } {
  return network === 'Preview'
    ? { url: 'https://cardano-preview.blockfrost.io/api/v0', apiKey: process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '' }
    : { url: 'https://cardano-mainnet.blockfrost.io/api/v0', apiKey: process.env.REACT_APP_BlockFrost_API_KEY_Mainnet ?? '' };
}

// Conway era testnets return expanded cost models that lucid-cardano can't handle.
// Truncate to the max entries lucid expects for V1 and V2.
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

async function initLucid(network: Network): Promise<Lucid> {
  const { url, apiKey } = blockfrostConfig(network);
  return Lucid.new(new ConwayCompatBlockfrost(url, apiKey), network);
}

// ── Datum helpers (shared by listing and rental flows) ────────────────────────

// Converts a bech32 address to the Plutus Constr representation that Aiken
// expects for the Address type: Constr(0, [PaymentCredential, Option<StakeCredential>])
function addressToData(lucid: Lucid, address: string): Constr<Data> {
  const { paymentCredential, stakeCredential } = lucid.utils.getAddressDetails(address);
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
function dataToAddress(lucid: Lucid, data: Data): string {
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

  return lucid.utils.credentialToAddress(paymentCred, stakeCred);
}

function encodeDatum(datum: RentalDatum, lucid: Lucid): string {
  return Data.to(
    new Constr(0, [
      datum.nft_policy,
      fromText(datum.nft_asset_name),
      addressToData(lucid, datum.owner),
      datum.renter !== null
        ? new Constr(0, [addressToData(lucid, datum.renter)])
        : new Constr(1, []),
      datum.rental_fee,
      datum.draw_date,
      addressToData(lucid, datum.project_wallet),
    ])
  );
}

function decodeDatum(utxo: UTxO, lucid: Lucid): RentalDatum {
  if (!utxo.datum) throw new Error(`UTxO ${utxo.txHash}#${utxo.outputIndex} has no inline datum.`);
  const constr = Data.from(utxo.datum) as Constr<Data>;
  const f = constr.fields;

  const renterConstr = f[3] as Constr<Data>;
  const renter = renterConstr.index === 0 ? dataToAddress(lucid, renterConstr.fields[0]) : null;

  return {
    nft_policy:     f[0] as string,
    nft_asset_name: toText(f[1] as string),
    owner:          dataToAddress(lucid, f[2]),
    renter,
    rental_fee:     f[4] as bigint,
    draw_date:      f[5] as bigint,
    project_wallet: dataToAddress(lucid, f[6]),
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

async function submitListing(
  nft_asset_name: string,
  owner_address: string,
  rental_fee_ada: string | number,
  drawDateMs: number,
  contractAddress: string,
  lucid: Lucid
): Promise<string> {
  const datum: RentalDatum = {
    nft_policy:     DONADA_POLICY_ID,
    nft_asset_name,
    owner:          owner_address,
    renter:         null,
    rental_fee:     adaToLovelace(rental_fee_ada),
    draw_date:      BigInt(drawDateMs),
    project_wallet: PROJECT_WALLET_ADDRESS,
  };

  const tx = await lucid
    .newTx()
    .payToContract(
      contractAddress,
      { inline: encodeDatum(datum, lucid) },
      {
        lovelace: BigInt(2000000),
        [DONADA_POLICY_ID + fromText(nft_asset_name)]: BigInt(1),
      }
    )
    .addSigner(owner_address)
    .complete();

  const signed = await tx.sign().complete();
  return signed.submit();
}

// ── Rental interaction helpers (renter pays fee, owner cancels) ───────────────

async function fetchRentalUtxo(nftAssetName: string, contractAddress: string, lucid: Lucid): Promise<UTxO> {
  const unit = DONADA_POLICY_ID + fromText(nftAssetName);
  const utxos = await lucid.utxosAtWithUnit(contractAddress, unit);

  if (utxos.length === 0) {
    throw new Error(`No active listing found for "${nftAssetName}".`);
  }
  return utxos[0];
}

function buildRentRedeemer(renterAddress: string, lucid: Lucid): string {
  // RentalRedeemer::Rent is index 1 in the Aiken enum: Constr(1, [renter_address])
  return Data.to(new Constr(1, [addressToData(lucid, renterAddress)]));
}


async function rentNft(
  nftAssetName: string,
  renterAddress: string,
  validator: ValidatorSetup,
  lucid: Lucid
): Promise<InteractionResult> {
  const { contractAddress, compiledCode } = validator;
  const rentalUtxo = await fetchRentalUtxo(nftAssetName, contractAddress, lucid);
  const datum = decodeDatum(rentalUtxo, lucid);

  if (datum.renter !== null) {
    throw new Error(`"${nftAssetName}" already has a registered renter.`);
  }
  if (BigInt(Date.now()) >= datum.draw_date) {
    throw new Error(`The draw date for "${nftAssetName}" has already passed.`);
  }

  // 90% to owner, 10% to project; integer division matches the on-chain validator.
  const ownerShare   = datum.rental_fee * BigInt(90) / BigInt(100);
  const projectShare = datum.rental_fee - ownerShare;

  const updatedDatum: RentalDatum = { ...datum, renter: renterAddress };

  const validToSlot = lucid.currentSlot() + 300; // ~5 min upper bound

  const txComplete = await lucid
    .newTx()
    .collectFrom([rentalUtxo], buildRentRedeemer(renterAddress, lucid))
    .payToContract(
      contractAddress,
      { inline: encodeDatum(updatedDatum, lucid) },
      {
        lovelace: rentalUtxo.assets.lovelace,
        [DONADA_POLICY_ID + fromText(nftAssetName)]: BigInt(1),
      }
    )
    .payToAddress(datum.owner,          { lovelace: ownerShare })
    .payToAddress(datum.project_wallet, { lovelace: projectShare })
    .addSigner(renterAddress)
    .validTo(validToSlot)
    .complete({ nativeUplc: false });

  // Inject the PlutusV3 script into the witness set.
  // lucid-cardano 0.10.7 has no PlutusV3 support in TransactionBuilder — construct()
  // throws "Missing required script" for V3 redeemers unless nativeUplc:false skips
  // that validation. The script is then added directly via the CML WitnessSet API.
  const plutusScript = C.PlutusScript.from_bytes(fromHex(compiledCode));
  const scripts = (C as any).PlutusScripts.new();
  scripts.add(plutusScript);
  const v3Witness = C.TransactionWitnessSet.new();
  v3Witness.set_plutus_v3_scripts(scripts);
  (txComplete as any).witnessSetBuilder.add_existing(v3Witness);

  const signed = await txComplete.sign().complete();
  const txHash = await signed.submit();

  return {
    success: true,
    txHash,
    message: `Successfully rented "${nftAssetName}". Your wallet is registered for the draw.`,
  };
}

async function cancelListingNft(
  nftAssetName: string,
  ownerAddress: string,
  validator: ValidatorSetup,
  lucid: Lucid
): Promise<InteractionResult> {
  const { contractAddress, compiledCode } = validator;
  const listingUtxo = await fetchRentalUtxo(nftAssetName, contractAddress, lucid);
  const datum = decodeDatum(listingUtxo, lucid);

  if (datum.renter !== null) {
    throw new Error(`"${nftAssetName}" already has a registered renter — cannot cancel.`);
  }

  const txComplete = await lucid
    .newTx()
    .collectFrom([listingUtxo], Data.to(new Constr(0, [])))
    .addSigner(ownerAddress)
    .complete({ nativeUplc: false });

  const plutusScript = C.PlutusScript.from_bytes(fromHex(compiledCode));
  const scripts = (C as any).PlutusScripts.new();
  scripts.add(plutusScript);
  const v3Witness = C.TransactionWitnessSet.new();
  v3Witness.set_plutus_v3_scripts(scripts);
  (txComplete as any).witnessSetBuilder.add_existing(v3Witness);

  const signed = await txComplete.sign().complete();
  const txHash = await signed.submit();

  return {
    success: true,
    txHash,
    message: `Listing for "${nftAssetName}" cancelled. Your NFT will return to your wallet.`,
  };
}

// ── Wallet detection ──────────────────────────────────────────────────────────

function getAvailableWallets(): WalletInfo[] {
  if (!window.cardano) return [];
  return Object.entries(window.cardano as Record<string, { enable?: unknown; name?: string; icon?: string }>)
    .filter(([, w]) => w && w.enable)
    .map(([key, w]) => ({ key, name: w.name || key, icon: w.icon || null }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DonadaPlatform() {
  // Network (toggled in admin panel; defaults to Preview for testnet)
  const [network, setNetwork] = useState<Network>('Preview');

  // Draw date / countdown
  const [nextDrawDate, setNextDrawDate] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [drawPlanned, setDrawPlanned] = useState(false);
  // Canonical draw timestamp — retained after countdown expires so entropy is tied to draw time.
  const [scheduledDrawDate, setScheduledDrawDate] = useState<Date | null>(null);

  // Wallet
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWalletState | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [fullWalletAddress, setFullWalletAddress] = useState<string | null>(null);

  // Modal
  const [showRentModal, setShowRentModal] = useState(false);
  const [rentMode, setRentMode] = useState(false); // true = renter flow, false = owner listing flow

  // Owner listing flow
  const [ownedNfts, setOwnedNfts] = useState<NftAsset[]>([]);
  const [loadingOwnedNfts, setLoadingOwnedNfts] = useState(false);
  const [isListing, setIsListing] = useState(false);
  const [listingTxHash, setListingTxHash] = useState<string | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);

  // Renter flow
  const [listedNfts, setListedNfts] = useState<NftAsset[]>([]);
  const [loadingListedNfts, setLoadingListedNfts] = useState(false);
  const [isRenting, setIsRenting] = useState(false);
  const [rentTxHash, setRentTxHash] = useState<string | null>(null);
  const [rentError, setRentError] = useState<string | null>(null);

  // Cancel listing flow
  const [cancelNfts, setCancelNfts] = useState<NftAsset[]>([]);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [loadingCancelListings, setLoadingCancelListings] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelTxHash, setCancelTxHash] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Admin draw flow (only shown when project wallet is connected)
  const [drawPrizeAda, setDrawPrizeAda] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawTxHash, setDrawTxHash] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [drawLog, setDrawLog] = useState<string[]>([]);

  // Invalidate validator cache whenever the network changes so the address is re-derived
  useEffect(() => { _validatorCache = null; }, [network]);

  // ----- Load next draw date from CSV -----
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/data/drawDates.csv');
        const text = await res.text();
        const lines = text.trim().split('\n').slice(1);
        const now = new Date();

        // CSV times are authored in Central Time. CDT (summer) = UTC-5, CST (winter) = UTC-6.
        const CST_OFFSET_HOURS = 5;
        const parseRow = (line: string): { date: Date; complete: boolean } | null => {
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
          // Convert CST → UTC before constructing the Date
          return { date: new Date(Date.UTC(year, month - 1, day, hour + CST_OFFSET_HOURS, minute)), complete };
        };

        // Only consider draws that have not been marked complete
        const incomplete = lines
          .map(parseRow)
          .filter((r): r is { date: Date; complete: boolean } => r !== null && !r.complete)
          .sort((a, b) => a.date.getTime() - b.date.getTime());

        // scheduledDrawDate: earliest incomplete draw (past or future) — used for entropy.
        // nextDrawDate: earliest incomplete future draw — used for countdown and datum.
        if (incomplete.length > 0) {
          setScheduledDrawDate(incomplete[0].date);
          setDrawPlanned(true);
        }

        const nextIncomplete = incomplete.find(r => r.date > now);
        if (nextIncomplete) setNextDrawDate(nextIncomplete.date);
      } catch (err) {
        console.error('Failed to load draw dates', err);
      }
    };
    load();
  }, []);

  // ----- Countdown ticker -----
  useEffect(() => {
    if (!nextDrawDate) return;
    const interval = setInterval(() => {
      const diff = nextDrawDate.getTime() - Date.now();
      if (diff <= 0) { setCountdown(null); clearInterval(interval); return; }
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
  const handleSelectWallet = () => {
    if (connectedWallet) {
      setConnectedWallet(null);
      setWalletAddress(null);
      setFullWalletAddress(null);
      setWallets([]);
      setOwnedNfts([]);
      return;
    }
    const detected = getAvailableWallets();
    setWallets(detected);
    if (detected.length === 1) connectWallet(detected[0].key);
  };

  const connectWallet = async (walletKey: string) => {
    try {
      const wallet = await BrowserWallet.enable(walletKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = await (window as any).cardano[walletKey].enable();
      const usedAddresses = await wallet.getUsedAddresses();
      const fullAddress = usedAddresses?.[0] ?? null;

      setConnectedWallet({ name: walletKey, wallet, api });
      setFullWalletAddress(fullAddress);
      setWalletAddress(fullAddress ? `${fullAddress.slice(0, 7)}…` : null);
      setWallets([]);
    } catch (err) {
      console.error('Error connecting to wallet:', err);
    }
  };

  const closeModal = () => {
    setShowRentModal(false);
    setRentMode(false);
  };

  // ----- Owner: load their own NFTs then open listing modal -----
  const loadOwnedNftsForListing = async () => {
    if (!connectedWallet) return;
    try {
      setLoadingOwnedNfts(true);
      const assets = await connectedWallet.wallet.getAssets();
      const filtered = assets.filter((a: NftAsset) => POLICY_IDS.includes(a.policyId));
      const enriched: NftAsset[] = await Promise.all(
        filtered.map((a: NftAsset) => fetchNftMetadata(a.policyId, a.assetName))
      );
      setOwnedNfts(enriched);
      setRentMode(false);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load NFTs', err);
    } finally {
      setLoadingOwnedNfts(false);
    }
  };

  // ----- Renter: load available listings from the contract then open rent modal -----
  const loadListedNfts = async () => {
    if (!connectedWallet) return;
    try {
      setLoadingListedNfts(true);
      // Read-only Lucid — no wallet selection needed for querying UTxOs.
      const lucid = await initLucid(network);
      const { contractAddress } = await loadRentalValidator(lucid);
      const utxos = await lucid.utxosAt(contractAddress);

      const available = utxos.flatMap((u) => {
        if (!u.datum) return [];
        try {
          const datum = decodeDatum(u, lucid);
          if (datum.renter !== null) return []; // already rented
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

      setListedNfts(available);
      setRentMode(true);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load listed NFTs:', err);
    } finally {
      setLoadingListedNfts(false);
    }
  };

  // ----- Owner: confirm listing modal → submit listing transaction -----
  const handleCreateListing = async ({ nft, rentalPrice }: { nft: NftAsset; rentalPrice: string }) => {
    if (!fullWalletAddress || !nextDrawDate || !connectedWallet) return;
    closeModal();
    setIsListing(true);
    setListingTxHash(null);
    setListingError(null);

    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);

      const { contractAddress } = await loadRentalValidator(lucid);
      const txHash = await submitListing(
        nft.name ?? nft.assetName,
        fullWalletAddress,
        rentalPrice,
        Math.floor(nextDrawDate.getTime()),
        contractAddress,
        lucid
      );
      setListingTxHash(txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to list NFT:', err);
      setListingError(msg);
    } finally {
      setIsListing(false);
    }
  };

  // ----- Renter: confirm rent modal → submit rent transaction -----
  const handleRentNft = async ({ nft }: { nft: NftAsset; rentalPrice: string }) => {
    if (!fullWalletAddress || !connectedWallet) return;
    closeModal();
    setIsRenting(true);
    setRentTxHash(null);
    setRentError(null);

    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);

      const validator = await loadRentalValidator(lucid);
      const result = await rentNft(nft.assetName, fullWalletAddress, validator, lucid);
      setRentTxHash(result.txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to rent NFT:', err);
      setRentError(msg);
    } finally {
      setIsRenting(false);
    }
  };

  // ----- Owner: load cancellable listings into modal -----
  const loadCancellableListings = async () => {
    if (!fullWalletAddress || !connectedWallet) return;
    setLoadingCancelListings(true);
    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);
      const { contractAddress } = await loadRentalValidator(lucid);
      const utxos = await lucid.utxosAt(contractAddress);
      const owned = utxos.flatMap(u => {
        try {
          const datum = decodeDatum(u, lucid);
          if (datum.owner !== fullWalletAddress || datum.renter !== null) return [];
          return [{ policyId: datum.nft_policy, assetName: datum.nft_asset_name, name: datum.nft_asset_name } as NftAsset];
        } catch { return []; }
      });
      setCancelNfts(owned);
      setShowCancelModal(true);
    } catch (err) {
      console.error('Failed to load cancellable listings:', err);
    } finally {
      setLoadingCancelListings(false);
    }
  };

  // ----- Owner: confirm cancel modal → submit CancelListing transaction -----
  const handleCancelNft = async ({ nft }: { nft: NftAsset; rentalPrice: string }) => {
    if (!fullWalletAddress || !connectedWallet) return;
    setShowCancelModal(false);
    setIsCancelling(true);
    setCancelTxHash(null);
    setCancelError(null);
    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);
      const validator = await loadRentalValidator(lucid);
      const result = await cancelListingNft(nft.assetName, fullWalletAddress, validator, lucid);
      setCancelTxHash(result.txHash);
      setCancelNfts(prev => prev.filter(n => n.assetName !== nft.assetName));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Cancel failed:', err);
      setCancelError(msg);
    } finally {
      setIsCancelling(false);
    }
  };

  // ----- Admin: execute draw (project wallet only) -----
  const handleExecuteDraw = async () => {
    if (!connectedWallet || !fullWalletAddress) return;
    const prizeFloat = parseFloat(drawPrizeAda);
    if (isNaN(prizeFloat) || prizeFloat <= 0) {
      setDrawError('Enter a valid prize amount in ADA.');
      return;
    }
    setIsDrawing(true);
    setDrawTxHash(null);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);

      const { contractAddress } = await loadRentalValidator(lucid);

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
          const datum = decodeDatum(u, lucid);
          return [{ source: 'rental' as const, address: datum.owner, assetId: datum.nft_asset_name, rental: { utxo: u, datum } }];
        } catch { return []; }
      });

      // ── Source 2: NFT holders not in rental (address + asset_id columns) ─────
      // Format: address,asset_id — one row per NFT so the same address with
      // multiple NFTs gets a separate ticket for each.
      const parseNftHoldersCsv = async (): Promise<Array<{ address: string; assetId: string }>> => {
        try {
          const res = await fetch('/data/nft_holders.csv');
          if (!res.ok) return [];
          const text = await res.text();
          const seen = new Set<string>();
          return text.trim().split('\n')
            .slice(1)
            .map(l => { const [address, assetId] = l.split(',').map(s => s.trim().replace(/^"|"$/g, '')); return { address, assetId }; })
            .filter(r => r.address && r.assetId)
            .filter(r => { const key = `${r.address}:${r.assetId}`; if (seen.has(key)) return false; seen.add(key); return true; });
        } catch { return []; }
      };

      // ── Source 3: wallet participants (address only, no asset_id) ─────────────
      const parseWalletCsv = async (): Promise<string[]> => {
        try {
          const res = await fetch('/data/wallet_participants.csv');
          if (!res.ok) return [];
          const text = await res.text();
          const seen = new Set<string>();
          return text.trim().split('\n')
            .slice(1)
            .map(l => l.trim().replace(/^"|"$/g, ''))
            .filter(l => l.length > 0)
            .filter(a => { if (seen.has(a)) return false; seen.add(a); return true; });
        } catch { return []; }
      };

      const [nftHolderRows, walletAddresses] = await Promise.all([
        parseNftHoldersCsv(),
        parseWalletCsv(),
      ]);

      const nftHolderParticipants: DrawParticipant[] = nftHolderRows.map(
        r => ({ source: 'nft_holder' as const, address: r.address, assetId: r.assetId })
      );
      const walletParticipants: DrawParticipant[] = walletAddresses.map(
        address => ({ source: 'wallet' as const, address, assetId: null })
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
      const { url: blockfrostBase, apiKey: blockfrostKey } = blockfrostConfig(network);

      if (!scheduledDrawDate) throw new Error('No scheduled draw date found — update drawDates.csv.');

      // Convert the draw timestamp to a Cardano slot using the network genesis.
      const genesisRes = await fetch(`${blockfrostBase}/genesis`, {
        headers: { project_id: blockfrostKey },
      });
      if (!genesisRes.ok) throw new Error(`Blockfrost /genesis failed: ${genesisRes.status}`);
      const genesis = await genesisRes.json() as { system_start: string; slot_length: number };

      const systemStartMs = new Date(genesis.system_start).getTime();
      const drawSlot = Math.floor((scheduledDrawDate.getTime() - systemStartMs) / (genesis.slot_length * 1000));
      log(`Draw slot: ${drawSlot}`);

      // Find the first block at or after the draw slot (not every slot has a block).
      let block: { hash: string; slot: number } | null = null;
      for (let s = drawSlot; s <= drawSlot + 200 && !block; s++) {
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
      let tx = lucid.newTx().payToAddress(winner.address, { lovelace: ownerShare });
      if (activeRenter) {
        tx = tx.payToAddress(activeRenter, { lovelace: renterShare });
      }
      tx = tx.addSigner(fullWalletAddress);

      const built  = await tx.complete();
      const signed = await built.sign().complete();
      const txHash = await signed.submit();

      log(`Done! Tx: ${txHash}`);
      setDrawTxHash(txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Draw failed:', err);
      setDrawError(msg);
    } finally {
      setIsDrawing(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="app-container">
      <header className="header">
        <h1 className="logo">
          <a href="https://donada.io" target="_blank" rel="noopener noreferrer">
            DONADA
          </a>
        </h1>

        <div className="user-controls">
          <button className="select-btn" onClick={handleSelectWallet}>
            {connectedWallet ? 'Disconnect Wallet' : 'Select Wallet'}
          </button>

          {connectedWallet ? (
            <div className="user-label">
              <div className="wallet-name">{connectedWallet.name} Connected</div>
              <div className="wallet-address">{walletAddress}</div>
            </div>
          ) : (
            <span className="user-label">No wallet</span>
          )}
        </div>
      </header>

      {wallets.length > 1 && !connectedWallet && (
        <div className="wallet-list">
          {wallets.map((w) => (
            <button key={w.key} className="select-btn" onClick={() => connectWallet(w.key)}>
              {w.name}
            </button>
          ))}
        </div>
      )}

      <main className="main-content">
        <div className="nft-card">
          <div className="nft-image">
            <div className="nft-image-inner">NFT IMAGE</div>
            <div className="nft-details">
              <p className="mint-name">Mint Name</p>
              <p className="policy-id">Policy ID</p>
              <p className="meta">lot x NFTs</p>
              <p className="meta">lot x entries</p>
            </div>
          </div>

          <div className="info-sections">
            <div className="left-section">
              <div className="info-block">
                <p className="label">Next Draw Date:</p>
                <p className="value">
                  {nextDrawDate
                    ? nextDrawDate.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })
                    : 'Loading...'}
                </p>
              </div>

              <hr className="section-break" />

              <div className="info-block">
                <p className="label">Countdown:</p>
                <p className="value">
                  {countdown
                    ? `${countdown.days}D ${countdown.hours}H ${countdown.minutes}M ${countdown.seconds}S`
                    : '00D 00H 00M 00S'}
                </p>
              </div>
            </div>

            <div className="right-section">
              <div className="action-block">
                <div className="action-text">Rent at price</div>
                <button
                  className="select-btn small"
                  disabled={!connectedWallet || !countdown || loadingListedNfts || isRenting}
                  onClick={loadListedNfts}
                >
                  {loadingListedNfts ? 'Loading...' : isRenting ? 'Renting...' : 'select'}
                </button>
              </div>

              {rentTxHash && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                    Rented! Tx: {rentTxHash.slice(0, 12)}…
                  </div>
                </div>
              )}
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
                  disabled={!connectedWallet || loadingOwnedNfts || !countdown || isListing}
                  onClick={() => loadOwnedNftsForListing()}
                >
                  {loadingOwnedNfts ? 'Loading...' : isListing ? 'Listing...' : 'select'}
                </button>
              </div>

              {listingTxHash && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                    Listed! Tx: {listingTxHash.slice(0, 12)}…
                  </div>
                </div>
              )}
              {listingError && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
                    Error: {listingError}
                  </div>
                </div>
              )}

              <hr className="section-break" />

              <div className="action-block">
                <div className="action-text">Cancel Listing</div>
                <button
                  className="select-btn small"
                  disabled={!connectedWallet || loadingCancelListings || isCancelling}
                  onClick={loadCancellableListings}
                >
                  {loadingCancelListings ? 'Loading...' : isCancelling ? 'Cancelling...' : 'select'}
                </button>
              </div>

              {cancelTxHash && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                    Cancelled! Tx: {cancelTxHash.slice(0, 12)}…
                  </div>
                </div>
              )}
              {cancelError && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
                    Error: {cancelError}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      {fullWalletAddress === PROJECT_WALLET_ADDRESS && (
        <section className="admin-draw">
          <h3>Admin — Execute Draw</h3>
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
              disabled={isDrawing || !drawPrizeAda || (!!countdown && drawPlanned)}
              onClick={handleExecuteDraw}
            >
              {isDrawing ? 'Executing…' : 'Execute Draw'}
            </button>
          </div>
          {countdown && (
            <p style={{ fontSize: '0.75rem', color: '#888' }}>
              Draw date not yet reached.
            </p>
          )}
          {drawLog.length > 0 && (
            <div style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
              {drawLog.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
          {drawTxHash && (
            <p style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
              Done! Tx: {drawTxHash.slice(0, 12)}…
            </p>
          )}
          {drawError && (
            <p style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all' }}>
              Error: {drawError}
            </p>
          )}
        </section>
      )}

      </main>

      <RentModal
        isOpen={showRentModal}
        mode={rentMode ? 'rent' : 'list'}
        nfts={rentMode ? listedNfts : ownedNfts}
        onClose={closeModal}
        onConfirm={rentMode ? handleRentNft : handleCreateListing}
        nextDrawDate={nextDrawDate}
      />

      <RentModal
        isOpen={showCancelModal}
        mode="cancel"
        nfts={cancelNfts}
        onClose={() => setShowCancelModal(false)}
        onConfirm={handleCancelNft}
        nextDrawDate={nextDrawDate}
      />
    </div>
  );
}
