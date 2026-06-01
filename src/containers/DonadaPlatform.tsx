/// <reference types="node" />
import React, { useState, useEffect, useRef } from 'react';
import RentModal from '../components/RentModal';
import { BrowserWallet } from '@meshsdk/core';
import { fetchNftMetadata } from '../utils/nftMetadata';
import { Lucid, Blockfrost, fromText, toText, Data, Constr, UTxO, C, fromHex, toHex, ProtocolParameters, applyDoubleCborEncoding } from 'lucid-cardano';

// ── Contract constants ────────────────────────────────────────────────────────

// Legacy policy ID (DonodaNFT001–003): 21b36156acd6aaea44bf6b7c9ed3cbb818e74794a6081b32a267358a
const DONADA_POLICY_ID   = '6c8b99e48576746aa1efa39cc952b3a66dfb76a9fcf82aaca5a1ab5c';

// Collection name — hardcoded for now. Future: fetch first asset under the policy
// via Blockfrost, read onchain_metadata.name, strip trailing token-number suffix
// (e.g. "DONADA Test 000" → "DONADA Test") to derive the name dynamically.
const COLLECTION_NAME    = 'DONADA Test';
const PARTNER_POLICY_ID  = ''; // fill in partner policy ID when available
const POLICY_IDS         = [DONADA_POLICY_ID, PARTNER_POLICY_ID].filter(Boolean) as string[];
const PROJECT_WALLET_ADDRESS = 'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388';

// ── Validator loader — derives contract address from compiled plutus.json ─────

interface ValidatorSetup {
  contractAddress: string;
  compiledCode: string; // raw single-CBOR hex for witness set injection
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
    // PlutusV3 is NOT truncated — patchLucidV3CostModels stores all entries in _v3OnlyCostmdls
    // for hash_script_data, and the node uses all 350 entries when computing the expected hash.
    return { ...params, costModels: patched as ProtocolParameters['costModels'] };
  }
}

// C.Int.new only accepts non-negative BigNum; V3 cost models include negative values.
function toCmlInt(value: number): any {
  const abs = Math.abs(Math.round(value));
  return value < 0
    ? (C as any).Int.new_negative(C.BigNum.from_str(abs.toString()))
    : (C as any).Int.new(C.BigNum.from_str(abs.toString()));
}

// CML's CostModel.new_plutus_v3() and Costmdls.from_bytes() are both capped at 179
// entries in this version of lucid-cardano, but Preview testnet has 350 V3 cost model
// entries. We bypass CML entirely: build the language-views CBOR manually and compute
// hash_script_data ourselves via blake2b-256 on the raw preimage bytes.
// Language views CBOR format for V3: {2: [cost0, cost1, ..., costN-1]}
function buildV3LangViewsCbor(costs: number[]): Uint8Array {
  function pushCborInt(buf: number[], val: number): void {
    const n = val >= 0 ? val : -val - 1;
    const major = val >= 0 ? 0x00 : 0x20;
    if (n <= 23)          buf.push(major | n);
    else if (n <= 0xFF)   buf.push(major | 0x18, n);
    else if (n <= 0xFFFF) buf.push(major | 0x19, (n >> 8) & 0xFF, n & 0xFF);
    else                  buf.push(major | 0x1A, (n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
  }
  const buf: number[] = [];
  buf.push(0xA1, 0x02);    // map(1), key 2 = PlutusV3
  const len = costs.length;
  if (len <= 23)        buf.push(0x80 | len);
  else if (len <= 0xFF) buf.push(0x98, len);
  else                  buf.push(0x99, (len >> 8) & 0xFF, len & 0xFF);
  for (const c of costs) pushCborInt(buf, Math.round(c));
  return new Uint8Array(buf);
}

// hash_script_data preimage = redeemers_cbor || 0xA0 (empty datums map) || lang_views_cbor
// Blake2b-256 of the concatenation, wrapped in ScriptDataHash.
function hashScriptDataV3(redeemers: any, v3Costs: number[]): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const b2b = require('blake2b') as any;
  const rdmrs     = redeemers.to_bytes() as Uint8Array;
  const langViews = buildV3LangViewsCbor(v3Costs);
  // Preimage = redeemers || lang_views. No datums section when datums is None —
  // confirmed by decoding the node's error blob: redeemers end immediately before A1 02.
  const preimage = new Uint8Array(rdmrs.length + langViews.length);
  preimage.set(rdmrs, 0);
  preimage.set(langViews, rdmrs.length);
  const hash = b2b(32).update(preimage).digest() as Uint8Array;
  return (C as any).ScriptDataHash.from_bytes(hash);
}

// V3 cost model raw values (all 350 entries) stored after initLucid.
// _linearFee and _exUnitPrices are stored for min_fee computation.
// V3 is NOT in txBuilderConfig — including it causes CML to panic inside
// add_inputs_from/balance because the V3 script is never passed to txBuilder.
let _v3CostValues: number[] | null = null;
let _linearFee:    any = null; // C.LinearFee
let _exUnitPrices: any = null; // C.ExUnitPrices

async function patchLucidV3CostModels(lucid: Lucid, network: Network): Promise<void> {
  const provider = (lucid as any).provider;
  const pp = await provider.getProtocolParameters();
  const cm = (pp.costModels ?? {}) as Record<string, Record<string, number>>;

  const slotConfig = network === 'Mainnet'
    ? { zeroTime: 1596059091000, zeroSlot: 4492800, slotLength: 1000 }
    : { zeroTime: 1666656000000, zeroSlot: 0, slotLength: 1000 };

  // V3-only cost models — hash_script_data must include ONLY the languages present.
  // Using V1+V2+V3 when only a V3 script is in the tx produces a different hash.
  if (cm.PlutusV3) {
    _v3CostValues = Object.values(cm.PlutusV3) as number[];
  } else {
    console.warn('[V3Patch] no PlutusV3 cost models in protocol params');
  }

  // ── Build txBuilderConfig with V1+V2 ONLY ────────────────────────────────────
  // Omitting V3 here prevents CML from looking up the V3 script during coin selection /
  // fee estimation — which would throw null because we never call add_plutus_v3_script().
  const configCostmdls = (C as any).Costmdls.new();

  const cfgV1 = (C as any).CostModel.new();
  Object.values(cm.PlutusV1 ?? {}).forEach((cost: number, i: number) => cfgV1.set(i, toCmlInt(cost)));
  configCostmdls.insert((C as any).Language.new_plutus_v1(), cfgV1);

  const cfgV2 = (C as any).CostModel.new_plutus_v2();
  Object.values(cm.PlutusV2 ?? {}).forEach((cost: number, i: number) => cfgV2.set(i, toCmlInt(cost)));
  configCostmdls.insert((C as any).Language.new_plutus_v2(), cfgV2);

  _linearFee    = C.LinearFee.new(C.BigNum.from_str(pp.minFeeA.toString()), C.BigNum.from_str(pp.minFeeB.toString()));
  _exUnitPrices = (C as any).ExUnitPrices.from_float(pp.priceMem, pp.priceStep);

  (lucid as any).txBuilderConfig = (C as any).TransactionBuilderConfigBuilder.new()
    .coins_per_utxo_byte(C.BigNum.from_str(pp.coinsPerUtxoByte.toString()))
    .fee_algo(_linearFee)
    .key_deposit(C.BigNum.from_str(pp.keyDeposit.toString()))
    .pool_deposit(C.BigNum.from_str(pp.poolDeposit.toString()))
    .max_tx_size(pp.maxTxSize)
    .max_value_size(pp.maxValSize)
    .collateral_percentage(pp.collateralPercentage)
    .max_collateral_inputs(pp.maxCollateralInputs)
    .max_tx_ex_units(C.ExUnits.new(C.BigNum.from_str(pp.maxTxExMem.toString()), C.BigNum.from_str(pp.maxTxExSteps.toString())))
    .ex_unit_prices(_exUnitPrices)
    .slot_config(C.BigNum.from_str(slotConfig.zeroTime.toString()), C.BigNum.from_str(slotConfig.zeroSlot.toString()), slotConfig.slotLength)
    .blockfrost((C as any).Blockfrost.new((provider?.url ?? '') + '/utils/txs/evaluate', provider?.projectId ?? ''))
    .costmdls(configCostmdls)
    .build();
}

async function initLucid(network: Network): Promise<Lucid> {
  const { url, apiKey } = blockfrostConfig(network);
  const lucid = await Lucid.new(new ConwayCompatBlockfrost(url, apiKey), network);
  await patchLucidV3CostModels(lucid, network);
  return lucid;
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

// ── V3 spend transaction helpers ──────────────────────────────────────────────
//
// lucid's construct() throws null for V3 scripts (CML lacks V3 support).
// lucid's witnessSetBuilder silently drops V3 scripts (no add_plutus_v3_script).
// We bypass both by building manually: add_input → balance → build_tx → assemble
// witness set directly → sign via wallet API → submit via provider.

function utxoToCml(utxo: UTxO): any {
  const address = (() => {
    try { return C.Address.from_bech32(utxo.address); }
    catch { return (C as any).ByronAddress.from_base58(utxo.address).to_address(); }
  })();

  const multiAsset = (C as any).MultiAsset.new();
  const lovelace = utxo.assets['lovelace'];
  const units = Object.keys(utxo.assets);
  const policies = Array.from(new Set(
    units.filter(u => u !== 'lovelace').map(u => u.slice(0, 56))
  )) as string[];

  policies.forEach(policy => {
    const policyUnits = units.filter(u => u.slice(0, 56) === policy);
    const assetMap = (C as any).Assets.new();
    policyUnits.forEach(unit => {
      assetMap.insert(
        (C as any).AssetName.new(fromHex(unit.slice(56))),
        C.BigNum.from_str(utxo.assets[unit].toString()),
      );
    });
    multiAsset.insert((C as any).ScriptHash.from_bytes(fromHex(policy)), assetMap);
  });

  const value = C.Value.new(C.BigNum.from_str(lovelace ? lovelace.toString() : '0'));
  if (units.length > 1 || !lovelace) value.set_multiasset(multiAsset);

  const output = C.TransactionOutput.new(address, value);
  if (utxo.datumHash) {
    output.set_datum((C as any).Datum.new_data_hash(
      (C as any).DataHash.from_bytes(fromHex(utxo.datumHash))
    ));
  } else if (utxo.datum) {
    output.set_datum((C as any).Datum.new_data(
      (C as any).Data.new(C.PlutusData.from_bytes(fromHex(utxo.datum)))
    ));
  }

  return (C as any).TransactionUnspentOutput.new(
    (C as any).TransactionInput.new(
      (C as any).TransactionHash.from_bytes(fromHex(utxo.txHash)),
      C.BigNum.from_str(utxo.outputIndex.toString()),
    ),
    output,
  );
}

function findCollateral(walletUtxos: any): any | null {
  for (let i = 0; i < walletUtxos.len(); i++) {
    const u = walletUtxos.get(i);
    if (!u.output().amount().multiasset()) return u;
  }
  return null;
}

// Build, sign, and submit a Plutus V3 spend transaction.
//
// Non-script tasks (addSigner, payTo, validTo) must be queued on txObj before calling.
// collectFrom must NOT be queued — the script input is added here manually.
//
// Fee strategy:
//   CML's PlutusWitness.new(PlutusData) carries no ExUnits, so balance() computes the
//   fee for 0 ExUnits (F0).  After build_tx() we construct synthetic 2M-mem/1B-step
//   redeemers and call the standalone min_fee(mockTx) to get the correct fee F1.
//   We then rebuild the TransactionBody with F1 and the change output reduced by (F1-F0).
//
// Script injection:
//   V3 scripts are set directly on TransactionWitnessSet — witnessSetBuilder has no
//   add_plutus_v3_script() method and silently drops them via add_existing().
async function completeV3Tx(
  txObj: any,
  scriptUtxo: UTxO,
  redeemerHex: string,
  lucid: Lucid,
  compiledCode: string,
): Promise<string> {
  if (!_v3CostValues || !_linearFee || !_exUnitPrices) {
    throw new Error('V3 cost models / fee params not initialised — call initLucid first');
  }

  let task = (txObj as any).tasks.shift();
  while (task) {
    await task(txObj as any);
    task = (txObj as any).tasks.shift();
  }

  // Add the script input.  PlutusWitness.new(PlutusData) is what CML accepts; ExUnits
  // will be 0 in the redeemers from build_tx(), which we fix up after balance().
  const cmlScriptUtxo = utxoToCml(scriptUtxo);
  const redeemerData = C.PlutusData.from_bytes(fromHex(redeemerHex));
  txObj.txBuilder.add_input(
    cmlScriptUtxo,
    (C as any).ScriptWitness.new_plutus_witness(
      C.PlutusWitness.new(redeemerData, undefined, undefined)
    ),
  );

  // Collateral is required for any Plutus-spending transaction.
  const walletUtxos = await lucid.wallet.getUtxosCore();
  const collateral = findCollateral(walletUtxos);
  if (!collateral) throw new Error('No pure-ADA UTxO available for collateral');
  txObj.txBuilder.add_collateral(collateral);

  const changeAddress = C.Address.from_bech32(await lucid.wallet.address());
  txObj.txBuilder.add_inputs_from(walletUtxos, changeAddress, Uint32Array.from([200, 1000, 1500, 800, 800, 5000]));
  txObj.txBuilder.balance(changeAddress, undefined);

  // build_tx() produces the balanced tx.  Redeemers will have ExUnits = 0 because
  // PlutusWitness.new(PlutusData) carries no ExUnits; the fee F0 was computed for 0 ExUnits.
  const partialTx = txObj.txBuilder.build_tx();
  const zeroRedeemers = partialTx.witness_set().redeemers();
  if (!zeroRedeemers || zeroRedeemers.len() === 0) {
    throw new Error('build_tx() produced no redeemers');
  }

  // Build synthetic redeemers with 2M mem / 1B steps to compute the correct fee.
  const synthRedeemers = (C as any).Redeemers.new();
  for (let i = 0; i < zeroRedeemers.len(); i++) {
    const r = zeroRedeemers.get(i);
    synthRedeemers.add((C as any).Redeemer.new(
      r.tag(), r.index(), r.data(),
      C.ExUnits.new(C.BigNum.from_str('2000000'), C.BigNum.from_str('1000000000')),
    ));
  }

  // Prepare V3 script container (reused in wsets below).
  // applyDoubleCborEncoding brings Aiken's Blueprint compiledCode into the encoding
  // CML expects for PlutusScript.from_bytes() — same transform Lucid uses for V1/V2.
  const plutusScript = C.PlutusScript.from_bytes(fromHex(applyDoubleCborEncoding(compiledCode)));
  const v3Scripts = (C as any).PlutusScripts.new();
  v3Scripts.add(plutusScript);

  // Compute the correct fee via min_fee on a mock tx that carries synthetic redeemers.
  const mockWset = C.TransactionWitnessSet.new();
  mockWset.set_redeemers(synthRedeemers);
  mockWset.set_plutus_v3_scripts(v3Scripts);
  const mockTx = C.Transaction.new(partialTx.body(), mockWset, partialTx.auxiliary_data());
  // min_fee on mockTx excludes vkey witnesses — add a 10,000 lovelace buffer
  // (~44 lovelace/byte × ~102 bytes per signer × 2 signers + margin).
  const F0 = BigInt(partialTx.body().fee().to_str());
  const F1 = BigInt(((C as any).min_fee(mockTx, _linearFee, _exUnitPrices) as any).to_str()) + 10000n;
  const finalFee = C.BigNum.from_str(F1.toString());
  const feeDelta = F1 - F0;

  // Rebuild the tx body: same inputs, fee = F1, last output (change) reduced by feeDelta.
  const origOutputs = partialTx.body().outputs();
  const numOut = origOutputs.len();
  if (numOut === 0) throw new Error('build_tx() produced no outputs — cannot find change output');

  const newOutputs = (C as any).TransactionOutputs.new();
  for (let i = 0; i < numOut - 1; i++) {
    const o = origOutputs.get(i);
    newOutputs.add(C.TransactionOutput.from_bytes(o.to_bytes()));
  }

  const changeOut = origOutputs.get(numOut - 1);
  const changeVal = changeOut.amount();
  const newLovelace = BigInt(changeVal.coin().to_str()) - feeDelta;
  if (newLovelace < 0n) throw new Error(`feeDelta (${feeDelta}) exceeds change output — wallet UTxO may be too small`);
  const newChangeVal = C.Value.from_bytes(changeVal.to_bytes());
  newChangeVal.set_coin(C.BigNum.from_str(newLovelace.toString()));
  const newChangeOut = C.TransactionOutput.new(changeOut.address(), newChangeVal);
  const changeDatum = changeOut.datum();
  if (changeDatum) newChangeOut.set_datum(changeDatum);
  newOutputs.add(newChangeOut);

  const origBody = partialTx.body();
  const newBody = C.TransactionBody.new(origBody.inputs(), newOutputs, finalFee, origBody.ttl());
  const certs         = origBody.certs();           if (certs)           newBody.set_certs(certs);
  const withdrawals   = origBody.withdrawals();     if (withdrawals)     newBody.set_withdrawals(withdrawals);
  const validStart    = origBody.validity_start_interval(); if (validStart) newBody.set_validity_start_interval(validStart);
  const mint          = origBody.mint();            if (mint)            newBody.set_mint(mint);
  const collateralI   = origBody.collateral();      if (collateralI)     newBody.set_collateral(collateralI);
  const reqSigners    = origBody.required_signers(); if (reqSigners)     newBody.set_required_signers(reqSigners);
  const networkId     = origBody.network_id();      if (networkId)       newBody.set_network_id(networkId);
  const colReturn     = origBody.collateral_return(); if (colReturn)     newBody.set_collateral_return(colReturn);
  const totalCol      = origBody.total_collateral(); if (totalCol)       newBody.set_total_collateral(totalCol);
  const refInputs     = origBody.reference_inputs(); if (refInputs)      newBody.set_reference_inputs(refInputs);

  // script_data_hash: manual blake2b-256 of (redeemers || 0xA0 || v3_lang_views).
  // CML's hash_script_data can't accept 350-entry V3 cost models, so we compute it ourselves.
  const scriptDataHash = hashScriptDataV3(synthRedeemers, _v3CostValues!);
  newBody.set_script_data_hash(scriptDataHash);

  // Assemble unsigned tx with V3 script + synthetic redeemers baked into the wset.
  const unsignedWset = C.TransactionWitnessSet.new();
  unsignedWset.set_plutus_v3_scripts(v3Scripts);
  unsignedWset.set_redeemers(synthRedeemers);

  const txForSigning = C.Transaction.new(newBody, unsignedWset, partialTx.auxiliary_data());
  const walletWset = await (lucid as any).wallet.signTx(txForSigning);

  // Merge wallet vkeys — create a fresh wset so the V3 script is preserved.
  const signedWset = C.TransactionWitnessSet.new();
  signedWset.set_plutus_v3_scripts(v3Scripts);
  signedWset.set_redeemers(synthRedeemers);
  const vkeys = walletWset.vkeys();
  if (vkeys) signedWset.set_vkeys(vkeys);

  const signedTx = C.Transaction.new(newBody, signedWset, partialTx.auxiliary_data());
  return await (lucid as any).provider.submitTx(toHex(signedTx.to_bytes()));
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

  // collectFrom is NOT queued — completeV3Tx adds the script input manually.
  const txObj = lucid
    .newTx()
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
    .validTo(validTo);

  const redeemerHex = buildRentRedeemer(renterAddress, lucid);
  const txHash = await completeV3Tx(txObj, rentalUtxo, redeemerHex, lucid, compiledCode);

  return {
    success: true,
    txHash,
    message: `Successfully rented "${nftAssetName}". Your wallet is registered for the draw.`,
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

async function claimBackExpiredRentals(
  projectWalletAddress: string,
  validator: ValidatorSetup,
  lucid: Lucid,
  onProgress: (msg: string) => void,
): Promise<string[]> {
  const { contractAddress, compiledCode } = validator;
  const utxos = await lucid.utxosAt(contractAddress);
  const now = BigInt(Date.now());

  const expired = utxos.filter(u => {
    try { return decodeDatum(u, lucid).draw_date <= now; }
    catch { return false; }
  });

  if (expired.length === 0) throw new Error('No expired rental UTxOs found at the contract address.');

  onProgress(`Found ${expired.length} expired rental UTxO(s).`);
  const hashes: string[] = [];

  // Pull blockfrost params from lucid's provider so we can poll for confirmation
  // between sequential claimbacks — prevents stale UTxO conflicts on the wallet.
  const provider = (lucid as any).provider;
  const bfBase = provider?.url ?? '';
  const bfKey  = provider?.projectId ?? '';

  for (let idx = 0; idx < expired.length; idx++) {
    const utxo = expired[idx];
    const datum = decodeDatum(utxo, lucid);
    onProgress(`Claiming back ${datum.nft_asset_name}…`);

    const redeemerHex = Data.to(new Constr(2, [])); // ClaimBack = index 2
    const txObj = lucid
      .newTx()
      .payToAddress(datum.owner, utxo.assets)
      .addSigner(projectWalletAddress)
      .validFrom(Number(datum.draw_date) + 1000)
      .validTo(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now

    const txHash = await completeV3Tx(txObj, utxo, redeemerHex, lucid, compiledCode);
    onProgress(`Done: ${txHash.slice(0, 12)}…`);
    hashes.push(txHash);

    // Wait for each claimback to confirm before spending wallet UTxOs for the next one
    if (idx < expired.length - 1) {
      await waitForTxOnChain(txHash, bfBase, bfKey, onProgress);
    }
  }

  return hashes;
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
  let assets: Array<{ asset: string }> = [];
  for (let page = 1; ; page++) {
    const page_data = await bf<Array<{ asset: string }>>(`/assets/policy/${DONADA_POLICY_ID}?page=${page}&count=100`);
    assets = assets.concat(page_data);
    if (page_data.length < 100) break;
  }

  const holders: Array<{ address: string; assetId: string }> = [];
  for (const { asset } of assets) {
    const assetId = toText(asset.slice(56));
    let addresses: Array<{ address: string }> = [];
    for (let page = 1; ; page++) {
      const page_data = await bf<Array<{ address: string }>>(`/assets/${asset}/addresses?page=${page}&count=100`);
      addresses = addresses.concat(page_data);
      if (page_data.length < 100) break;
    }
    for (const { address } of addresses) {
      if (!excludeAddresses.has(address)) holders.push({ address, assetId });
    }
  }
  return holders;
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
    throw new Error(`Cannot cancel "${nftAssetName}" — a renter is already registered.`);
  }

  // collectFrom is NOT queued — completeV3Tx adds the script input manually.
  const txObj = lucid.newTx().addSigner(ownerAddress);

  const redeemerHex = Data.to(new Constr(0, []));
  const txHash = await completeV3Tx(txObj, listingUtxo, redeemerHex, lucid, compiledCode);

  return {
    success: true,
    txHash,
    message: `Listing for "${nftAssetName}" cancelled. Your NFT will return to your wallet.`,
  };
}

// ── Conway tag-258 CBOR stripper ─────────────────────────────────────────────
//
// Conway-era wallets (e.g. Eternl) encode Vkeywitnesses as a CBOR *set*
// (tag 258 prefix before the array) instead of a plain CBOR array.
// CML 0.10.7 calls Vkeywitnesses.from_bytes() expecting an array byte but
// receives the tag byte and throws "expected 'Array' byte received 'Tag'".
// Walk the CBOR tree and remove every occurrence of tag 258; all other
// bytes (including Plutus Constr tags 121-122, byte strings, etc.) are
// copied verbatim.
function stripCborTag258(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;

  function copyN(n: number): void {
    for (let j = 0; j < n; j++) out.push(bytes[i++]);
  }

  function readLen(info: number, push: boolean): number {
    if (info <= 23) return info;
    if (info === 24) { if (push) out.push(bytes[i]); return bytes[i++]; }
    if (info === 25) {
      const v = (bytes[i] << 8) | bytes[i + 1];
      if (push) { out.push(bytes[i]); out.push(bytes[i + 1]); }
      i += 2; return v;
    }
    if (info === 26) {
      const v = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
      if (push) copyN(4);
      else i += 4;
      return v;
    }
    throw new Error(`CBOR additional info ${info} not supported in stripCborTag258`);
  }

  function walk(): void {
    if (i >= bytes.length) return;
    const b = bytes[i];
    const major = b >> 5;
    const info  = b & 0x1F;

    if (major === 6) {
      i++; // consume tag byte without emitting
      const tagVal = readLen(info, false);
      if (tagVal !== 258) {
        // Re-emit the tag header bytes
        if      (info <= 23) out.push(0xC0 | info);
        else if (info === 24) { out.push(0xD8); out.push(tagVal); }
        else if (info === 25) { out.push(0xD9); out.push((tagVal >> 8) & 0xFF); out.push(tagVal & 0xFF); }
      }
      walk();
      return;
    }

    out.push(b); i++;
    switch (major) {
      case 0: case 1:
        if (info === 24) copyN(1);
        else if (info === 25) copyN(2);
        else if (info === 26) copyN(4);
        else if (info === 27) copyN(8);
        break;
      case 2: case 3: { const len = readLen(info, true); copyN(len); break; }
      case 4: { const n = readLen(info, true); for (let j = 0; j < n; j++) walk(); break; }
      case 5: { const n = readLen(info, true); for (let j = 0; j < n * 2; j++) walk(); break; }
      case 7:
        if (info === 24) copyN(1);
        else if (info === 25) copyN(2);
        else if (info === 26) copyN(4);
        else if (info === 27) copyN(8);
        break;
    }
  }

  walk();
  return new Uint8Array(out);
}

// Selects a CIP-30 wallet and patches lucid.wallet.signTx so that the tag-258
// wrapper is stripped from the returned witness set before CML parses it.
function selectAndPatchWallet(lucid: Lucid, cip30Api: unknown): void {
  lucid.selectWallet(cip30Api as any);
  const rawSign = (cip30Api as any).signTx.bind(cip30Api);
  (lucid as any).wallet.signTx = async (tx: any, _partialSign?: boolean) => {
    // Always partialSign=true: script inputs in spending txs are not owned by
    // the wallet, so passing false causes "wallet does not have the secret key".
    const rawHex = await rawSign(toHex(tx.to_bytes()), true);
    const stripped = stripCborTag258(fromHex(rawHex));
    return C.TransactionWitnessSet.from_bytes(stripped);
  };
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
  const connectedWalletRef = useRef<ConnectedWalletState | null>(null);
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
  // Whether the connected wallet owns any un-rented listings (controls section visibility)
  const [hasActiveListings, setHasActiveListings] = useState(false);

  // Admin draw flow (only shown when project wallet is connected)
  const [drawPrizeAda, setDrawPrizeAda] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawTxHash, setDrawTxHash] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [drawLog, setDrawLog] = useState<string[]>([]);

  // Admin claim-back flow
  const [isClaimingBack, setIsClaimingBack] = useState(false);
  const [claimBackLog, setClaimBackLog] = useState<string[]>([]);
  const [claimBackError, setClaimBackError] = useState<string | null>(null);

  // Admin holder sync
  const [isSyncingHolders, setIsSyncingHolders] = useState(false);
  const [holderPreview, setHolderPreview] = useState<string | null>(null);
  const [holderSyncError, setHolderSyncError] = useState<string | null>(null);

  // On-chain NFT stats (total supply + open rental listings)
  const [nftStats, setNftStats] = useState<{ total: number; openRentals: number } | null>(null);
  // Featured image — first NFT under the policy, loaded from on-chain metadata
  const [featuredNftImage, setFeaturedNftImage] = useState<string | null>(null);

  // Theme
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [signBtnAnim, setSignBtnAnim] = useState<'idle' | 'out' | 'in'>('idle');

  // Connected wallet's total raffle entries across all sources
  const [userEntries, setUserEntries] = useState<{
    listed: number; renting: number; participated: number; holding: number; total: number;
    freeEntrySnapshotTaken: boolean; holdingSnapshotTaken: boolean;
  } | null>(null);
  const [entriesExpanded, setEntriesExpanded] = useState(false);

  // Invalidate validator cache whenever the network changes so the address is re-derived
  useEffect(() => { _validatorCache = null; }, [network]);

  // ----- Fetch on-chain NFT stats -----
  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const { url: bfBase, apiKey: bfKey } = blockfrostConfig(network);

        // Total NFTs minted under the policy (paginated); capture first asset for image
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

        // Featured image: fetch first asset's on-chain CIP-25 metadata
        if (firstAsset && !cancelled) {
          const assetRes = await fetch(`${bfBase}/assets/${firstAsset}`, {
            headers: { project_id: bfKey },
          });
          if (assetRes.ok) {
            const assetData = await assetRes.json();
            const rawImage = assetData.onchain_metadata?.image;
            if (rawImage) {
              const flat = Array.isArray(rawImage) ? rawImage.join('') : String(rawImage);
              const url  = flat.replace('ipfs://', 'https://ipfs.io/ipfs/');
              if (!cancelled) setFeaturedNftImage(url);
            }
          }
        }

        // Open rental listings at the contract (no renter registered yet)
        const lucid = await initLucid(network);
        const { contractAddress } = await loadRentalValidator(lucid);
        const utxos = await lucid.utxosAt(contractAddress);
        const openRentals = utxos.filter(u => {
          try { return decodeDatum(u, lucid).renter === null; }
          catch { return false; }
        }).length;

        if (!cancelled) setNftStats({ total, openRentals });
      } catch (err) {
        console.error('Failed to fetch NFT stats:', err);
      }
    };
    fetchStats();
    return () => { cancelled = true; };
  }, [network]);

  // ----- Check if connected wallet has cancellable listings -----
  useEffect(() => {
    if (!fullWalletAddress) { setHasActiveListings(false); return; }
    let cancelled = false;
    const check = async () => {
      try {
        const lucid = await initLucid(network);
        const { contractAddress } = await loadRentalValidator(lucid);
        const utxos = await lucid.utxosAt(contractAddress);
        const hasAny = utxos.some(u => {
          try {
            const d = decodeDatum(u, lucid);
            return d.owner === fullWalletAddress && d.renter === null;
          } catch { return false; }
        });
        if (!cancelled) setHasActiveListings(hasAny);
      } catch { if (!cancelled) setHasActiveListings(false); }
    };
    check();
    return () => { cancelled = true; };
  }, [fullWalletAddress, network]);

  // ----- Compute the connected wallet's total raffle entries -----
  useEffect(() => {
    if (!fullWalletAddress) { setUserEntries(null); return; }
    let cancelled = false;

    const fetchEntries = async () => {
      try {
        // 1 & 2: contract UTxOs — owner listings + active rentals
        const lucid = await initLucid(network);
        const { contractAddress } = await loadRentalValidator(lucid);
        const utxos = await lucid.utxosAt(contractAddress);
        let listed = 0, renting = 0;
        for (const u of utxos) {
          try {
            const d = decodeDatum(u, lucid);
            if (d.owner === fullWalletAddress) listed++;
            if (d.renter === fullWalletAddress) renting++;
          } catch { /* skip malformed */ }
        }

        // 3: wallet_participants.csv — count rows matching this address
        const wpRes = await fetch('/data/wallet_participants.csv');
        const wpText = await wpRes.text();
        const wpRows = wpText.trim().split('\n').slice(1).filter(l => l.trim());
        const freeEntrySnapshotTaken = wpRows.length > 0;
        const participated = wpRows
          .filter(line => line.replace(/"/g, '').trim() === fullWalletAddress)
          .length;

        // 4: nft_holders.csv — count rows matching this address
        const nhRes = await fetch('/data/nft_holders.csv');
        const nhText = await nhRes.text();
        const nhRows = nhText.trim().split('\n').slice(1).filter(l => l.trim());
        const holdingSnapshotTaken = nhRows.length > 0;
        const holding = nhRows
          .filter(line => {
            const addr = line.split(',')[0].replace(/"/g, '').trim();
            return addr === fullWalletAddress;
          })
          .length;

        if (!cancelled) setUserEntries({ listed, renting, participated, holding, total: listed + renting + participated + holding, freeEntrySnapshotTaken, holdingSnapshotTaken });
      } catch { if (!cancelled) setUserEntries(null); }
    };

    fetchEntries();
    return () => { cancelled = true; };
  }, [fullWalletAddress, network]);

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
      setWallets([]);
    } catch (err) {
      console.error('Error connecting to wallet:', err);
    }
  };

  // Keep ref in sync so retry lambdas always read the latest wallet instance
  useEffect(() => {
    connectedWalletRef.current = connectedWallet;
  }, [connectedWallet]);

  // Re-enables both the Mesh BrowserWallet and the raw CIP-30 API.
  // Triggers the wallet extension's own unlock UI; returns true on success.
  const refreshWallet = async (): Promise<boolean> => {
    const current = connectedWalletRef.current;
    if (!current) return false;
    try {
      const [wallet, api] = await Promise.all([
        BrowserWallet.enable(current.name),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).cardano[current.name].enable(),
      ]);
      const updated = { ...current, wallet, api };
      connectedWalletRef.current = updated;
      setConnectedWallet(updated);
      return true;
    } catch {
      return false;
    }
  };

  const WALLET_LOCKED_MSG = 'Wallet is locked — unlock it in your extension and try again.';

  // Runs op(); if it throws APIError code -3 (wallet locked), refreshes the
  // wallet (triggering the extension's unlock prompt) then retries once.
  const withWalletRetry = async <T,>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      if ((err as any)?.code !== -3) throw err;
      const ok = await refreshWallet();
      if (!ok) throw err;
      return await op();
    }
  };

  const handleSignBtnClick = () => {
    if (signBtnAnim !== 'idle') return;
    setSignBtnAnim('out');
    setTimeout(() => {
      handleSelectWallet();
      setSignBtnAnim('in');
      setTimeout(() => setSignBtnAnim('idle'), 300);
    }, 280);
  };

  const closeModal = () => {
    setShowRentModal(false);
    setRentMode(false);
  };

  // ----- Owner: load their own NFTs then open listing modal -----
  const loadOwnedNftsForListing = async () => {
    if (!connectedWalletRef.current) return;
    setListingError(null);
    try {
      setLoadingOwnedNfts(true);
      const assets = await withWalletRetry(() => connectedWalletRef.current!.wallet.getAssets());
      const filtered = assets.filter((a: NftAsset) => POLICY_IDS.includes(a.policyId));
      const enriched = (await Promise.all(
        filtered.map((a: NftAsset) => fetchNftMetadata(a.policyId, a.assetName, network))
      )).map((r: any) =>
        r.error
          ? { policyId: r.policyId, assetName: r.assetName, name: r.assetName } as NftAsset
          : r as NftAsset
      );
      setOwnedNfts(enriched);
      setRentMode(false);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load NFTs', err);
      setListingError((err as any)?.code === -3 ? WALLET_LOCKED_MSG : 'Failed to load your NFTs — try again.');
    } finally {
      setLoadingOwnedNfts(false);
    }
  };

  // ----- Renter: load available listings from the contract then open rent modal -----
  const loadListedNfts = async () => {
    if (!connectedWallet) return;
    setRentError(null);
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

      const enriched = await Promise.all(
        available.map(async (a: NftAsset) => {
          const meta = await fetchNftMetadata(a.policyId, a.assetName, network);
          return (meta as any).error
            ? a
            : { ...a, image: (meta as any).image ?? undefined, name: (meta as any).name ?? a.name } as NftAsset;
        })
      );
      setListedNfts(enriched);
      setRentMode(true);
      setShowRentModal(true);
    } catch (err) {
      console.error('Failed to load listed NFTs:', err);
      setRentError((err as any)?.code === -3 ? WALLET_LOCKED_MSG : 'Failed to load listings — try again.');
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
      const txHash = await withWalletRetry(async () => {
        const lucid = await initLucid(network);
        selectAndPatchWallet(lucid, connectedWalletRef.current!.api);
        const { contractAddress } = await loadRentalValidator(lucid);
        return submitListing(
          nft.name ?? nft.assetName,
          fullWalletAddress,
          rentalPrice,
          Math.floor(nextDrawDate.getTime()),
          contractAddress,
          lucid
        );
      });
      setListingTxHash(txHash);
      setUserEntries(prev => prev ? { ...prev, listed: prev.listed + 1, total: prev.total + 1 } : prev);
    } catch (err) {
      console.error('Failed to list NFT:', err);
      setListingError((err as any)?.code === -3 ? WALLET_LOCKED_MSG : (err instanceof Error ? err.message : String(err)));
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
      const result = await withWalletRetry(async () => {
        const lucid = await initLucid(network);
        selectAndPatchWallet(lucid, connectedWalletRef.current!.api);
        const validator = await loadRentalValidator(lucid);
        return rentNft(nft.assetName, fullWalletAddress, validator, lucid);
      });
      setRentTxHash(result.txHash);
      setUserEntries(prev => prev ? { ...prev, renting: prev.renting + 1, total: prev.total + 1 } : prev);
    } catch (err) {
      console.error('Failed to rent NFT:', err);
      setRentError((err as any)?.code === -3 ? WALLET_LOCKED_MSG : (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsRenting(false);
    }
  };

  // ----- Owner: load cancellable listings into modal -----
  const loadCancellableListings = async () => {
    if (!fullWalletAddress || !connectedWallet) return;
    setCancelError(null);
    setLoadingCancelListings(true);
    try {
      const lucid = await initLucid(network);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selectAndPatchWallet(lucid, connectedWalletRef.current!.api);
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
      setCancelError((err as any)?.code === -3 ? WALLET_LOCKED_MSG : 'Failed to load listings — try again.');
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
      const result = await withWalletRetry(async () => {
        const lucid = await initLucid(network);
        selectAndPatchWallet(lucid, connectedWalletRef.current!.api);
        const validator = await loadRentalValidator(lucid);
        return cancelListingNft(nft.assetName, fullWalletAddress, validator, lucid);
      });
      setCancelTxHash(result.txHash);
      setCancelNfts(prev => {
        const updated = prev.filter(n => n.assetName !== nft.assetName);
        setHasActiveListings(updated.length > 0);
        return updated;
      });
    } catch (err) {
      console.error('Cancel failed:', err);
      setCancelError((err as any)?.code === -3 ? WALLET_LOCKED_MSG : (err instanceof Error ? err.message : String(err)));
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selectAndPatchWallet(lucid, connectedWalletRef.current!.api);

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

      // ── Source 2: live on-chain NFT holders (Blockfrost policy query) ──────────
      // Excludes the contract address (counted as rental) and project wallet.
      const { url: blockfrostBase, apiKey: blockfrostKey } = blockfrostConfig(network);
      log('Fetching live NFT holders from chain…');
      const nftHolderRows = await fetchLiveNftHolders(
        blockfrostBase,
        blockfrostKey,
        new Set([contractAddress, PROJECT_WALLET_ADDRESS]),
      );

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

      const walletAddresses = await parseWalletCsv();

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

      log(`Done! Payout tx: ${txHash}`);
      setDrawTxHash(txHash);

      // Automatically return NFTs to owners for all expired rental UTxOs,
      // regardless of whether they had an active renter.
      log('Waiting for payout to confirm before returning NFTs…');
      await waitForTxOnChain(txHash, blockfrostBase, blockfrostKey, log);
      // Allow Blockfrost UTxO index and wallet extension cache to settle after payout
      log('Settling — waiting 15s before returning NFTs…');
      await new Promise<void>(r => setTimeout(r, 15_000));
      log('Returning rental NFTs to owners…');
      try {
        // Fresh lucid instance ensures clean Blockfrost UTxO state (not stale from payout tx)
        const claimLucid = await initLucid(network);
        const claimValidator = await loadRentalValidator(claimLucid);
        const claimedHashes = await withWalletRetry(async () => {
          selectAndPatchWallet(claimLucid, connectedWalletRef.current!.api);
          return claimBackExpiredRentals(
            fullWalletAddress,
            claimValidator,
            claimLucid,
            msg => setDrawLog(prev => [...prev, msg]),
          );
        });
        log(`Returned ${claimedHashes.length} NFT(s) to owner(s).`);
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
    if (!connectedWallet || !fullWalletAddress) return;
    setIsClaimingBack(true);
    setClaimBackLog([]);
    setClaimBackError(null);
    try {
      const lucid = await initLucid(network);
      selectAndPatchWallet(lucid, connectedWalletRef.current!.api);
      const validator = await loadRentalValidator(lucid);
      await withWalletRetry(async () => {
        selectAndPatchWallet(lucid, connectedWalletRef.current!.api);
        return claimBackExpiredRentals(
          fullWalletAddress,
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
      const lucid = await initLucid(network);
      const { contractAddress } = await loadRentalValidator(lucid);
      const { url: blockfrostBase, apiKey: blockfrostKey } = blockfrostConfig(network);
      const holders = await fetchLiveNftHolders(
        blockfrostBase,
        blockfrostKey,
        new Set([contractAddress, PROJECT_WALLET_ADDRESS]),
      );
      const uniqueAddresses = new Set(holders.map(h => h.address)).size;
      setHolderPreview(`${holders.length} ticket(s) across ${uniqueAddresses} wallet(s)`);
    } catch (err) {
      setHolderSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncingHolders(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className={`app-container${isDarkMode ? ' dark-mode' : ''}`}>
      <header className="header">
        <div className="logo-group">
          <h1 className="logo">
            <a href="https://donada.io" target="_blank" rel="noopener noreferrer">
              DONADA
            </a>
          </h1>
          <button className="theme-toggle" onClick={() => setIsDarkMode(d => !d)}>
            {isDarkMode ? '[dark]' : '[light]'}
          </button>
        </div>

        <div className="user-controls">
          <div className="sign-btn-wrapper">
            <button
              className={`select-btn sign-btn-${signBtnAnim}`}
              onClick={handleSignBtnClick}
              disabled={signBtnAnim !== 'idle'}
            >
              {connectedWallet ? 'Disconnect Wallet' : 'Sign in with Wallet'}
            </button>
          </div>

          <span className="user-label">
            {connectedWallet ? `${connectedWallet.name} Connected` : '[No Wallet]'}
          </span>
        </div>
      </header>

      {wallets.length > 1 && !connectedWallet && (
        <div className="wallet-list">
          {wallets.map((w) => (
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

      <main className="main-content">
        <div className="nft-card">
          <div className="nft-top-row">
            <div className="nft-image">
              <div className="nft-image-frame">
                <div className={`nft-image-inner${featuredNftImage ? ' has-image' : ''}`}>
                  {featuredNftImage
                    ? <img src={featuredNftImage} alt={COLLECTION_NAME} />
                    : 'NFT IMAGE'}
                </div>
                <div className="nft-details">
                  <p className="mint-name">Collection: {COLLECTION_NAME}</p>
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

            {connectedWallet && (
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
                      <span>{!userEntries?.holdingSnapshotTaken ? '[no snapshot]' : (userEntries?.holding ?? '—')}</span>
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
                <div className="action-text">Browse Rental Listings</div>
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

              {hasActiveListings && (
                <>
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
                </>
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
            <div className="action-text">Claim Back Expired Rentals</div>
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
        </section>
      )}

      </main>

      <RentModal
        isOpen={showRentModal}
        mode={rentMode ? 'rent' : 'list'}
        nfts={(rentMode ? listedNfts : ownedNfts) as any}
        onClose={closeModal}
        onConfirm={rentMode ? handleRentNft : handleCreateListing}
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
    </div>
  );
}
