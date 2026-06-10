// =============================================================================
// upload_images.ts
// =============================================================================
// Converts images from a local directory, uploads them to Blockfrost IPFS,
// and pins each CID. Prints a summary table of filename → IPFS CID.
//
// Prerequisites:
//   BLOCKFROST_IPFS_KEY=ipfsXXX  (add to .env or pass inline)
//
// Run:
//   npx tsx "claude code/upload_images.ts"
// =============================================================================

import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, extname, basename } from 'path';
import { tmpdir } from 'os';
import * as dotenv from 'dotenv';
dotenv.config();

const BLOCKFROST_IPFS_KEY = process.env.BLOCKFROST_IPFS_KEY ?? '';
const BLOCKFROST_IPFS_URL = 'https://ipfs.blockfrost.io/api/v0';

const IMAGE_DIR = `${process.env.HOME}/Desktop/move`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toJpeg(sourcePath: string): string {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return sourcePath;
  const outPath = join(tmpdir(), `donada_upload_${basename(sourcePath, ext)}.jpg`);
  execSync(
    `sips -s format jpeg "${sourcePath}" --out "${outPath}" --setProperty formatOptions 90`,
    { stdio: 'pipe' },
  );
  return outPath;
}

async function uploadToIpfs(imagePath: string): Promise<string> {
  const data = readFileSync(imagePath);
  const body = new FormData();
  body.append('file', new Blob([data]), basename(imagePath));
  const res = await fetch(`${BLOCKFROST_IPFS_URL}/ipfs/add`, {
    method: 'POST',
    headers: { project_id: BLOCKFROST_IPFS_KEY },
    body,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as { ipfs_hash: string };
  return json.ipfs_hash;
}

async function pinCid(cid: string): Promise<void> {
  const res = await fetch(`${BLOCKFROST_IPFS_URL}/ipfs/pin/add/${cid}`, {
    method: 'POST',
    headers: { project_id: BLOCKFROST_IPFS_KEY },
  });
  if (!res.ok) throw new Error(`Pin failed (${res.status}): ${await res.text()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!BLOCKFROST_IPFS_KEY) throw new Error('BLOCKFROST_IPFS_KEY is not set in .env');

  const files = readdirSync(IMAGE_DIR)
    .filter(f => /\.(jpg|jpeg|heic|png)$/i.test(f))
    .sort()
    .map(f => join(IMAGE_DIR, f));

  if (files.length === 0) throw new Error(`No images found in ${IMAGE_DIR}`);

  console.log(`Found ${files.length} image(s) in ${IMAGE_DIR}\n`);

  const results: Array<{ file: string; cid: string }> = [];

  for (const sourcePath of files) {
    const name = basename(sourcePath);
    process.stdout.write(`  ${name} → converting…`);
    const jpegPath = toJpeg(sourcePath);
    process.stdout.write(' uploading…');
    const cid = await uploadToIpfs(jpegPath);
    process.stdout.write(' pinning…');
    await pinCid(cid);
    console.log(` done\n    ipfs://${cid}`);
    results.push({ file: name, cid });
  }

  console.log('\n── Summary ──────────────────────────────────────────────────');
  for (const { file, cid } of results) {
    console.log(`${file.padEnd(55)} ipfs://${cid}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
