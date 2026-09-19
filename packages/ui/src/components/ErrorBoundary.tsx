import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a render crash from blanking the whole window.
 * Shows a recovery card instead of a white screen.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[SHE ErrorBoundary]', error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private dismiss = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error.message || String(this.state.error);
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg, #0d1117)',
          color: 'var(--fg, #e6edf3)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: '100%',
            padding: 24,
            borderRadius: 12,
            border: '1px solid color-mix(in srgb, var(--danger, #f85149) 40%, transparent)',
            background: 'var(--surface, #161b22)',
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>界面出错了</h1>
          <p style={{ margin: '0 0 12px', opacity: 0.85, fontSize: 14, lineHeight: 1.5 }}>
            会话数据还在本地。刷新通常就能恢复；若反复出现，用桌面 SHE-stop.bat 再 SHE.bat。
          </p>
          <pre
            style={{
              margin: '0 0 16px',
              padding: 12,
              borderRadius: 8,
              background: 'var(--bg, #0d1117)',
              fontSize: 12,
              overflow: 'auto',
              maxHeight: 160,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {msg}
          </pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={this.reload} style={btnPrimary}>
              刷新页面
            </button>
            <button type="button" onClick={this.dismiss} style={btnGhost}>
              尝试继续
            </button>
          </div>
        </div>
      </div>
    );
  }
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--accent, #2f81f7)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

const btnGhost: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid var(--border, #30363d)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
};
