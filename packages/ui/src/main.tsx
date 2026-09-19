import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
// The vendored @font-face declarations come first so the font stacks in `global.css` resolve to
// local files rather than to a remote stylesheet. See `scripts/vendor-fonts.mjs`.
import './styles/fonts.css';
import './styles/global.css';
import './styles/highlight.css';

/*
 * Register translations and restore the saved locale BEFORE the first render.
 *
 * Doing it here rather than in `App` avoids a flash of the wrong language: the
 * first paint would otherwise use the default and then re-render.
 */
import './locales';
import { initLocale } from './lib/i18n';

initLocale();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
