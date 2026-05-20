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

import { Lucid, Blockfrost, Data, Constr, UTxO, fromHex, toHex, toText, C, applyDoubleCborEncoding } from "lucid-cardano";
import type { ProtocolParameters } from "lucid-cardano";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createHash } from "crypto";

const _require = createRequire(import.meta.url);

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
  nft_policy:         string; // hex
  nft_asset_name:     string; // human-readable
  nft_asset_name_hex: string; // raw hex used to build the Cardano unit
  owner:              string; // bech32
  renter:             string | null; // bech32 or null
  rental_fee:         bigint;
  draw_date:          bigint; // POSIX ms
  project_wallet:     string; // bech32
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

// ── PlutusV3 transaction machinery ───────────────────────────────────────────
// Mirrors completeV3Tx in DonadaPlatform.tsx. lucid-cardano 0.10.7 has no native
// V3 support — we build the witness set, fee, and script_data_hash manually.

let _v3CostValues: number[] | null = null;
let _linearFee:    any = null;
let _exUnitPrices: any = null;

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
  buf.push(0xA1, 0x02);
  const len = costs.length;
  if (len <= 23)        buf.push(0x80 | len);
  else if (len <= 0xFF) buf.push(0x98, len);
  else                  buf.push(0x99, (len >> 8) & 0xFF, len & 0xFF);
  for (const c of costs) pushCborInt(buf, Math.round(c));
  return new Uint8Array(buf);
}

function hashScriptDataV3(redeemers: any, v3Costs: number[]): any {
  const b2b = _require('blake2b') as any;
  const rdmrs     = redeemers.to_bytes() as Uint8Array;
  const langViews = buildV3LangViewsCbor(v3Costs);
  const preimage  = new Uint8Array(rdmrs.length + langViews.length);
  preimage.set(rdmrs, 0);
  preimage.set(langViews, rdmrs.length);
  const hash = b2b(32).update(preimage).digest() as Uint8Array;
  return (C as any).ScriptDataHash.from_bytes(hash);
}

async function patchLucidV3CostModels(lucid: Lucid): Promise<void> {
  const pp = await (lucid as any).provider.getProtocolParameters();
  const cm = (pp.costModels ?? {}) as Record<string, Record<string, number>>;

  if (cm.PlutusV3) {
    _v3CostValues = Object.values(cm.PlutusV3) as number[];
  } else {
    console.warn('[V3Patch] no PlutusV3 cost models in protocol params');
  }

  _linearFee    = C.LinearFee.new(C.BigNum.from_str(pp.minFeeA.toString()), C.BigNum.from_str(pp.minFeeB.toString()));
  _exUnitPrices = (C as any).ExUnitPrices.from_float(pp.priceMem, pp.priceStep);
}

function utxoToCml(utxo: UTxO): any {
  const address = (() => {
    try { return C.Address.from_bech32(utxo.address); }
    catch { return (C as any).ByronAddress.from_base58(utxo.address).to_address(); }
  })();

  const multiAsset = (C as any).MultiAsset.new();
  const lovelace   = utxo.assets['lovelace'];
  const units      = Object.keys(utxo.assets);
  const policies   = Array.from(new Set(
    units.filter(u => u !== 'lovelace').map(u => u.slice(0, 56))
  )) as string[];

  policies.forEach(policy => {
    const policyUnits = units.filter(u => u.slice(0, 56) === policy);
    const assetMap    = (C as any).Assets.new();
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

async function completeV3Tx(
  txObj:        any,
  scriptUtxo:   UTxO,
  redeemerHex:  string,
  lucid:        Lucid,
  compiledCode: string,
): Promise<string> {
  if (!_v3CostValues || !_linearFee || !_exUnitPrices) {
    throw new Error('V3 cost models / fee params not initialised — call patchLucidV3CostModels first');
  }

  let task = (txObj as any).tasks.shift();
  while (task) { await task(txObj as any); task = (txObj as any).tasks.shift(); }

  const cmlScriptUtxo = utxoToCml(scriptUtxo);
  const redeemerData  = C.PlutusData.from_bytes(fromHex(redeemerHex));
  txObj.txBuilder.add_input(
    cmlScriptUtxo,
    (C as any).ScriptWitness.new_plutus_witness(
      C.PlutusWitness.new(redeemerData, undefined, undefined)
    ),
  );

  const walletUtxos = await lucid.wallet.getUtxosCore();
  const collateral  = findCollateral(walletUtxos);
  if (!collateral) throw new Error('No pure-ADA UTxO available for collateral');
  txObj.txBuilder.add_collateral(collateral);

  const changeAddress = C.Address.from_bech32(await lucid.wallet.address());
  txObj.txBuilder.add_inputs_from(walletUtxos, changeAddress, Uint32Array.from([200, 1000, 1500, 800, 800, 5000]));
  txObj.txBuilder.balance(changeAddress, undefined);

  const partialTx    = txObj.txBuilder.build_tx();
  const zeroRedeemers = partialTx.witness_set().redeemers();
  if (!zeroRedeemers || zeroRedeemers.len() === 0) throw new Error('build_tx() produced no redeemers');

  const synthRedeemers = (C as any).Redeemers.new();
  for (let i = 0; i < zeroRedeemers.len(); i++) {
    const r = zeroRedeemers.get(i);
    synthRedeemers.add((C as any).Redeemer.new(
      r.tag(), r.index(), r.data(),
      C.ExUnits.new(C.BigNum.from_str('2000000'), C.BigNum.from_str('1000000000')),
    ));
  }

  const plutusScript = C.PlutusScript.from_bytes(fromHex(applyDoubleCborEncoding(compiledCode)));
  const v3Scripts    = (C as any).PlutusScripts.new();
  v3Scripts.add(plutusScript);

  const mockWset = C.TransactionWitnessSet.new();
  mockWset.set_redeemers(synthRedeemers);
  mockWset.set_plutus_v3_scripts(v3Scripts);
  const mockTx = C.Transaction.new(partialTx.body(), mockWset, partialTx.auxiliary_data());
  const F0 = BigInt(partialTx.body().fee().to_str());
  const F1 = BigInt(((C as any).min_fee(mockTx, _linearFee, _exUnitPrices) as any).to_str()) + 10000n;
  const feeDelta  = F1 - F0;
  const finalFee  = C.BigNum.from_str(F1.toString());

  const origOutputs = partialTx.body().outputs();
  const numOut      = origOutputs.len();
  if (numOut === 0) throw new Error('build_tx() produced no outputs');

  const newOutputs = (C as any).TransactionOutputs.new();
  for (let i = 0; i < numOut - 1; i++) {
    newOutputs.add(C.TransactionOutput.from_bytes(origOutputs.get(i).to_bytes()));
  }
  const changeOut    = origOutputs.get(numOut - 1);
  const changeVal    = changeOut.amount();
  const newLovelace  = BigInt(changeVal.coin().to_str()) - feeDelta;
  if (newLovelace < 0n) throw new Error(`feeDelta (${feeDelta}) exceeds change output`);
  const newChangeVal = C.Value.from_bytes(changeVal.to_bytes());
  newChangeVal.set_coin(C.BigNum.from_str(newLovelace.toString()));
  const newChangeOut = C.TransactionOutput.new(changeOut.address(), newChangeVal);
  const changeDatum  = changeOut.datum();
  if (changeDatum) newChangeOut.set_datum(changeDatum);
  newOutputs.add(newChangeOut);

  const origBody    = partialTx.body();
  const newBody     = C.TransactionBody.new(origBody.inputs(), newOutputs, finalFee, origBody.ttl());
  const certs       = origBody.certs();               if (certs)       newBody.set_certs(certs);
  const withdrawals = origBody.withdrawals();         if (withdrawals) newBody.set_withdrawals(withdrawals);
  const validStart  = origBody.validity_start_interval(); if (validStart) newBody.set_validity_start_interval(validStart);
  const mint        = origBody.mint();                if (mint)        newBody.set_mint(mint);
  const collateralI = origBody.collateral();          if (collateralI) newBody.set_collateral(collateralI);
  const reqSigners  = origBody.required_signers();    if (reqSigners)  newBody.set_required_signers(reqSigners);
  const networkId   = origBody.network_id();          if (networkId)   newBody.set_network_id(networkId);
  const colReturn   = origBody.collateral_return();   if (colReturn)   newBody.set_collateral_return(colReturn);
  const totalCol    = origBody.total_collateral();    if (totalCol)    newBody.set_total_collateral(totalCol);
  const refInputs   = origBody.reference_inputs();    if (refInputs)   newBody.set_reference_inputs(refInputs);

  const scriptDataHash = hashScriptDataV3(synthRedeemers, _v3CostValues!);
  newBody.set_script_data_hash(scriptDataHash);

  const unsignedWset = C.TransactionWitnessSet.new();
  unsignedWset.set_plutus_v3_scripts(v3Scripts);
  unsignedWset.set_redeemers(synthRedeemers);

  const txForSigning = C.Transaction.new(newBody, unsignedWset, partialTx.auxiliary_data());
  const walletWset   = await (lucid as any).wallet.signTx(txForSigning);

  const signedWset = C.TransactionWitnessSet.new();
  signedWset.set_plutus_v3_scripts(v3Scripts);
  signedWset.set_redeemers(synthRedeemers);
  const vkeys = walletWset.vkeys();
  if (vkeys) signedWset.set_vkeys(vkeys);

  const signedTx = C.Transaction.new(newBody, signedWset, partialTx.auxiliary_data());
  return await (lucid as any).provider.submitTx(toHex(signedTx.to_bytes()));
}

// ── Draw date check ───────────────────────────────────────────────────────────

// CSV times are authored in Central Time. CDT (summer) = UTC-5, CST (winter) = UTC-6.
const CST_OFFSET_HOURS = 5;

const CSV_PATH = join(__dirname, '..', 'public', 'data', 'drawDates.csv');

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
  // Convert CST → UTC before constructing the Date
  return { date: new Date(Date.UTC(year, month - 1, day, hour + CST_OFFSET_HOURS, minute)), complete };
}

interface ScheduledDraw {
  date:     Date;
  complete: boolean;
}

function loadScheduledDraw(): ScheduledDraw | null {
  const lines = readFileSync(CSV_PATH, 'utf-8').trim().split('\n').slice(1);
  const rows  = lines
    .map(parseCsvRowToUtc)
    .filter((r): r is ScheduledDraw => r !== null);

  // Earliest draw date that has not been marked complete
  const incomplete = rows
    .filter(r => !r.complete)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return incomplete[0] ?? null;
}

function markDrawComplete(drawDate: Date): void {
  const repoRoot = join(__dirname, '..');
  const lines    = readFileSync(CSV_PATH, 'utf-8').split('\n');
  const drawMs   = drawDate.getTime();

  const updated = lines.map(line => {
    const parsed = parseCsvRowToUtc(line);
    if (parsed && parsed.date.getTime() === drawMs) {
      return line.replace(/"n"/, '"y"');
    }
    return line;
  });

  writeFileSync(CSV_PATH, updated.join('\n'));
  console.log(`Marked draw ${drawDate.toISOString()} as complete in CSV.`);

  try {
    execSync('git config user.email "actions@github.com"', { cwd: repoRoot });
    execSync('git config user.name "GitHub Actions"',      { cwd: repoRoot });
    execSync('git add public/data/drawDates.csv',          { cwd: repoRoot });
    execSync(`git commit -m "Mark draw complete: ${drawDate.toISOString()}"`, { cwd: repoRoot });
    execSync('git push',                                   { cwd: repoRoot });
    console.log('CSV committed and pushed.');
  } catch (err) {
    console.error('Failed to commit/push CSV update:', err);
  }
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

function dataToAddress(lucid: Lucid, data: Data): string {
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
  return lucid.utils.credentialToAddress(paymentCred, stakeCred);
}

function decodeDatum(utxo: UTxO, lucid: Lucid): RentalDatum {
  if (!utxo.datum) throw new Error('UTxO has no inline datum');
  const constr      = Data.from(utxo.datum) as Constr<Data>;
  const f           = constr.fields;
  const renterConstr = f[3] as Constr<Data>;
  const assetHex     = f[1] as string;
  return {
    nft_policy:         f[0] as string,
    nft_asset_name:     toText(assetHex),
    nft_asset_name_hex: assetHex,
    owner:              dataToAddress(lucid, f[2]),
    renter:             renterConstr.index === 0 ? dataToAddress(lucid, renterConstr.fields[0]) : null,
    rental_fee:         BigInt(f[4] as bigint),
    draw_date:          BigInt(f[5] as bigint),
    project_wallet:     dataToAddress(lucid, f[6]),
  };
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

// ── Tx confirmation helper ────────────────────────────────────────────────────

async function waitForTxConfirmed(txHash: string, maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  console.log(`Waiting for payout tx ${txHash.slice(0, 12)}… to be confirmed...`);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000));
    try {
      await blockfrostGet(`/txs/${txHash}`);
      console.log('Payout tx confirmed.');
      return;
    } catch { /* not yet indexed */ }
  }
  console.warn(`Payout tx not confirmed within ${maxWaitMs / 1000}s — proceeding with ClaimBack`);
}

// ── ClaimBack helpers ─────────────────────────────────────────────────────────

function loadCompiledCode(): string {
  const blueprintPath = join(__dirname, '..', 'public', 'data', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf-8'));
  const validator = blueprint.validators?.find(
    (v: { title: string }) => v.title === 'rental_validator.rental.spend'
  );
  if (!validator) throw new Error('rental spend validator not found in plutus.json');
  return validator.compiledCode as string;
}

async function claimBackRentalUtxos(
  lucid:        Lucid,
  rentalUtxos:  UTxO[],
  compiledCode: string,
): Promise<void> {
  if (rentalUtxos.length === 0) {
    console.log('No rental UTxOs to claim back.');
    return;
  }
  console.log(`\nClaiming back ${rentalUtxos.length} rental UTxO(s)...`);

  for (const utxo of rentalUtxos) {
    try {
      const datum = decodeDatum(utxo, lucid);
      console.log(`  ${datum.nft_asset_name} → ${datum.owner.slice(0, 24)}…`);

      // ClaimBack redeemer = Constr(2, []) (index 2 in RentalRedeemer enum).
      // collectFrom + attachSpendingValidator register the script input with lucid's
      // txBuilder so it appears in body.inputs. completeV3Tx then injects the V3
      // witness set and corrects the fee/script_data_hash manually.
      const redeemerHex = Data.to(new Constr(2, []));
      const txObj = lucid
        .newTx()
        .collectFrom([utxo], redeemerHex)
        .attachSpendingValidator({ type: 'PlutusV2', script: applyDoubleCborEncoding(compiledCode) })
        .payToAddress(datum.owner, utxo.assets)
        .addSigner(PROJECT_WALLET_ADDRESS)
        .validFrom(Number(datum.draw_date) + 1000);

      const txHash = await completeV3Tx(txObj, utxo, redeemerHex, lucid, compiledCode);
      console.log(`  Claimed! Tx: ${txHash}`);
    } catch (err) {
      console.error(`  Failed (${utxo.txHash}#${utxo.outputIndex}):`, err);
    }
  }
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
  await patchLucidV3CostModels(lucid);

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
      const datum = decodeDatum(u, lucid);
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
  const prizeLovelace = BigInt((process.env.PRIZE_LOVELACE ?? '').replace(/[^0-9]/g, '') || '0');
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

  // Mark this draw as complete in the CSV before ClaimBack — prevents
  // double payout if the cron fires again before the next draw is added.
  markDrawComplete(scheduled.date);

  // Wait for the payout tx to be confirmed so the wallet UTXO set is fresh
  // before ClaimBack tries to select collateral and fee inputs.
  await waitForTxConfirmed(txHash);

  // Step 8 — Return each rented NFT to its owner (10 min after draw_date)
  const compiledCode    = loadCompiledCode();
  const rentalUtxosToReturn = rentalParticipants
    .filter((p): p is Extract<DrawParticipant, { source: 'rental' }> => p.source === 'rental')
    .map(p => p.rental.utxo);
  await claimBackRentalUtxos(lucid, rentalUtxosToReturn, compiledCode);
}

main().catch(err => {
  console.error('\nDraw failed:', err);
  process.exit(1);
});
