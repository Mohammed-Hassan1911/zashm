import React from 'react';

// Catches render-time errors in the tree below so a single bad component
// (e.g. a malformed product) never blanks the whole storefront.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    if (typeof console !== 'undefined') {
      console.error('UI ErrorBoundary caught an error:', error, info && info.componentStack);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg, #0a0a0a)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h1 style={{ fontFamily: 'var(--font-display, serif)', fontSize: 28, color: 'var(--gold, #c9a84c)', marginBottom: 12, letterSpacing: 1 }}>
            Something went wrong
          </h1>
          <p style={{ color: 'var(--text2, #ccc)', fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>
            An unexpected error occurred while rendering this page. You can try again or reload the store.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={this.handleReset} style={{ padding: '10px 18px', background: 'var(--gold, #c9a84c)', color: '#111', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>
              Try Again
            </button>
            <button onClick={this.handleReload} style={{ padding: '10px 18px', background: 'transparent', color: 'var(--text2, #ccc)', border: '1px solid var(--border, #333)', borderRadius: 4, cursor: 'pointer', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
