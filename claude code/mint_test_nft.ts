// =============================================================================
// mint_test_nft.ts
// =============================================================================
// One-off script to mint test NFTs on the Cardano Preview testnet.
// Run this once to get a policy ID and seed your owner wallet with NFTs
// before testing the full rental flow in the browser.
//
// Prerequisites:
//   1. Blockfrost Preview project API key (https://blockfrost.io)
//   2. A wallet seed phrase — this wallet pays the tx fee and receives the NFTs
//   3. At least 5 tADA in the wallet (faucet: https://docs.cardano.org/cardano-testnet/tools/faucet)
//
// Setup — add to your .env file:
//   REACT_APP_BlockFrost_API_KEY=previewXXXXXXXXXXXXXXXX   (already set)
//   OWNER_SEED_PHRASE="word1 word2 word3 ... word24"        (uncomment and fill in)
//
// Run:
//   npx tsx "claude code/mint_test_nft.ts"
//   -- or --
//   npx ts-node "claude code/mint_test_nft.ts"
//
// After running, copy the printed Policy ID into NewHome2.tsx as both
// DONADA_POLICY_ID and DEFAULT_POLICY_ID.
// =============================================================================

import { Lucid, Blockfrost, fromText } from "lucid-cardano";
import type { ProtocolParameters } from "lucid-cardano";

// Preview testnet is now on Conway era; the cost model returned by Blockfrost
// has more entries than CSL 11.x can hold.  Since we only mint native scripts
// (no Plutus execution), truncating is safe — fee calculations don't use
// Plutus cost models at all.
const PLUTUS_V1_MAX = 166;
const PLUTUS_V2_MAX = 175;

function truncateCostModels(params: ProtocolParameters): ProtocolParameters {
  const cm = params.costModels as Record<string, Record<string, number>> | undefined;
  if (!cm) return params;
  const patched = { ...cm };
  if (patched.PlutusV1) {
    const entries = Object.entries(patched.PlutusV1).slice(0, PLUTUS_V1_MAX);
    patched.PlutusV1 = Object.fromEntries(entries);
  }
  if (patched.PlutusV2) {
    const entries = Object.entries(patched.PlutusV2).slice(0, PLUTUS_V2_MAX);
    patched.PlutusV2 = Object.fromEntries(entries);
  }
  return { ...params, costModels: patched as ProtocolParameters["costModels"] };
}

class ConwayCompatBlockfrost extends Blockfrost {
  override async getProtocolParameters(): Promise<ProtocolParameters> {
    return truncateCostModels(await super.getProtocolParameters());
  }
}

// NFTs to mint — add or remove names as needed for your tests.
const NFT_NAMES = ["DonodaNFT001", "DonodaNFT002", "DonodaNFT003"];

async function main() {
  const apiKey = process.env.REACT_APP_BlockFrost_API_KEY;
  const seed   = process.env.OWNER_SEED_PHRASE;

  if (!apiKey) throw new Error("Missing REACT_APP_BlockFrost_API_KEY in environment.");
  if (!seed)   throw new Error("Missing OWNER_SEED_PHRASE in environment.");

  const lucid = await Lucid.new(
    new ConwayCompatBlockfrost("https://cardano-preview.blockfrost.io/api/v0", apiKey),
    "Preview"
  );

  lucid.selectWalletFromSeed(seed);

  const address = await lucid.wallet.address();
  console.log("\nMinting from address:", address);

  // Build a signature-based native script: only this wallet key can mint.
  // No time lock — convenient for testnet; add validTo for mainnet.
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  if (!paymentCredential) throw new Error("No payment credential on address.");

  const mintingPolicy = lucid.utils.nativeScriptFromJson({
    type: "sig",
    keyHash: paymentCredential.hash,
  });

  const policyId = lucid.utils.mintingPolicyToId(mintingPolicy);

  console.log("\n══════════════════════════════════════════════════════");
  console.log("Policy ID:", policyId);
  console.log("Copy this into NewHome2.tsx as DONADA_POLICY_ID and DEFAULT_POLICY_ID");
  console.log("══════════════════════════════════════════════════════\n");

  // Build one mint entry per NFT name
  const assets: Record<string, bigint> = {};
  for (const name of NFT_NAMES) {
    assets[policyId + fromText(name)] = BigInt(1);
  }

  console.log("Minting:", NFT_NAMES.join(", "));

  const tx = await lucid
    .newTx()
    .mintAssets(assets)
    .attachMintingPolicy(mintingPolicy)
    .complete();

  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  console.log("\nSuccess!");
  console.log("Tx hash:", txHash);
  console.log("Explorer: https://preview.cardanoscan.io/transaction/" + txHash);
  console.log("\nWait ~20 seconds for confirmation, then the NFTs will appear in your wallet.\n");
}

main().catch((err) => {
  console.error("\nMint failed:", err);
  process.exit(1);
});
