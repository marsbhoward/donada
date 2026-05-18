// File: src/components/RentModal.jsx
import React, { useEffect, useMemo, useState } from 'react';

export default function RentModal({
  isOpen,
  onClose,
  onConfirm,
  nfts = [],
  mode = 'list', // 'list' = owner sets price; 'rent' = fee shown from datum; 'cancel' = owner cancels listing
  nextDrawDate = null,
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
                key={`${nft.policyId}-${nft.assetName}`}
                className={`carousel-frame ${position}`}
                onClick={() => setActiveIndex(index)}
              >
                <img
                  src={nft.image}
                  alt={nft.name || nft.assetName}
                />
                {position !== 'active' && (
                  <div className="carousel-dim" />
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%' }}>
          {mode === 'cancel' ? (
            <p className="price-input" style={{ textAlign: 'center', margin: '0.5rem 0', flex: 1, fontStyle: 'italic', opacity: 0.75 }}>
              NFT will be returned to your wallet
            </p>
          ) : mode === 'rent' ? (
            <p className="price-input" style={{ textAlign: 'center', margin: '0.5rem 0', flex: 1 }}>
              Rental fee:{' '}
              {nfts[activeIndex]?.rentalFee != null
                ? `${(Number(nfts[activeIndex].rentalFee) / 1_000_000).toFixed(2)} ADA`
                : '—'}
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
