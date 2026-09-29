import React from 'react';
import { createRoot } from 'react-dom/client';
import VisualLab from './VisualLab.jsx';

createRoot(document.getElementById('visual-lab-root')).render(
  <React.StrictMode>
    <VisualLab />
  </React.StrictMode>,
);
