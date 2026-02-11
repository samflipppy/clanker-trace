import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { App } from './App';
import { RunsPage } from './pages/RunsPage';
import { TimelinePage } from './pages/TimelinePage';
import { MetricsPage } from './pages/MetricsPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<RunsPage />} />
          <Route path="runs/:runId" element={<TimelinePage />} />
          <Route path="metrics" element={<MetricsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
