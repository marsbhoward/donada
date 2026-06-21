import React from 'react';



function Assets(props) {
// retrieve get assets
//onClick={props.handleDisplayAssets}
    
    return(    
        <div className='asset-component'> 
            {props.display}
        </div>
    )
}

export default Assets;