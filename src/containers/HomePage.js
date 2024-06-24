import { BrowserWallet } from '@meshsdk/core';
import React, { useState } from 'react';
import { useHistory} from "react-router-dom";

import Chart from '../components/chart';
import SignIn from '../components/signIn'; 
import AssetsComponenet from '../components/assets'
import { Browser } from '@marlowe.io/runtime-lifecycle';



function HomePage() {
  const history = useHistory();

 

  const [assetList, setAssetList] = useState(null);
  const [enabledWallet, setEnabledWallet] = useState("");
  const [rewardAddress, setRewardAddress] = useState("");
  const [selectedWallets, setSelectedWallets] = useState(null);
  const [display, setDisplay] = useState(<button onClick={getAssests}> Rent </button>);



  async function handleClick(selectedAsset){   
    console.log(selectedAsset)
    //const dataToPass = { selectedAsset: asset };
  
    const rentPage = await history.push(`/rent`, selectedAsset);    
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

  async function displayAssets() {

    try {
      const currentPolicyID = 'c9c4d9e7fdec835f0cb95b15348509872322a888a9fac4f64dfef0ec'
      const wallet = await BrowserWallet.enable(enabledWallet);
      const assets = await wallet.getAssets();
      

      const filteredAssets = assets.filter(asset => asset.policyId === currentPolicyID);
      setAssetList(filteredAssets)
      
    } catch (error) {
      alert("No wallet is curently selected, please connect wallet to sign in")
      console.error("Error getting wallet assets:", error);
    }
  }

  
  function getAssests(assets){
    assets !== null ? (
        setDisplay(
        <div>
            <h6 >select an asset</h6>
            <div className='asset-space'>
            {assets.map((assetName,asset, index) => (
                <div>
                <button key={index} onClick={console.log("I got pushed")}> {assetName} </button>
                <br></br>
                </div>
            ))}
            </div>
        </div>
        )
        ) :(
            setDisplay(
                <button onClick={displayAssets}> try again </button>
            )
        )       
}


  async function displayWallets() {
        
    try {
      const wallets = BrowserWallet.getInstalledWallets();
      console.log(wallets); // Logs list of retrieved wallets
      const walletNames = wallets.map(wallet => wallet.name);
      setSelectedWallets(walletNames);
    } catch (error) {
      console.error("Error displaying wallets:", error);
    }
  }

  

  return (
    <div className='container'>
      <div className='signInSection'>
        {selectedWallets !== null ? (
            <div className='sign-in'>
              {selectedWallets.map((name, index) => (
                <div >
                    <button key={index} onClick={connectWallet.bind(null, name)}>{name.toUpperCase()}</button>
                   
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
        </div>
      <div className='homePage'>
        <h1>Donada</h1>
        <h3>Collection Name</h3>
        <Chart />
        <br />      
      </div>

      {assetList !== null ? (
        <div className='ticker-space'>
          <h6>select an asset below</h6>
          <div className='asset-space'>
            {getAssests.bind(null,assetList)}
            {assetList.map((asset, index) => (
              <div className='asset-component'>
                <button onClick={handleClick.bind(null, assetList[index])} key={index}> {asset.assetName} </button>
              <br></br>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <button onClick={displayAssets}>Rent</button>
      )}
    </div>
  );
}

export default HomePage;

