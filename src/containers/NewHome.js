// File: src/containers/NewHome.js
import React, { useState } from 'react';
import RentModal from '../components/RentModal';

// ---- Cardano wallet detection (CIP-30) ----
const getAvailableWallets = () => {
  if (!window.cardano) return [];

  return Object.entries(window.cardano)
    .filter(([_, wallet]) => wallet && wallet.enable)
    .map(([key, wallet]) => ({
      key,
      name: wallet.name || key,
      icon: wallet.icon || null,
      api: wallet
    }));
};

export default function NewHome() {
  // ----- Rent modal state -----
  const [showRentModal, setShowRentModal] = useState(false);
  const [rentalPrice, setRentalPrice] = useState(null);
  const [selectedNft, setSelectedNft] = useState(null);

  // ----- Wallet state -----
  const [wallets, setWallets] = useState([]);
  const [connectedWallet, setConnectedWallet] = useState(null);
  const [walletAddress, setWalletAddress] = useState(null);

  // Mock owned NFTs (replace with wallet data later)
  const ownedNfts = [
    { image: '/images/nft/nft1.png', name: 'NFT #1' },
    { image: '/images/nft/nft2.png', name: 'NFT #2' },
    { image: '/images/nft/nft3.png', name: 'NFT #3' }
  ];

  // ----- Wallet handlers -----
  const handleSelectWallet = () => {
    // Disconnect if already connected
    if (connectedWallet) {
      setConnectedWallet(null);
      setWalletAddress(null);
      setWallets([]);
      return;
    }

    const detected = getAvailableWallets();
    setWallets(detected);

    if (detected.length === 1) {
      connectWallet(detected[0]);
    }
  };

  const connectWallet = async (wallet) => {
    try {
      const api = await wallet.api.enable();
      const addresses = await api.getUsedAddresses();

      const shortAddress = addresses?.[0]
        ? `${addresses[0].slice(0, 7)}…`
        : null;

      setConnectedWallet({ name: wallet.name, api });
      setWalletAddress(shortAddress);
      setWallets([]); // hide chooser after connect
      console.log(wallet.api)
    } catch (err) {
      console.error('Wallet connection rejected', err);
    }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1 className="logo">DONADA</h1>
        <div className="user-controls">
          <button className="select-btn" onClick={handleSelectWallet}>
            {connectedWallet ? 'Disconnect Wallet' : 'Select Wallet'}
          </button>

          {connectedWallet ? (
            <div className="user-label">
              <div className="wallet-name">{connectedWallet.name} Connected</div>
              <div className="wallet-address">{walletAddress}</div>
            </div>
          ) : (
            <span className="user-label">No wallet</span>
          )}
        </div>
      </header>

      {/* Wallet chooser (mobile-first list) */}
      {wallets.length > 1 && !connectedWallet && (
        <div className="wallet-list">
          {wallets.map((wallet) => (
            <button
              key={wallet.key}
              className="select-btn"
              onClick={() => connectWallet(wallet)}
            >
              {wallet.name}
            </button>
          ))}
        </div>
      )}

      <main className="main-content">
        <div className="nft-card">
          <div className="nft-image">
            <div className="nft-image-inner">NFT IMAGE</div>
            <div className="nft-details">
              <p className="mint-name">Mint Name</p>
              <p className="policy-id">Policy ID</p>
              <p className="meta">lot x NFTs</p>
              <p className="meta">lot x entries</p>
            </div>
          </div>

          <div className="info-sections">
            <div className="left-section">
              <div className="info-block">
                <p className="label">Next Draw Date:</p>
                <p className="value">MM DD YY</p>
              </div>

              <hr className="section-break" />

              <div className="info-block">
                <p className="label">Countdown:</p>
                <p className="value">DD HH MM</p>
              </div>
            </div>

            <div className="right-section">
              <div className="action-block">
                <div className="action-text">Rent at price</div>
                <button
                  className="select-btn small"
                  onClick={() => setShowRentModal(true)}
                >
                  select
                </button>
              </div>

              <hr className="section-break" />

              <div className="action-block">
                <div className="action-text">Rent out your NFT</div>
                <button
                  className="select-btn small"
                  onClick={() => setShowRentModal(true)}
                >
                  select
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <RentModal
        isOpen={showRentModal}
        walletApi={connectedWallet?.api}
        onClose={() => setShowRentModal(false)}
        onConfirm={({ nft, rentalPrice }) => {
            setSelectedNft(nft);
            setRentalPrice(rentalPrice);
            setShowRentModal(false);
        }}
      />
    </div>
  );
}
