import { BrowserWallet } from '@meshsdk/core';
import React, { useState } from 'react';
import { useHistory} from "react-router-dom";

import Chart from '../components/chart'
import { Browser } from '@marlowe.io/runtime-lifecycle';

function HomePage() {
  const history = useHistory();

  const [selectedWallets, setSelectedWallets] = useState(null);
  
  const [enabledWallet, setEnabledWallet] = useState("");
  const [assets, setAssests] = useState(null);
  const [rewardAddress, setRewardAddress] = useState("");
  const [assetList, setAssetList] = useState(null);

  async function displayWallets() {
    try {
      const wallets = await BrowserWallet.getInstalledWallets();
      console.log(wallets); // Log retrieved wallets
     const walletNames = wallets.map(wallet => wallet.name);
     setSelectedWallets(walletNames);
    } catch (error) {
      console.error("Error displaying wallets:", error);
    }
  }

  async function displayAssets() {
    try {
      const wallet = await BrowserWallet.enable(enabledWallet);
      const assets = await wallet.getAssets();
      

      const filteredAssets = assets.filter(asset => asset.policyId === 'c9c4d9e7fdec835f0cb95b15348509872322a888a9fac4f64dfef0ec');
      setAssetList(filteredAssets)
      const filteredAssetNames = filteredAssets.map(asset => asset.assetName);
      

      setAssests(filteredAssetNames);
    } catch (error) {
      alert("No wallet is curently selected, please connect wallet to sign in")
      console.error("Error getting wallet assets:", error);
    }
  }

  async function connectWallet(walletName){
    try{
      const wallet = await BrowserWallet.enable(walletName);
      setEnabledWallet(walletName)
      const rewardAddresses = await wallet.getRewardAddresses();
      setRewardAddress(rewardAddresses)
      //const signature = await wallet.signData(rewardAddresses[0], 'read assets in wallet');
      //console.log("enabledWallet:" + enabledWallet)
      //console.log("rewardAddresses:" + rewardAddresses)

      // add wallet to cashe to remain signed in 
    }catch (error) {
        console.error("Error connecting to wallet:", error);
      }
  }

  function handleClick(asset){
    console.log(asset)
    const dataToPass = { selectedAsset: asset };
  
    history.push(`/rent`, dataToPass);    
  }


  return (
    <div>
    {selectedWallets !== null ? (
      <div className='sign-in'>
        <h6>select a wallet</h6>
        {selectedWallets.map((name, index) => (
          <div>
          <button key={index} onClick={connectWallet.bind(null, name)}>{name}</button>
          <br></br>
          </div>
        ))}
      </div>
    ) : (
      <div className='sign-in'>
        <div className='sign-in-section'></div>
        <div className='sign-in-section'></div>
        <div className='sign-in-section'>
          <button className='sign-in-button' onClick={displayWallets}>Connect Wallet</button>
        </div>
      </div>
    )}
      <h1>Donada</h1>
      <h3>Collection Name</h3>
      <Chart/>
      <br />
      {assets !== null ? (
        <div>
          <h6>select an asset</h6>
          {assets.map((assetName, index) => (
            <div>
              <button onClick={handleClick.bind(null, assetList[index])} key={index}> {assetName} </button>
            <br></br>
            </div>
          ))}
        </div>
      ) : (
        <button onClick={displayAssets}>Rent</button>
      )}      
    </div>
  );
}

export default HomePage;

