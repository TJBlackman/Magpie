import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../src/ui/style.css';
import { Popup } from './Popup';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
