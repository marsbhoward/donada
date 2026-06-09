import React from 'react';

const EXPLORER_BASE = {
  Preview: 'https://preview.cardanoscan.io/transaction/',
  Mainnet: 'https://cardanoscan.io/transaction/',
};

export default function TxConfirmModal({ title, txHash, network = 'Preview', onClose }) {
  if (!txHash) return null;

  const explorerUrl = (EXPLORER_BASE[network] ?? EXPLORER_BASE.Preview) + txHash;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet tx-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tx-confirm-icon">✓</div>
        <h3 className="tx-confirm-title">{title}</h3>
        <div className="tx-confirm-hash-label">Transaction</div>
        <div className="tx-confirm-hash">{txHash.slice(0, 20)}…{txHash.slice(-8)}</div>
        <a
          className="tx-confirm-link"
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on CardanoScan
        </a>
        <div className="modal-actions" style={{ justifyContent: 'center', marginTop: '1.25rem' }}>
          <button className="select-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
