import React from 'react';

// The store uses its own tiny history router (src/lib/routes.js); a plain
// anchor performs a full navigation back to the home page.
export default function NotFoundPage() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '80px 24px',
        gap: 12,
      }}
    >
      <p style={{ color: 'var(--gold)', letterSpacing: 4, fontSize: 12, textTransform: 'uppercase' }}>
        Error 404
      </p>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(32px, 6vw, 56px)', margin: 0 }}>
        Page not found
      </h1>
      <p style={{ color: 'var(--text3)', maxWidth: 460 }}>
        The page you are looking for does not exist or has moved.
      </p>
      <a
        href="/"
        style={{
          marginTop: 16,
          padding: '12px 28px',
          border: '1px solid var(--gold)',
          color: 'var(--gold)',
          textDecoration: 'none',
          letterSpacing: 2,
          textTransform: 'uppercase',
          fontSize: 12,
        }}
      >
        Back to the store
      </a>
    </div>
  );
}
