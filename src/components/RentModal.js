// File: src/components/RentModal.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ipfsImgFallback } from '../utils/nftMetadata';

function formatAda(lovelace) {
  return parseFloat((Number(lovelace) / 1_000_000).toFixed(2)).toString();
}

const SORT_OPTIONS = [
  { value: 'price-asc',   label: 'Price: Low to High' },
  { value: 'price-desc',  label: 'Price: High to Low' },
  { value: 'count-desc',  label: 'Most Listed Price' },
];

export default function RentModal({
  isOpen,
  onClose,
  onConfirm,
  onBatchRent = null,   // rent mode: budget-based batch rent callback (receives NftAsset[])
  batchRentCap = 10,    // max listings per batch-rent transaction
  nfts = [],
  mode = 'list', // 'list' = owner sets price; 'rent' = fee shown from datum; 'cancel' = owner cancels listing
  nextDrawDate = null,
  countdown = null,
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [rentalPrice, setRentalPrice] = useState('');
  const [listQty, setListQty] = useState(1);
  const [batchBudget, setBatchBudget] = useState('');
  const [sortBy, setSortBy] = useState('price-asc');
  const [showRentInfo, setShowRentInfo] = useState(false);
  const touchRef = useRef({ startX: 0 });

  // Reset state when modal opens or NFTs change
  useEffect(() => {
    if (isOpen) {
      setActiveIndex(0);
      setRentalPrice('');
      setListQty(1);
      setBatchBudget('');
      setSortBy('price-asc');
    }
  }, [isOpen, nfts]);

  // Sorted NFT list (only applied in rent mode)
  const sortedNfts = useMemo(() => {
    if (mode !== 'rent' || !nfts.length) return nfts;

    const priceCount = {};
    for (const n of nfts) {
      const key = n.rentalFee ?? 'null';
      priceCount[key] = (priceCount[key] || 0) + 1;
    }

    const sorted = [...nfts];
    const fee = (n) => n.rentalFee != null ? Number(n.rentalFee) : Infinity;
    if (sortBy === 'price-asc') {
      sorted.sort((a, b) => fee(a) - fee(b));
    } else if (sortBy === 'price-desc') {
      sorted.sort((a, b) => fee(b) - fee(a));
    } else if (sortBy === 'count-desc') {
      sorted.sort((a, b) => {
        const countDiff = (priceCount[b.rentalFee ?? 'null'] || 0) - (priceCount[a.rentalFee ?? 'null'] || 0);
        if (countDiff !== 0) return countDiff;
        return fee(a) - fee(b);
      });
    }
    return sorted;
  }, [nfts, sortBy, mode]);

  const activeNft = sortedNfts[activeIndex];

  // List mode: one tx = one signing wallet, so the batch ceiling is how many
  // owned NFTs share the active NFT's wallet.
  const maxListQty = mode === 'list' && activeNft
    ? Math.max(1, nfts.filter(n => n.walletKey === activeNft.walletKey).length)
    : 1;
  const qty = Math.min(listQty, maxListQty);

  // Keyboard navigation — arrow keys cycle carousel, Enter submits
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const total = sortedNfts.length;
      if (e.key === 'ArrowLeft') {
        setActiveIndex(i => (i - 1 + total) % total);
      } else if (e.key === 'ArrowRight') {
        setActiveIndex(i => (i + 1) % total);
      } else if (e.key === 'Enter') {
        const canConfirm = sortedNfts[activeIndex] && (mode !== 'list' || rentalPrice);
        if (canConfirm) onConfirm({ nft: sortedNfts[activeIndex], rentalPrice, quantity: qty });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, sortedNfts, activeIndex, mode, rentalPrice, qty, onConfirm]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleItems = useMemo(() => {
    if (!sortedNfts.length) return [];

    const total = sortedNfts.length;
    const maxVisible = total <= 4 ? 3 : 5;
    const sideCount = Math.floor(maxVisible / 2);

    const items = [];
    for (let offset = -sideCount; offset <= sideCount; offset++) {
      const index = (activeIndex + offset + total) % total;
      items.push({
        nft: sortedNfts[index],
        index,
        position:
          offset === 0
            ? 'active'
            : offset < 0
            ? `left-${Math.abs(offset)}`
            : `right-${offset}`,
      });
    }
    return items;
  }, [activeIndex, sortedNfts]);

  const samePriceCount = mode === 'rent' && activeNft?.rentalFee != null
    ? sortedNfts.filter(n => n.rentalFee === activeNft.rentalFee).length
    : 0;

  // Rent mode: cheapest-first selection that fits the budget, capped per tx.
  const batchSelection = useMemo(() => {
    if (mode !== 'rent' || !batchBudget) return { picks: [], total: 0, capped: false };
    const budgetLovelace = Number(batchBudget) * 1_000_000;
    const byPrice = nfts
      .filter(n => n.rentalFee != null)
      .sort((a, b) => Number(a.rentalFee) - Number(b.rentalFee));
    const picks = [];
    let total = 0;
    let capped = false;
    for (const n of byPrice) {
      if (picks.length >= batchRentCap) { capped = true; break; }
      const fee = Number(n.rentalFee);
      if (total + fee > budgetLovelace) break;
      picks.push(n);
      total += fee;
    }
    return { picks, total, capped };
  }, [mode, batchBudget, nfts, batchRentCap]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title-row">
          <h3>{mode === 'cancel' ? 'Cancel Listing' : 'Select NFT to Rent'}</h3>
          {mode !== 'cancel' && (
            <button className="rent-info-btn" onClick={() => setShowRentInfo(true)}>?</button>
          )}
        </div>

        {showRentInfo && (
          <div className="rent-info-overlay" onClick={() => setShowRentInfo(false)}>
            <div className="rent-info-card" onClick={e => e.stopPropagation()}>
              <button className="rent-info-close" onClick={() => setShowRentInfo(false)}>✕</button>
              {mode === 'rent' ? (
                <>
                  <h4>How Rentals Work</h4>
                  <p>Pay the listed rental fee to register your wallet as an entry for the upcoming draw.</p>
                  <p>Your rental — and your entry — lasts until the draw date shown. When the draw fires, a winner is selected at random from all active renters and NFT holders.</p>
                  <p>Prize payouts are automatic and on-chain. If the draw passes without a renter, the NFT is returned to its owner.</p>
                </>
              ) : (
                <>
                  <h4>How Listing Works</h4>
                  <p>Set a rental fee and your NFT is locked at the contract address, open for any renter to claim before the draw.</p>
                  <p>When someone rents it, the entry becomes shared — if it wins, the prize is split 90% to the renter and 10% to you as the owner.</p>
                  <p>You can cancel the listing at any time before it is rented. After the draw, all NFTs on the contract — rented or not — are returned to their owners automatically.</p>
                </>
              )}
            </div>
          </div>
        )}

        {mode === 'rent' && nfts.length > 1 && (
          <div className="sort-controls">
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`sort-btn${sortBy === opt.value ? ' active' : ''}`}
                onClick={() => { setSortBy(opt.value); setActiveIndex(0); }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {sortedNfts.length === 0 && (
          <p style={{ textAlign: 'center', opacity: 0.6, padding: '24px 0' }}>
            No listings available right now.
          </p>
        )}

        {visibleItems.length > 0 && (
          <div
            className="carousel-centered"
            style={{ touchAction: 'pan-y' }}
            onTouchStart={(e) => { touchRef.current.startX = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const delta = e.changedTouches[0].clientX - touchRef.current.startX;
              if (Math.abs(delta) < 30) return;
              const total = sortedNfts.length;
              setActiveIndex(i => delta < 0 ? (i + 1) % total : (i - 1 + total) % total);
            }}
          >
            {visibleItems.map(({ nft, index, position }) => (
              <div
                key={position}
                className={`carousel-frame ${position}`}
                onClick={() => setActiveIndex(index)}
              >
                {nft.image ? (
                  <img
                    src={nft.image}
                    alt={nft.name || nft.assetName}
                    onError={ipfsImgFallback}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', textAlign: 'center', padding: '0.25rem',
                    opacity: 0.6,
                  }}>
                    {nft.name || nft.assetName}
                  </div>
                )}
                {position !== 'active' && (
                  <div className="carousel-dim" />
                )}
                {position === 'active' && mode === 'rent' && (
                  <div className="carousel-overlay">
                    <div className="carousel-overlay-fee">
                      {nft.rentalFee != null ? `₳ ${formatAda(nft.rentalFee)}` : '—'}
                    </div>
                    {samePriceCount > 0 && (
                      <div className="carousel-overlay-count">
                        {samePriceCount} NFT{samePriceCount !== 1 ? 's' : ''} listed at this price
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {mode === 'rent' ? (
          <>
            <div className="modal-draw-info">
              <div className="modal-draw-label">Next draw</div>
              <div className="modal-draw-date">
                {nextDrawDate ? nextDrawDate.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' }) : '—'}
              </div>
              {countdown && (
                <div className="modal-draw-countdown">
                  {countdown.days}D {countdown.hours}H {countdown.minutes}M {countdown.seconds}S
                </div>
              )}
            </div>

            {onBatchRent && sortedNfts.length > 1 && (
              <div className="batch-rent-section">
                <div className="batch-rent-row">
                  <div style={{ position: 'relative', flex: '1 1 0', minWidth: 0 }}>
                    <span style={{
                      position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)',
                      pointerEvents: 'none', userSelect: 'none', opacity: 0.6, fontSize: '1rem', lineHeight: 1
                    }}>₳</span>
                    <input
                      className="price-input"
                      type="text"
                      inputMode="numeric"
                      placeholder="Budget — rent multiple"
                      value={batchBudget}
                      onChange={(e) => setBatchBudget(e.target.value.replace(/\D/g, ''))}
                      style={{ paddingLeft: '1.6rem', width: '100%', boxSizing: 'border-box' }}
                    />
                  </div>
                  <button
                    className="select-btn"
                    disabled={batchSelection.picks.length === 0}
                    onClick={() => onBatchRent(batchSelection.picks)}
                  >
                    Rent {batchSelection.picks.length > 0 ? batchSelection.picks.length : ''}
                  </button>
                </div>
                <p className="batch-rent-hint">
                  {batchBudget && batchSelection.picks.length > 0
                    ? `₳ ${formatAda(batchSelection.total)} covers ${batchSelection.picks.length} of ${sortedNfts.length} listings, cheapest first${batchSelection.capped ? ` — limited to ${batchRentCap} per transaction` : ''}`
                    : batchBudget
                    ? 'Budget doesn’t cover the cheapest listing'
                    : `Enter a budget to rent several at once (up to ${batchRentCap} per transaction)`}
                </p>
              </div>
            )}
          </>
        ) : (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', flexWrap: 'nowrap' }}>
            {mode === 'cancel' ? (
              <p className="price-input" style={{ textAlign: 'center', margin: '0.5rem 0', flex: 1 }}>
                NFT will be returned to your wallet
              </p>
            ) : (
              <>
                {maxListQty > 1 && (
                  <div
                    className="qty-wheel"
                    title={`How many NFTs to list at this price (up to ${maxListQty})`}
                    onWheel={e => {
                      e.preventDefault();
                      setListQty(q => {
                        const next = Math.min(q, maxListQty) + (e.deltaY < 0 ? 1 : -1);
                        return next > maxListQty ? 1 : next < 1 ? maxListQty : next;
                      });
                    }}
                  >
                    <button
                      className="qty-arrow"
                      onClick={() => setListQty(q => Math.min(q, maxListQty) >= maxListQty ? 1 : Math.min(q, maxListQty) + 1)}
                    >▲</button>
                    <span className="qty-value">{qty}</span>
                    <button
                      className="qty-arrow"
                      onClick={() => setListQty(q => Math.min(q, maxListQty) <= 1 ? maxListQty : Math.min(q, maxListQty) - 1)}
                    >▼</button>
                  </div>
                )}
                <div style={{ position: 'relative', flex: '1 1 0', minWidth: 0 }}>
                  <span style={{
                    position: 'absolute', left: '0.6rem', top: '61%', transform: 'translateY(-50%)',
                    pointerEvents: 'none', userSelect: 'none', opacity: 0.6, fontSize: '1rem', lineHeight: 1
                  }}>₳</span>
                  <input
                    className="price-input"
                    type="text"
                    inputMode="numeric"
                    placeholder={qty > 1 ? 'Rental price each' : 'Rental price'}
                    value={rentalPrice}
                    onChange={(e) => setRentalPrice(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && sortedNfts[activeIndex] && rentalPrice) {
                        onConfirm({ nft: sortedNfts[activeIndex], rentalPrice, quantity: qty });
                      }
                    }}
                    style={{ paddingLeft: '1.6rem', width: '100%', boxSizing: 'border-box' }}
                  />
                </div>
              </>
            )}
            <div style={{ flexShrink: 0, textAlign: 'right', whiteSpace: 'nowrap', opacity: 0.7, fontSize: '0.85rem' }}>
              <div>Next draw</div>
              <div>{nextDrawDate ? nextDrawDate.toLocaleDateString() : '—'}</div>
            </div>
          </div>
          {mode === 'list' && qty > 1 && (
            <p className="batch-rent-hint">
              Lists the shown NFT plus {qty - 1} more from the same wallet, all at ₳ {rentalPrice || '—'} each
            </p>
          )}
          </>
        )}

        <div className="modal-actions">
          <button className="select-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="select-btn"
            disabled={!sortedNfts[activeIndex] || (mode === 'list' && !rentalPrice)}
            onClick={() => onConfirm({ nft: sortedNfts[activeIndex], rentalPrice, quantity: qty })}
          >
            {mode === 'cancel' ? 'Cancel Listing' : mode === 'list' && qty > 1 ? `List ${qty}` : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
