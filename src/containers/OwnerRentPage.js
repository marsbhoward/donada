import { BrowserWallet } from '@meshsdk/core';
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Browser } from '@marlowe.io/runtime-lifecycle';

const OwnerRentPage = () => {
    const location = useLocation();
    const {selectedAsset} = location.state || {selectedAsset: 'No asset selected'}
    console.log(selectedAsset)
    
    
    return (
        <div>
            <h1>Asset To Rent</h1>
            <h5>{selectedAsset.assetName}</h5>
            <h5>{selectedAsset.fingerprint}</h5>
            <h5>{selectedAsset.policyId}</h5>
        </div>
    );
}

export default OwnerRentPage;