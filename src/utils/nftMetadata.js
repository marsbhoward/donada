// File: src/utils/nftMetadata.js

const BLOCKFROST_URLS = {
  Mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  Preview: 'https://cardano-preview.blockfrost.io/api/v0',
};

// Blockfrost's public gateway — the collection is pinned via Blockfrost IPFS,
// so their node serves it natively. (ipfs.io/dweb.link 410 some of our CIDs —
// they share a denylist that has falsely flagged pinned content.)
const IPFS_GATEWAY = 'https://ipfs.blockfrost.dev/ipfs/';

// Serve IPFS images through wsrv.nl's caching CDN, resized to what the UI
// actually renders. Full-size NFT images over public IPFS gateways routinely
// take seconds to load; a CDN-cached 640px webp is a few tens of KB.
export function ipfsToHttp(uri, width = 640) {
  if (!uri) return null;
  const flat = Array.isArray(uri) ? uri.join('') : String(uri);
  const direct = flat.startsWith('ipfs://') ? flat.replace('ipfs://', IPFS_GATEWAY) : flat;
  if (!/^https?:\/\//.test(direct)) return direct;
  return `https://wsrv.nl/?url=${encodeURIComponent(direct)}&w=${width}&output=webp&q=80`;
}

// <img onError> handler: if the CDN proxy fails, fall back to the direct
// gateway URL (the swap changes the hostname, so this can't loop).
export function ipfsImgFallback(e) {
  try {
    const url = new URL(e.currentTarget.src);
    if (url.hostname === 'wsrv.nl') {
      const orig = url.searchParams.get('url');
      if (orig) e.currentTarget.src = orig;
    }
  } catch { /* leave the broken image */ }
}

// Warm the browser cache so modal images are already loaded when it opens.
export function preloadImages(nfts) {
  for (const n of nfts) {
    if (n?.image) { const img = new Image(); img.src = n.image; }
  }
}

// --- UTF-8 <-> HEX helpers (Cardano asset names) ---
export function utf8ToHex(str) {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToUtf8(hex) {
  return new TextDecoder().decode(
    Uint8Array.from(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)))
  );
}

// --- Fetch NFT metadata from Blockfrost ---
// On-chain CIP-25 metadata is immutable once minted, so successful lookups are
// cached for the session — the listing/rent/cancel modals re-request the same
// assets on every open.
const _metadataCache = new Map();

export async function fetchNftMetadata(policyId, assetName, network = 'Preview') {
  const cacheKey = `${network}:${policyId}:${assetName}`;
  if (_metadataCache.has(cacheKey)) return _metadataCache.get(cacheKey);

  const base   = BLOCKFROST_URLS[network] ?? BLOCKFROST_URLS.Preview;
  const apiKey = network === 'Mainnet'
    ? process.env.REACT_APP_BlockFrost_API_KEY_Mainnet
    : process.env.REACT_APP_BlockFrost_API_KEY_Preview;

  try {
    // Convert UTF-8 asset name to hex (Cardano format)
    const assetNameHex = utf8ToHex(assetName);
    const assetId = `${policyId}${assetNameHex}`;

    const res = await fetch(`${base}/assets/${assetId}`, {
      headers: {
        project_id: apiKey
      }
    });

    if (!res.ok) {
      throw new Error('Blockfrost asset fetch failed');
    }

    const data = await res.json();

    const onchain = data.onchain_metadata || {};
    const image = ipfsToHttp(onchain.image);

    const result = {
      policyId,
      assetName,
      assetNameHex,
      assetId,
      name: onchain.name || hexToUtf8(assetNameHex),
      image,
      metadata: onchain
    };
    _metadataCache.set(cacheKey, result); // errors are never cached — they stay retryable
    return result;
  } catch (err) {
    console.error('fetchNftMetadata error:', err);

    return {
      policyId,
      assetName,
      assetNameHex: null,
      assetId: null,
      name: assetName,
      image: null,
      metadata: null,
      error: true
    };
  }
}
