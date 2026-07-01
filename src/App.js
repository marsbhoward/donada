import React, { useMemo } from 'react';
import { BrowserRouter as Router, Route, Switch } from 'react-router-dom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { clusterApiUrl } from '@solana/web3.js';
import DonadaPlatform from './containers/DonadaPlatform';
import './App2.css';

function App() {
  // Devnet for now — swap to 'mainnet-beta' for production
  const endpoint = useMemo(() => clusterApiUrl('devnet'), []);
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ], []);

  return (
    <div className="App">
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect={false}>
          <Router>
            <Switch>
              <Route exact path="/">
                <DonadaPlatform />
              </Route>
            </Switch>
          </Router>
        </WalletProvider>
      </ConnectionProvider>
    </div>
  );
}

export default App;
