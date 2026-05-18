/// <reference types="node" />
import React, { useState, useEffect } from 'react';
import RentModal from '../components/RentModal';
import { BrowserWallet } from '@meshsdk/core';
import { fetchNftMetadata } from '../utils/nftMetadata';
import { Lucid, Blockfrost, fromText, toText, Data, Constr, UTxO, fromHex, toHex, ProtocolParameters, C } from 'lucid-cardano';

// ── Contract constants ────────────────────────────────────────────────────────

const DONADA_POLICY_ID   = '21b36156acd6aaea44bf6b7c9ed3cbb818e74794a6081b32a267358a';
const PARTNER_POLICY_ID  = ''; // fill in partner policy ID when available
const POLICY_IDS         = [DONADA_POLICY_ID, PARTNER_POLICY_ID].filter(Boolean) as string[];
const PROJECT_WALLET_ADDRESS = 'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388';

// ── Validator loader — derives contract address from compiled plutus.json ─────

interface ValidatorSetup {
  contractAddress: string;
  compiledCode: string;
  validatorHash: string;
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
    compiledCode: spendValidator.compiledCode,
    validatorHash: spendValidator.hash,
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
    rental_fee:     BigInt(f[4] as bigint),
    draw_date:      BigInt(f[5] as bigint),
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
  lucid: Lucid,
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

  const txComplete = await lucid
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

  const signed = await txComplete.sign().complete();
  return signed.submit();
}

// ── PlutusV3 reference script helpers ────────────────────────────────────────
// CML's Script.new_plutus_v3 / ScriptRef.new / set_script_ref produce malformed
// CBOR that the node rejects. We build the script_ref CBOR directly instead.

// Strip the CBOR byte-string header from Aiken's single-CBOR compiledCode to
// get the raw flat-encoded UPLC bytes the node expects inside the script array.
function rawFlatBytes(compiledCode: string): Uint8Array {
  const bytes  = fromHex(compiledCode);
  const info   = bytes[0] & 0x1f;
  const offset = info <= 23 ? 1 : info === 24 ? 2 : info === 25 ? 3 : 5;
  return bytes.slice(offset);
}

function cborConcat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function cborByteStr(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  let hdr: Uint8Array;
  if      (len <= 23)     hdr = new Uint8Array([0x40 | len]);
  else if (len <= 0xff)   hdr = new Uint8Array([0x58, len]);
  else if (len <= 0xffff) hdr = new Uint8Array([0x59, len >> 8, len & 0xff]);
  else                    hdr = new Uint8Array([0x5a, (len>>>24)&0xff, (len>>>16)&0xff, (len>>>8)&0xff, len&0xff]);
  return cborConcat(hdr, bytes);
}

function cborUint(n: number): Uint8Array {
  if (n <= 23)     return new Uint8Array([n]);
  if (n <= 0xff)   return new Uint8Array([0x18, n]);
  if (n <= 0xffff) return new Uint8Array([0x19, n >> 8, n & 0xff]);
  return new Uint8Array([0x1a, (n>>>24)&0xff, (n>>>16)&0xff, (n>>>8)&0xff, n&0xff]);
}

// Builds a correct script_ref CBOR value for a PlutusV3 script:
//   #6.24(bytes .cbor [3, plutus_v3_bytes])
// where plutus_v3_bytes = CBOR byte string containing raw flat UPLC.
function buildPlutusV3ScriptRef(compiledCode: string): Uint8Array {
  const flat      = rawFlatBytes(compiledCode);
  const scriptArr = cborConcat(new Uint8Array([0x82, 0x03]), cborByteStr(flat));
  return cborConcat(new Uint8Array([0xD8, 0x18]), cborByteStr(scriptArr));
}

// Skips one CBOR item starting at pos; returns position of the next item.
function skipCborItem(data: Uint8Array, pos: number): number {
  const b = data[pos];
  const mt = b >> 5;
  const ai = b & 0x1f;
  let arg = 0, h = pos + 1;
  if      (ai <= 23) arg = ai;
  else if (ai === 24) { arg = data[pos+1]; h = pos+2; }
  else if (ai === 25) { arg = (data[pos+1]<<8)|data[pos+2]; h = pos+3; }
  else if (ai === 26) { arg = ((data[pos+1]<<24)|(data[pos+2]<<16)|(data[pos+3]<<8)|data[pos+4])>>>0; h = pos+5; }
  if (mt === 0 || mt === 1) return h;
  if (mt === 2 || mt === 3) {
    if (ai === 31) { let p = h; while (data[p] !== 0xff) p = skipCborItem(data, p); return p+1; }
    return h + arg;
  }
  if (mt === 4) {
    if (ai === 31) { let p = h; while (data[p] !== 0xff) p = skipCborItem(data, p); return p+1; }
    let p = h; for (let i = 0; i < arg; i++) p = skipCborItem(data, p); return p;
  }
  if (mt === 5) {
    if (ai === 31) { let p = h; while (data[p] !== 0xff) { p = skipCborItem(data, p); p = skipCborItem(data, p); } return p+1; }
    let p = h; for (let i = 0; i < arg*2; i++) p = skipCborItem(data, p); return p;
  }
  if (mt === 6) return skipCborItem(data, h);
  // mt === 7: simple/float/break — header size already encoded in h
  if (ai === 24) return pos+2;
  if (ai === 25) return pos+3;
  if (ai === 26) return pos+5;
  if (ai === 27) return pos+9;
  return h;
}

// Patches the placeholder output (addr, 2 ADA) in raw tx CBOR to inject a V3 script_ref.
// Handles both legacy [address, value] and post-Alonzo {0: address, 1: value} output formats.
function injectScriptRefField(txBytes: Uint8Array, contractAddress: string, compiledCode: string): Uint8Array {
  const addrCbor     = cborByteStr(C.Address.from_bech32(contractAddress).to_bytes());
  const lovelaceCbor = cborUint(25_000_000);
  const scriptRef    = buildPlutusV3ScriptRef(compiledCode);

  // Legacy array format:  [address, value]
  const needleA   = cborConcat(new Uint8Array([0x82]), addrCbor, lovelaceCbor);
  const replaceA  = cborConcat(new Uint8Array([0xa3, 0x00]), addrCbor, new Uint8Array([0x01]), lovelaceCbor, new Uint8Array([0x03]), scriptRef);

  // Post-Alonzo map format: {0: address, 1: value}
  const needleB   = cborConcat(new Uint8Array([0xa2, 0x00]), addrCbor, new Uint8Array([0x01]), lovelaceCbor);
  const replaceB  = cborConcat(new Uint8Array([0xa3, 0x00]), addrCbor, new Uint8Array([0x01]), lovelaceCbor, new Uint8Array([0x03]), scriptRef);

  for (const [needle, replacement] of [[needleA, replaceA], [needleB, replaceB]] as [Uint8Array, Uint8Array][]) {
    for (let i = 0; i <= txBytes.length - needle.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) if (txBytes[i+j] !== needle[j]) { ok = false; break; }
      if (ok) return cborConcat(txBytes.slice(0, i), replacement, txBytes.slice(i + needle.length));
    }
  }
  throw new Error('injectScriptRefField: placeholder output not found in tx bytes');
}

// CML's to_bytes() may produce a 3-element tx [body, witnesses, metadata] without
// is_valid. Conway nodes require 4 elements. Upgrade if needed.
function ensureFourElement(txBytes: Uint8Array): Uint8Array {
  const count = txBytes[0] & 0x1f; // lower 5 bits = definite array length
  if (count === 4) return txBytes;
  const bodyEnd    = skipCborItem(txBytes, 1);
  const witnessEnd = skipCborItem(txBytes, bodyEnd);
  return cborConcat(
    new Uint8Array([0x84]),            // array(4) header
    txBytes.slice(1, witnessEnd),      // body + original witnesses
    new Uint8Array([0xf5]),            // is_valid = true
    txBytes.slice(witnessEnd),         // metadata (null or actual)
  );
}

// Replaces the witness set in a (4-element) raw transaction CBOR with the wallet-provided one.
function assembleTx(patchedTxBytes: Uint8Array, witnessSetHex: string): Uint8Array {
  const bodyEnd    = skipCborItem(patchedTxBytes, 1);
  const witnessEnd = skipCborItem(patchedTxBytes, bodyEnd);
  console.log('[assembleTx] bodyEnd:', bodyEnd, 'witnessEnd:', witnessEnd, 'total:', patchedTxBytes.length);
  console.log('[assembleTx] byte at bodyEnd (should be a0/witness map):', '0x' + patchedTxBytes[bodyEnd]?.toString(16));
  console.log('[assembleTx] byte at witnessEnd (should be f5/true):', '0x' + patchedTxBytes[witnessEnd]?.toString(16));
  console.log('[assembleTx] last 6 bytes of patched:', Array.from(patchedTxBytes.slice(-6)).map(x => x.toString(16).padStart(2,'0')).join(' '));
  return cborConcat(
    patchedTxBytes.slice(0, bodyEnd),
    fromHex(witnessSetHex),
    patchedTxBytes.slice(witnessEnd),
  );
}

// Injects a PlutusV3 script (key 7) into the witness set of a signed Conway transaction.
// Safe to call after signing because signatures only cover the transaction body, not the witness set.
function injectPlutusV3ScriptIntoWitnessSet(txBytes: Uint8Array, compiledCode: string): Uint8Array {
  const bodyEnd    = skipCborItem(txBytes, 1);
  const witnessEnd = skipCborItem(txBytes, bodyEnd);
  const witnessBytes = txBytes.slice(bodyEnd, witnessEnd);
  const count = witnessBytes[0] & 0x1f;
  if (count >= 23) throw new Error('Too many witness-set entries to inline-patch');
  const scriptBytes = fromHex(compiledCode);
  const newEntry = cborConcat(
    new Uint8Array([0x07]),
    new Uint8Array([0x81]),
    cborByteStr(scriptBytes),
  );
  const patchedWitness = cborConcat(
    new Uint8Array([0xa0 | (count + 1)]),
    witnessBytes.slice(1),
    newEntry,
  );
  return cborConcat(txBytes.slice(0, bodyEnd), patchedWitness, txBytes.slice(witnessEnd));
}

// Returns a CML TransactionOutput built from raw CBOR, bypassing CML's V3 APIs.
// Output format: { 0: address, 1: lovelace, 3: script_ref }
function buildRefScriptOutput(contractAddress: string, lovelace: number, compiledCode: string): unknown {
  const addrBytes  = C.Address.from_bech32(contractAddress).to_bytes();
  const scriptRef  = buildPlutusV3ScriptRef(compiledCode);
  const outputCbor = cborConcat(
    new Uint8Array([0xa3, 0x00]), cborByteStr(addrBytes),
    new Uint8Array([0x01]),       cborUint(lovelace),
    new Uint8Array([0x03]),       scriptRef,
  );
  return C.TransactionOutput.from_bytes(outputCbor);
}

function buildV3RefInput(
  txHash: string,
  outputIndex: number,
  compiledCode: string,
  contractAddress: string
): unknown {
  const output  = buildRefScriptOutput(contractAddress, 2_000_000, compiledCode);
  const txInput = C.TransactionInput.new(
    C.TransactionHash.from_hex(txHash),
    C.BigNum.from_str(outputIndex.toString())
  );
  return C.TransactionUnspentOutput.new(txInput, output as ReturnType<typeof C.TransactionOutput.from_bytes>);
}

async function findV3RefScriptUtxo(
  contractAddress: string,
  validatorHash: string,
  network: Network
): Promise<{ txHash: string; outputIndex: number } | null> {
  const { url, apiKey } = blockfrostConfig(network);
  try {
    const res = await fetch(`${url}/addresses/${contractAddress}/utxos`, {
      headers: { project_id: apiKey },
    });
    if (!res.ok) return null;
    const utxos = await res.json() as Array<{ tx_hash: string; output_index: number; reference_script_hash?: string }>;
    const found = utxos.find(u => u.reference_script_hash === validatorHash);
    if (!found) return null;
    return { txHash: found.tx_hash, outputIndex: found.output_index };
  } catch { return null; }
}

const hex8 = (b: Uint8Array) => Array.from(b.slice(0, 8)).map(x => x.toString(16).padStart(2, '0')).join(' ');

async function deployV3RefScript(
  lucid: Lucid,
  compiledCode: string,
  contractAddress: string,
  cip30Api: unknown,
): Promise<string> {
  // ── Step 1: build placeholder tx (CML handles selection, fee, change) ─────────
  const txComplete = await lucid.newTx()
    .payToAddress(contractAddress, { lovelace: 25_000_000n })
    .complete();

  const rawBytes = txComplete.txComplete.to_bytes();
  console.log('[deploy-v3] Step 1 — raw tx from CML');
  console.log('  first 8 bytes:', hex8(rawBytes));
  console.log('  first byte 0x' + rawBytes[0].toString(16), '→ array count:', rawBytes[0] & 0x1f);
  console.log('  total length:', rawBytes.length);

  // ── Step 2: ensure 4-element Conway format ────────────────────────────────────
  const txBytes = ensureFourElement(rawBytes);
  console.log('[deploy-v3] Step 2 — after ensureFourElement');
  console.log('  first 8 bytes:', hex8(txBytes));
  console.log('  first byte 0x' + txBytes[0].toString(16), '→ array count:', txBytes[0] & 0x1f);

  // ── Step 3: CBOR-patch the placeholder output to inject the V3 script_ref ─────
  const addrBytes = C.Address.from_bech32(contractAddress).to_bytes();
  console.log('[deploy-v3] Step 3 — contract address bytes (', addrBytes.length, 'bytes):', hex8(addrBytes));

  const patchedBytes = injectScriptRefField(txBytes, contractAddress, compiledCode);
  console.log('[deploy-v3]  after injectScriptRefField');
  console.log('  first 8 bytes:', hex8(patchedBytes));
  console.log('  size delta:', patchedBytes.length - txBytes.length, 'bytes (expect > 0)');

  // ── Step 4: CIP-30 sign the patched tx body hash ──────────────────────────────
  const patchedHex = toHex(patchedBytes);
  console.log('[deploy-v3] Step 4 — calling wallet signTx');
  const witnessHex = await (cip30Api as { signTx(tx: string, partial: boolean): Promise<string> })
    .signTx(patchedHex, false);
  console.log('[deploy-v3]  witness returned, first 16 hex chars:', witnessHex.slice(0, 16));

  // ── Step 5: stitch witness into patched tx ────────────────────────────────────
  const finalBytes = assembleTx(patchedBytes, witnessHex);
  console.log('[deploy-v3] Step 5 — final assembled tx');
  console.log('  first 8 bytes:', hex8(finalBytes));
  console.log('  first byte 0x' + finalBytes[0].toString(16), '→ array count:', finalBytes[0] & 0x1f);
  console.log('  total length:', finalBytes.length);

  if (finalBytes[0] !== 0x84) {
    throw new Error(`[deploy-v3] ABORT: final tx first byte is 0x${finalBytes[0].toString(16)}, not 0x84 (array-of-4). Check console.`);
  }

  const finalHex = toHex(finalBytes);
  console.log('[deploy-v3] Final tx hex (FULL):', finalHex);

  // ── Step 6: try wallet submitTx first (wallet relays to its own node) ─────────
  try {
    console.log('[deploy-v3] Step 6a — submitting via wallet api.submitTx');
    const walletApi = cip30Api as { submitTx?(tx: string): Promise<string> };
    if (typeof walletApi.submitTx === 'function') {
      const walletTxHash = await walletApi.submitTx(finalHex);
      console.log('[deploy-v3] Wallet submit success! txHash:', walletTxHash);
      return walletTxHash;
    }
    console.log('[deploy-v3] wallet.submitTx not available, falling back to Blockfrost');
  } catch (walletErr: unknown) {
    const msg = walletErr instanceof Error ? walletErr.message : JSON.stringify(walletErr);
    console.warn('[deploy-v3] Wallet submit failed:', msg);
  }

  // ── Step 6b: fallback — direct Blockfrost fetch ───────────────────────────────
  console.log('[deploy-v3] Step 6b — submitting via direct Blockfrost fetch');
  const { url: bfUrl, apiKey: bfKey } = blockfrostConfig(lucid.network as Network);
  const submitRes = await fetch(`${bfUrl}/tx/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/cbor', project_id: bfKey },
    body: finalBytes,
  });
  const submitJson = await submitRes.json();
  console.log('[deploy-v3] Blockfrost response status:', submitRes.status);
  if (!submitRes.ok) throw new Error(JSON.stringify(submitJson));
  return submitJson as string;
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
  lucid: Lucid,
  v3RefUtxo: { txHash: string; outputIndex: number } | null
): Promise<InteractionResult> {
  if (!v3RefUtxo) {
    throw new Error('V3 reference script not deployed — use the admin panel to deploy it first.');
  }
  const { contractAddress, compiledCode } = validator;
  const rentalUtxo = await fetchRentalUtxo(nftAssetName, contractAddress, lucid);
  const datum = decodeDatum(rentalUtxo, lucid);

  if (datum.renter !== null) {
    throw new Error(`"${nftAssetName}" already has a registered renter.`);
  }
  if (BigInt(Date.now()) >= datum.draw_date) {
    throw new Error(`The draw date for "${nftAssetName}" has already passed.`);
  }

  const ownerShare   = datum.rental_fee * BigInt(90) / BigInt(100);
  const projectShare = datum.rental_fee - ownerShare;
  const updatedDatum: RentalDatum = { ...datum, renter: renterAddress };
  const validToMs = Date.now() + 5 * 60 * 1000;

  const tx = lucid
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
    .validTo(validToMs);

  (tx as any).txBuilder.add_reference_input(
    buildV3RefInput(v3RefUtxo.txHash, v3RefUtxo.outputIndex, compiledCode, contractAddress)
  );

  const txComplete = await tx.complete({ nativeUplc: false });
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
  lucid: Lucid,
  v3RefUtxo: { txHash: string; outputIndex: number } | null,
  cip30Api?: unknown,
): Promise<InteractionResult> {
  const { contractAddress, compiledCode } = validator;
  const listingUtxo = await fetchRentalUtxo(nftAssetName, contractAddress, lucid);
  const datum = decodeDatum(listingUtxo, lucid);

  if (datum.renter !== null) {
    throw new Error(`"${nftAssetName}" already has a registered renter — cannot cancel.`);
  }

  const tx = lucid
    .newTx()
    .collectFrom([listingUtxo], Data.to(new Constr(0, [])))
    .addSigner(ownerAddress);

  if (v3RefUtxo) {
    (tx as any).txBuilder.add_reference_input(
      buildV3RefInput(v3RefUtxo.txHash, v3RefUtxo.outputIndex, compiledCode, contractAddress)
    );
  }

  const txComplete = await tx.complete({ nativeUplc: false });
  const signed = await txComplete.sign().complete();

  let txHash: string;
  if (v3RefUtxo) {
    txHash = await signed.submit();
  } else {
    // No reference script on-chain: attach the PlutusV3 script inline in the witness set.
    // Signatures remain valid because they only cover the transaction body.
    const rawBytes = ensureFourElement((signed as any).txSigned.to_bytes());
    const patchedBytes = injectPlutusV3ScriptIntoWitnessSet(rawBytes, compiledCode);
    const api = cip30Api as { submitTx: (hex: string) => Promise<string> } | undefined;
    if (!api?.submitTx) throw new Error('Wallet API unavailable for inline-script submission.');
    txHash = await api.submitTx(toHex(patchedBytes));
  }

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

const CUTOFF_MS = 0 * 60 * 60 * 1000; // hours before draw when rental actions lock

// ── Component ─────────────────────────────────────────────────────────────────

export default function DonadaPlatform() {
  // Network (toggled in admin panel; defaults to Mainnet)
  const [network, setNetwork] = useState<Network>('Preview');

  // Draw date / countdown
  const [nextDrawDate, setNextDrawDate] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [drawPlanned, setDrawPlanned] = useState(false);
  const [withinCutoff, setWithinCutoff] = useState(false);
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
  const [loadingNfts, setLoadingNfts] = useState(false);
  const [isListing, setIsListing] = useState(false);
  const [listingTxHash, setListingTxHash] = useState<string | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);

  // Renter flow
  const [listedNfts, setListedNfts] = useState<NftAsset[]>([]);
  const [loadingListedNfts, setLoadingListedNfts] = useState(false);
  const [isRenting, setIsRenting] = useState(false);
  const [rentTxHash, setRentTxHash] = useState<string | null>(null);
  const [rentError, setRentError] = useState<string | null>(null);

  // Owner's active listings at the contract (cancel / reclaim flow)
  const [activeOwnerListings, setActiveOwnerListings] = useState<Array<{ utxo: UTxO; datum: RentalDatum }>>([]);
  const [loadingActiveListings, setLoadingActiveListings] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelNfts, setCancelNfts] = useState<NftAsset[]>([]);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelTxHash, setCancelTxHash] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // V3 reference script (deployed once per network; required for rent/cancel flows)
  const [v3RefUtxo, setV3RefUtxo] = useState<{ txHash: string; outputIndex: number } | null>(null);
  const [loadingRefScript, setLoadingRefScript] = useState(false);
  const [isDeployingRefScript, setIsDeployingRefScript] = useState(false);
  const [deployRefScriptError, setDeployRefScriptError] = useState<string | null>(null);

  // Admin draw flow (only shown when project wallet is connected)
  const [drawPrizeAda, setDrawPrizeAda] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawTxHash, setDrawTxHash] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [drawLog, setDrawLog] = useState<string[]>([]);

  // Invalidate validator cache whenever the network changes so the address is re-derived
  useEffect(() => { _validatorCache = null; }, [network]);

  // Check whether the V3 reference script has been deployed on the current network
  useEffect(() => {
    setV3RefUtxo(null);
    const load = async () => {
      setLoadingRefScript(true);
      try {
        const lucid = await initLucid(network);
        const { contractAddress, validatorHash } = await loadRentalValidator(lucid);
        const ref = await findV3RefScriptUtxo(contractAddress, validatorHash, network);
        setV3RefUtxo(ref);
      } catch (err) {
        console.error('Failed to check V3 reference script:', err);
      } finally {
        setLoadingRefScript(false);
      }
    };
    load();
  }, [network]);

  // ----- Auto-load owner's active listings whenever wallet or network changes -----
  useEffect(() => {
    if (!fullWalletAddress) { setActiveOwnerListings([]); return; }
    const load = async () => {
      setLoadingActiveListings(true);
      try {
        const lucid = await initLucid(network);
        const { contractAddress } = await loadRentalValidator(lucid);
        const utxos = await lucid.utxosAt(contractAddress);
        const mine = utxos.flatMap(u => {
          if (!u.datum) return [];
          try {
            const datum = decodeDatum(u, lucid);
            if (datum.owner !== fullWalletAddress) return [];
            return [{ utxo: u, datum }];
          } catch { return []; }
        });
        setActiveOwnerListings(mine);
      } catch (err) {
        console.error('Failed to load active listings:', err);
      } finally {
        setLoadingActiveListings(false);
      }
    };
    load();
  }, [fullWalletAddress, network]);

  // ----- Load next draw date from CSV -----
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/data/drawDates.csv');
        const text = await res.text();
        const lines = text.trim().split('\n').slice(1);
        const now = new Date();

        const parseRow = (line: string): { date: Date; planned: boolean } | null => {
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
          return { date: new Date(Date.UTC(year, month - 1, day, hour + 5, minute)), planned };
        };

        const allRows = lines
          .map(parseRow)
          .filter((r): r is { date: Date; planned: boolean } => r !== null)
          .sort((a, b) => a.date.getTime() - b.date.getTime());

        // scheduledDrawDate: nearest date to now (past or future) — used for entropy.
        // nextDrawDate: nearest future date only — used for countdown display.
        const nearest = allRows.reduce<{ date: Date; planned: boolean } | null>((best, r) => {
          if (!best) return r;
          return Math.abs(r.date.getTime() - now.getTime()) < Math.abs(best.date.getTime() - now.getTime()) ? r : best;
        }, null);
        if (nearest) {
          setScheduledDrawDate(nearest.date);
          setDrawPlanned(nearest.planned);
        }

        const futureDates = allRows.filter(r => r.date > now);
        if (futureDates.length > 0) setNextDrawDate(futureDates[0].date);
      } catch (err) {
        console.error('Failed to load draw dates', err);
      }
    };
    load();
  }, []);

  // ----- Countdown ticker -----
  useEffect(() => {
    if (!nextDrawDate) return;
    const tick = () => {
      const diff = nextDrawDate.getTime() - Date.now();
      setWithinCutoff(diff <= CUTOFF_MS);
      if (diff <= 0) { setCountdown(null); clearInterval(interval); return; }
      const totalSeconds = Math.floor(diff / 1000);
      setCountdown({
        days:    Math.floor(totalSeconds / (24 * 3600)),
        hours:   Math.floor((totalSeconds % (24 * 3600)) / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
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
  const loadNftsForPolicy = async () => {
    if (!connectedWallet) return;
    try {
      setLoadingNfts(true);
      const assets = await connectedWallet.wallet.getAssets();
      const filtered = assets.filter((a: NftAsset) => POLICY_IDS.includes(a.policyId));
      const enriched: NftAsset[] = await Promise.all(
        filtered.map((a: NftAsset) => fetchNftMetadata(a.policyId, a.assetName, network))
      );
      setOwnedNfts(enriched);
      setRentMode(false);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load NFTs', err);
    } finally {
      setLoadingNfts(false);
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
  const handleListNft = async ({ nft, rentalPrice }: { nft: NftAsset; rentalPrice: string }) => {
    if (!fullWalletAddress || !nextDrawDate || !connectedWallet) return;
    closeModal();
    setIsListing(true);
    setListingTxHash(null);
    setListingError(null);

    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);

      const validator = await loadRentalValidator(lucid);
      const txHash = await submitListing(
        nft.assetName,
        fullWalletAddress,
        rentalPrice,
        Math.floor(nextDrawDate.getTime()),
        validator.contractAddress,
        lucid,
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
      const result = await rentNft(nft.assetName, fullWalletAddress, validator, lucid, v3RefUtxo);
      setRentTxHash(result.txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to rent NFT:', err);
      setRentError(msg);
    } finally {
      setIsRenting(false);
    }
  };

  // ----- Owner: open the modify-listing carousel modal -----
  const loadCancellableListings = async () => {
    const cancellable = activeOwnerListings.filter(l => l.datum.renter === null);
    const enriched: NftAsset[] = await Promise.all(
      cancellable.map(l => fetchNftMetadata(l.datum.nft_policy, l.datum.nft_asset_name, network))
    );
    setCancelNfts(enriched);
    setShowCancelModal(true);
  };

  const closeCancelModal = () => setShowCancelModal(false);

  // ----- Owner: confirm cancel modal → submit CancelListing transaction -----
  const handleCancelNft = async ({ nft }: { nft: NftAsset; rentalPrice: string }) => {
    if (!fullWalletAddress || !connectedWallet) return;
    closeCancelModal();
    setIsCancelling(true);
    setCancelTxHash(null);
    setCancelError(null);

    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);
      const validator = await loadRentalValidator(lucid);
      const result = await cancelListingNft(nft.assetName, fullWalletAddress, validator, lucid, v3RefUtxo, connectedWallet.api);
      setCancelTxHash(result.txHash);
      setActiveOwnerListings(prev => prev.filter(l => l.datum.nft_asset_name !== nft.assetName));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Cancel failed:', err);
      setCancelError(msg);
    } finally {
      setIsCancelling(false);
    }
  };

  // ----- Admin: deploy V3 reference script (one-time per network) -----
  const handleDeployRefScript = async () => {
    if (!connectedWallet) return;
    setIsDeployingRefScript(true);
    setDeployRefScriptError(null);
    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lucid.selectWallet(connectedWallet.api);
      const { contractAddress, compiledCode, validatorHash } = await loadRentalValidator(lucid);
      const txHash = await deployV3RefScript(lucid, compiledCode, contractAddress, connectedWallet.api);
      console.log(`V3 ref script deploy submitted. Hash: ${validatorHash}, Tx: ${txHash}`);
      // Poll for the confirmed UTxO — outputIndex is not predictable so we can't
      // set it optimistically; wait for Blockfrost to index it.
      const net = network;
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const ref = await findV3RefScriptUtxo(contractAddress, validatorHash, net);
          if (ref) { setV3RefUtxo(ref); clearInterval(poll); }
        } catch { /* continue */ }
        if (attempts >= 12) clearInterval(poll); // give up after ~3 min
      }, 15_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to deploy V3 reference script:', err);
      setDeployRefScriptError(msg);
    } finally {
      setIsDeployingRefScript(false);
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
                  disabled={!connectedWallet || !countdown || withinCutoff || loadingListedNfts || isRenting}
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
                <div className="action-text">Rent out your NFT</div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    className="select-btn small"
                    disabled={!connectedWallet || loadingNfts || !countdown || withinCutoff || isListing}
                    onClick={() => loadNftsForPolicy()}
                  >
                    {loadingNfts ? 'Loading...' : isListing ? 'Listing...' : 'select'}
                  </button>
                  {!loadingActiveListings && activeOwnerListings.some(l => l.datum.renter === null) && (
                    <button
                      className="select-btn small"
                      disabled={isCancelling}
                      onClick={loadCancellableListings}
                    >
                      Modify Listing
                    </button>
                  )}
                </div>
              </div>

              {withinCutoff && (
                <div className="action-block">
                  <div className="action-text" style={{ fontSize: '0.75rem', opacity: 0.7, fontStyle: 'italic' }}>
                    Snapshot taken — rental actions are disabled until this draw concludes.
                  </div>
                </div>
              )}

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
          <div className="action-block" style={{ marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem' }}>V3 script: </span>
            {loadingRefScript ? (
              <span style={{ fontSize: '0.8rem' }}>checking…</span>
            ) : v3RefUtxo ? (
              <span style={{ fontSize: '0.8rem', color: '#4caf50' }}>deployed ({v3RefUtxo.txHash.slice(0, 8)}…)</span>
            ) : (
              <>
                <span style={{ fontSize: '0.8rem', color: '#f44336' }}>not deployed </span>
                <button
                  className="select-btn"
                  style={{ padding: '0.2rem 0.75rem', fontSize: '0.8rem' }}
                  disabled={isDeployingRefScript}
                  onClick={handleDeployRefScript}
                >
                  {isDeployingRefScript ? 'Deploying…' : 'Deploy'}
                </button>
              </>
            )}
            {deployRefScriptError && (
              <div style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all', marginTop: '0.25rem' }}>
                {deployRefScriptError}
              </div>
            )}
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
        onConfirm={rentMode ? handleRentNft : handleListNft}
        nextDrawDate={nextDrawDate}
      />

      <RentModal
        isOpen={showCancelModal}
        mode="cancel"
        nfts={cancelNfts}
        onClose={closeCancelModal}
        onConfirm={handleCancelNft}
        nextDrawDate={nextDrawDate}
      />
    </div>
  );
}
