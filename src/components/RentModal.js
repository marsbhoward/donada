// File: src/components/RentModal.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';

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
  nfts = [],
  mode = 'list', // 'list' = owner sets price; 'rent' = fee shown from datum; 'cancel' = owner cancels listing
  nextDrawDate = null,
  countdown = null,
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [rentalPrice, setRentalPrice] = useState('');
  const [sortBy, setSortBy] = useState('price-asc');
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, dragging: false, wasDrag: false });

  // Reset state when modal opens or NFTs change
  useEffect(() => {
    if (isOpen) {
      setActiveIndex(0);
      setRentalPrice('');
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

  /**
   * Carousel logic
   * - <= 4 NFTs → show 3 cards
   * - >= 5 NFTs → show 5 cards
   * - Always centered with equal sides
   */
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
            : `right-${offset}`
      });
    }

    return items;
  }, [activeIndex, sortedNfts]);

  const activeNft = sortedNfts[activeIndex];

  // Count NFTs listed at the same rental fee as the active selection
  const samePriceCount = mode === 'rent' && activeNft?.rentalFee != null
    ? sortedNfts.filter(n => n.rentalFee === activeNft.rentalFee).length
    : 0;

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{mode === 'cancel' ? 'Cancel Listing' : 'Select NFT to Rent'}</h3>

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
          <p>No NFTs available for this policy.</p>
        )}

        {visibleItems.length > 0 && (
          <div
            className="carousel-centered"
            style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'pan-y', userSelect: 'none' }}
            onPointerDown={(e) => {
              dragRef.current = { startX: e.clientX, dragging: true, wasDrag: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!dragRef.current.dragging) return;
              if (Math.abs(e.clientX - dragRef.current.startX) > 8) setIsDragging(true);
            }}
            onPointerUp={(e) => {
              if (!dragRef.current.dragging) return;
              const delta = e.clientX - dragRef.current.startX;
              dragRef.current.dragging = false;
              setIsDragging(false);
              if (Math.abs(delta) < 30) return;
              dragRef.current.wasDrag = true;
              const total = sortedNfts.length;
              setActiveIndex(i => delta < 0 ? (i + 1) % total : (i - 1 + total) % total);
            }}
            onPointerCancel={() => {
              dragRef.current = { startX: 0, dragging: false, wasDrag: false };
              setIsDragging(false);
            }}
          >
            {visibleItems.map(({ nft, index, position }) => (
              <div
                key={position}
                className={`carousel-frame ${position}`}
                onClick={() => {
                  if (dragRef.current.wasDrag) { dragRef.current.wasDrag = false; return; }
                  setActiveIndex(index);
                }}
              >
                {nft.image ? (
                  <img
                    src={nft.image}
                    alt={nft.name || nft.assetName}
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
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%' }}>
            {mode === 'cancel' ? (
              <p className="price-input" style={{ textAlign: 'center', margin: '0.5rem 0', flex: 1 }}>
                NFT will be returned to your wallet
              </p>
            ) : (
              <div style={{ position: 'relative', display: 'inline-block', flex: 1 }}>
                <span style={{
                  position: 'absolute', left: '0.6rem', top: '61%', transform: 'translateY(-50%)',
                  pointerEvents: 'none', userSelect: 'none', opacity: 0.6, fontSize: '1rem', lineHeight: 1
                }}>₳</span>
                <input
                  className="price-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="Lowest rental price"
                  value={rentalPrice}
                  onChange={(e) =>
                    setRentalPrice(e.target.value.replace(/\D/g, ''))
                  }
                  style={{ paddingLeft: '1.6rem', width: '100%' }}
                />
              </div>
            )}
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap', opacity: 0.7, fontSize: '0.85rem' }}>
              <div>Next draw</div>
              <div>{nextDrawDate ? nextDrawDate.toLocaleDateString() : '—'}</div>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="select-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="select-btn"
            disabled={!sortedNfts[activeIndex] || (mode === 'list' && !rentalPrice)}
            onClick={() =>
              onConfirm({
                nft: sortedNfts[activeIndex],
                rentalPrice
              })
            }
          >
            {mode === 'cancel' ? 'Cancel Listing' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
