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
import { hydrateUiState, startUiStateSync } from './lib/uiState';

/*
 * 界面状态（草稿、推理档位、技能档、快捷键、"知道了"…）跟着**工作区**走，不跟着端口走：
 * 先把上一次的快照灌回 localStorage，再渲染 —— 各处都是在 useState 初始化里同步读的，
 * 晚一步就会先闪一下默认值。为什么不能只放 localStorage：每次启动的端口都可能不同，
 * 而 localStorage 按 origin 隔离（见 lib/uiState.ts）。
 */
void (async () => {
  await hydrateUiState();
  initLocale();                 // 语言也可能在上次那份状态里：灌完再定
  startUiStateSync();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
})();
