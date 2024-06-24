import { BrowserWallet } from '@meshsdk/core';
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Browser } from '@marlowe.io/runtime-lifecycle';

const OwnerRentPage = (props) => {
    const location = useLocation();
    let selectedAsset  = null
    location.state !== undefined?(
        selectedAsset = location.state 
    ):(
        console.log("do that")
    )
  
    function divClick () {
        console.log(location.state)
    }
    
    return (
        <div>
            {selectedAsset !== null ? (
                <div className='ticker-space'>
                    <h1 onClick={divClick}>Asset To Rent</h1>
                    <h5>{selectedAsset.assetName}</h5>
                    <h5>{selectedAsset.fingerprint}</h5>
                    <h5>{selectedAsset.policyId}</h5>
                </div>
      ) : (
        <h1>No asset selected</h1>
      )}
        </div>
    );
}

export default OwnerRentPage;