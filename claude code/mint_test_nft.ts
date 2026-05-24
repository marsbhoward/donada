// =============================================================================
// mint_test_nft.ts
// =============================================================================
// Converts images from iCloud Drive, uploads them to Blockfrost IPFS, pins
// them, then mints 8 test NFTs on the Cardano Preview testnet with CIP-25
// metadata pointing at the IPFS hashes.
//
// Prerequisites:
//   1. Blockfrost Preview chain API key  (project starts with "preview")
//   2. Blockfrost IPFS API key           (project starts with "ipfs" — separate product)
//   3. Wallet seed phrase for the project wallet
//   4. At least 5 tADA in the wallet (faucet: https://docs.cardano.org/cardano-testnet/tools/faucet)
//
// Environment variables (add to .env or pass inline):
//   REACT_APP_BlockFrost_API_KEY_Preview=previewXXX
//   BLOCKFROST_IPFS_KEY=ipfsXXX
//   OWNER_SEED_PHRASE="word1 word2 ... word24"
//
// Run:
//   npx tsx "claude code/mint_test_nft.ts"
//
// After running, copy the printed Policy ID into DonadaPlatform.tsx as DONADA_POLICY_ID.
// =============================================================================

import { Lucid, Blockfrost, fromText } from "lucid-cardano";
import type { ProtocolParameters } from "lucid-cardano";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────

const BLOCKFROST_CHAIN_KEY = process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '';
const BLOCKFROST_IPFS_KEY  = process.env.BLOCKFROST_IPFS_KEY ?? '';
const SEED = (process.env.OWNER_SEED_PHRASE ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();

const BLOCKFROST_CHAIN_URL = 'https://cardano-preview.blockfrost.io/api/v0';
const BLOCKFROST_IPFS_URL  = 'https://ipfs.blockfrost.io/api/v0';

const ICLOUD_TEST_DIR = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/Donada/Test`;

const NFT_NAMES = [
  'DONADA Test 000',
  'DONADA Test 001',
  'DONADA Test 002',
  'DONADA Test 003',
  'DONADA Test 004',
  'DONADA Test 005',
  'DONADA Test 006',
  'DONADA Test 007',
];

// ── Conway cost-model compat (same as draw_script.ts) ─────────────────────────

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

// ── Image helpers ─────────────────────────────────────────────────────────────

function getSourceFiles(): string[] {
  const raw = execSync(`ls "${ICLOUD_TEST_DIR}"`, { encoding: 'utf-8' }).trim().split('\n');
  const files = raw
    .filter(f => /\.(jpg|jpeg|heic|png)$/i.test(f))
    .sort();
  return files.map(f => join(ICLOUD_TEST_DIR, f));
}

// macOS sips converts HEIC → JPEG in-place into /tmp
function toJpeg(sourcePath: string): string {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return sourcePath;
  const outPath = join(tmpdir(), `donada_${basename(sourcePath, ext)}.jpg`);
  execSync(`sips -s format jpeg "${sourcePath}" --out "${outPath}" --setProperty formatOptions 90`, { stdio: 'pipe' });
  return outPath;
}

// ── Blockfrost IPFS helpers ───────────────────────────────────────────────────

async function uploadToIpfs(imagePath: string): Promise<string> {
  const bytes = readFileSync(imagePath);
  const form  = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), basename(imagePath));

  const res = await fetch(`${BLOCKFROST_IPFS_URL}/ipfs/add`, {
    method:  'POST',
    headers: { project_id: BLOCKFROST_IPFS_KEY },
    body:    form,
  });
  if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { ipfs_hash: string };
  return data.ipfs_hash;
}

async function pinCid(cid: string): Promise<void> {
  const res = await fetch(`${BLOCKFROST_IPFS_URL}/ipfs/pin/add/${cid}`, {
    method:  'POST',
    headers: { project_id: BLOCKFROST_IPFS_KEY },
  });
  if (!res.ok) throw new Error(`Pin failed for ${cid} (${res.status}): ${await res.text()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SEED)                 throw new Error('OWNER_SEED_PHRASE is not set.');
  if (!BLOCKFROST_CHAIN_KEY) throw new Error('REACT_APP_BlockFrost_API_KEY_Preview is not set.');
  if (!BLOCKFROST_IPFS_KEY)  throw new Error('BLOCKFROST_IPFS_KEY is not set.');

  const sourceFiles = getSourceFiles();
  if (sourceFiles.length !== 8) {
    throw new Error(`Expected 8 image files in ${ICLOUD_TEST_DIR}, found ${sourceFiles.length}.`);
  }

  console.log('Source images → NFT names:');
  sourceFiles.forEach((f, i) => console.log(`  ${basename(f).padEnd(22)} → ${NFT_NAMES[i]}`));

  // Step 1 — Convert and upload images
  console.log('\nUploading to Blockfrost IPFS...');
  const cids: string[] = [];
  for (let i = 0; i < 8; i++) {
    process.stdout.write(`  [${i + 1}/8] ${NFT_NAMES[i]}... `);
    const jpegPath = toJpeg(sourceFiles[i]);
    const cid      = await uploadToIpfs(jpegPath);
    await pinCid(cid);
    cids.push(cid);
    console.log(`pinned  ipfs://${cid.slice(0, 16)}…`);
  }

  // Step 2 — Derive minting policy from seed
  console.log('\nDeriving minting policy from seed...');
  const lucid = await Lucid.new(new ConwayCompatBlockfrost(BLOCKFROST_CHAIN_URL, BLOCKFROST_CHAIN_KEY), 'Preview');
  lucid.selectWalletFromSeed(SEED);

  const walletAddress = await lucid.wallet.address();
  const { paymentCredential } = lucid.utils.getAddressDetails(walletAddress);
  if (!paymentCredential) throw new Error('No payment credential derived from seed.');

  // Signature-only policy (no time lock — fine for testnet)
  const mintingPolicy = lucid.utils.nativeScriptFromJson({
    type:    'sig',
    keyHash: paymentCredential.hash,
  });
  const policyId = lucid.utils.mintingPolicyToId(mintingPolicy);

  console.log(`Wallet:    ${walletAddress}`);
  console.log(`Policy ID: ${policyId}`);

  // Step 3 — Build assets + CIP-25 metadata
  const mintAssets: Record<string, bigint> = {};
  const metadata721: Record<string, object> = {};

  for (let i = 0; i < 8; i++) {
    const name = NFT_NAMES[i];
    mintAssets[policyId + fromText(name)] = 1n;
    metadata721[name] = {
      name,
      image:       `ipfs://${cids[i]}`,
      mediaType:   'image/jpeg',
      description: 'Donada test NFT',
    };
  }

  // Step 4 — Mint
  console.log('\nBuilding mint transaction...');
  const tx = await lucid.newTx()
    .mintAssets(mintAssets)
    .attachMintingPolicy(mintingPolicy)
    .attachMetadata(721, { [policyId]: metadata721 })
    .addSigner(walletAddress)
    .complete();

  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`Minted!    Tx:        ${txHash}`);
  console.log(`Policy ID: ${policyId}`);
  console.log(`Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  console.log('\nUpdate DONADA_POLICY_ID in DonadaPlatform.tsx to:');
  console.log(`  ${policyId}`);
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nFailed:', err);
  process.exit(1);
});
