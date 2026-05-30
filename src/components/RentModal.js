// File: src/components/RentModal.jsx
import React, { useEffect, useMemo, useState } from 'react';

function formatAda(lovelace) {
  return parseFloat((Number(lovelace) / 1_000_000).toFixed(2)).toString();
}

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

  // Reset state when modal opens or NFTs change
  useEffect(() => {
    if (isOpen) {
      setActiveIndex(0);
      setRentalPrice('');
    }
  }, [isOpen, nfts]);

  /**
   * Carousel logic
   * - <= 4 NFTs → show 3 cards
   * - >= 5 NFTs → show 5 cards
   * - Always centered with equal sides
   */
  const visibleItems = useMemo(() => {
    if (!nfts.length) return [];

    const total = nfts.length;
    const maxVisible = total <= 4 ? 3 : 5;
    const sideCount = Math.floor(maxVisible / 2);

    const items = [];

    for (let offset = -sideCount; offset <= sideCount; offset++) {
      const index = (activeIndex + offset + total) % total;

      items.push({
        nft: nfts[index],
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
  }, [activeIndex, nfts]);

  const activeNft = nfts[activeIndex];

  // Count NFTs listed at the same rental fee as the active selection
  const samePriceCount = mode === 'rent' && activeNft?.rentalFee != null
    ? nfts.filter(n => n.rentalFee === activeNft.rentalFee).length
    : 0;

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{mode === 'cancel' ? 'Cancel Listing' : 'Select NFT to Rent'}</h3>

        {nfts.length === 0 && (
          <p>No NFTs available for this policy.</p>
        )}

        {visibleItems.length > 0 && (
          <div className="carousel-centered">
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
            disabled={!nfts[activeIndex] || (mode === 'list' && !rentalPrice)}
            onClick={() =>
              onConfirm({
                nft: nfts[activeIndex],
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
