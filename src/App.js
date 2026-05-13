import React from 'react';
import {BrowserRouter as Router, Route, Switch} from 'react-router-dom';
import NewHome2 from './containers/NewHome2';
import './App2.css';

function App() {
  return (
    <div className="App">
      <Router>
        <Switch>
          <Route exact path="/">
            <NewHome2 />
          </Route>
        </Switch>
      </Router>
    </div>
  );
}

export default App;