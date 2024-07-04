import React, { useState } from 'react';
import { BrowserWallet } from '@meshsdk/core';


function SignIn(props){
    
    function test (){
        console.log(props.selectedWallets)
        console.log(props)
    }

    return (
        <div className='signInSection'>
        {props.selectedWallets !== null ? (
            <div className='sign-in'>
              {props.selectedWallets.map((name, index) => (
                <div >
                    <button key={index} onClick={props.connectWallet.bind(null, name)}>{name.toUpperCase()}</button>
                    <button onClick={test}>test</button>
                    <br></br>
                </div>
              ))} 
            </div>
          ) : (
            <div className='header'>
              <div className='header-section'></div>
              <div className='header-section'></div>
              <div className='header-section'>
                <button className='header-button' onClick={props.displayWallets}>Connect Wallet</button>
              </div>
            </div>
          )}
        </div>
    )
}
export default SignIn;