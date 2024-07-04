import { BrowserWallet } from '@meshsdk/core';
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
//import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import axios from 'axios';

import { Browser } from '@marlowe.io/runtime-lifecycle';
import { policyId } from '@marlowe.io/runtime-core';


const OwnerRentPage = (props) => {
    const location = useLocation();
    const [container, setContainer] = useState('rent-container');
    const [assetAttributes, setAssetAttributes] = useState(null)
    
   
    let selectedAsset  = null
    
    location.state !== undefined?(
        selectedAsset = location.state 
    ):(
        console.log("do that")
    )

  
    function divClick () {
        console.log(location.state)
        getAssetData(selectedAsset.policyId, selectedAsset.assetName)
    }

    function strToHex (assetName) {
            let hex = '';
            for (let i = 0; i < assetName.length; i++) {
              hex += assetName.charCodeAt(i).toString(16).padStart(2, '0');
            }
            return hex;
    }

    async function getAssetData (assetPolicyId, assetAssetName) {
       const apiKey = process.env.REACT_APP_BlockFrost_API_KEY
       const convertedAssetName = strToHex(assetAssetName)

       const httpString = "https://cardano-mainnet.blockfrost.io/api/v0/assets/"+ assetPolicyId + convertedAssetName


       //'curl -H "project_id: $PROJECT_ID" https://cardano-mainnet.blockfrost.io/api/v0/blocks/latest'
       
        console.log(httpString);


        
        try{
            const response = await axios.get(httpString,{
                headers: {
                    'project_id': apiKey
                }
            })
            setAssetAttributes(response.data);
            console.log(response.data);
        }
        catch (error){
            console.error('Error fetching data', error);
        }
        
    }

    function switchView (){
        console.log(container)
        container === 'rent-container' ?(
            setContainer('rent-container-open')
        ):(
            setContainer('rent-container')
        )
    }

    // need compentning for signin and then bring it in here
    return (
        <div className='rent-page'>
            <div className={container}>
            <div className='sidecar-left'></div>
            {selectedAsset !== null ? (
                <div className='ticker-space'>
                    <h1 onClick={divClick}>Asset To Rent</h1>
                    <h5>{selectedAsset.assetName}</h5>
                    <div className='card-container'></div>
                    <h5>{selectedAsset.fingerprint}</h5>
                    <h5>{selectedAsset.policyId}</h5>
                    <button className='switchButton' onClick={switchView}>select another asset</button>
                </div>
      ) : (
        <h1>No asset selected</h1>
      )}
            </div>
        </div>
    );
}

export default OwnerRentPage;