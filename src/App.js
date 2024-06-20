import React, { Component } from 'react';
import {
  BrowserRouter as Router,
  Route
} from 'react-router-dom';

import HomePage from './containers/HomePage';
import HomePageOld from './containers/HomePageOld';
import OwnerRentPage from './containers/OwnerRentPage'

import './App.css';


function App() {
  return (
    <div className="App">
      <header className="App-header">
      <Router>
        <div>
          <Route exact path="/" render={() => <div><HomePage/> </div>}/>
          <Route exact path="/Rent" render={() => <div><OwnerRentPage/> </div>}/>
        </div>
      </Router>
      </header>
    </div>
  );
}

export default App;
