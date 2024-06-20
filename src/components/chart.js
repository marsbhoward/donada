import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import '../index.css';

import data24h from '../txnFiles/data24h.csv';
import data7d from '../txnFiles/data7d.csv';
import data30d from '../txnFiles/data30d.csv';
import { CostModel } from '@emurgo/cardano-serialization-lib-browser';


//30d data should be sent to donada email before being cleared.
// this should be done with an automation script


function App(){
  const [data, setData] = useState([]);
  const [currentRentalPrice, setCurrentRentalPrice] = useState (null);
  const [jackpot, setJackpot] = useState (null);
  const [drawDate, setDrawDate] = useState (null)

  useEffect(() => {
    /* THIS NEEDS TO BE WRITTEN TO A FILE WITH THE DATE AND 
    ONLY IF THE DATE IS DIFFERENT SEND THE REQUEST ** 
    MAYBE IF PRICE IS VERY DIFFERENT ~ 100-200 REQUEST WILL BE SENT
    const fetchAdaPrice = async () => {
      try {
        const response = await fetch(
          "https://api.coingecko.com/api/v3/coins/cardano"
        );
        const data = await response.json();
        const currentprice = data.market_data.current_price.usd
        setJackpot(Math.round(currentprice * 10390).toFixed(2))
      } catch (error) {
        console.error(error);
      }
    };
    fetchAdaPrice();
    */
    load(data24h)
  }, []); // Run only once on component mount


const load = function(file){
  async function fetchData() {
    // Fetch data from the CSV file
    const response = await fetch(file);
    const text = await response.text();

    // Parse CSV data
    const rows = text.split('\n');
    const headers = rows[0].split(',');
    const rowsData = rows.slice(1).map(row => {
      const rowData = row.split(',');
      return headers.reduce((obj, header, index) => {
        obj[header] = rowData[index];
        return obj;
      }, {});
    });

   
    setCurrentRentalPrice(rowsData[rowsData.length-1].price)
    setDrawDate(getDate())
    setData(rowsData);
  }

  fetchData(); 
}


function getDate(){
  const currentDate = new Date();
  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, '0'); // Months are zero-based
  const day = String(currentDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
  

  
 
    return (
    <div>
     <div className='chart-div'>
        <LineChart width={300} height={100} data={data}>
          <Line type="monotone" dataKey="price" stroke="#8884d8" strokeWidth={2}/>
          <Tooltip wrapperStyle={{ backgroundColor: '#ccc' }} />
        </LineChart>
      </div>
      <div> 
        <button onClick={load.bind(null, data24h)}>24h</button>
        <button onClick={load.bind(null, data7d)}>7d</button>
        <button onClick={load.bind(null, data30d)}>30d</button>
      </div>
      <div className="rental-info"> 
        <p className="rental-info-section">Next Draw Date: {drawDate}</p>
        <p className="rental-info-section">Current Rental Price: ${currentRentalPrice} </p>
        <p className="rental-info-section">Current Jackpot: ${jackpot}</p>
      </div> 
    </div> 
    );


}
  export default App;