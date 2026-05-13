import React from 'react';
import {BrowserRouter as Router, Route, Switch} from 'react-router-dom';
import DonadaPlatform from './containers/DonadaPlatform';
import './App2.css';

function App() {
  return (
    <div className="App">
      <Router>
        <Switch>
          <Route exact path="/">
            <DonadaPlatform />
          </Route>
        </Switch>
      </Router>
    </div>
  );
}

export default App;