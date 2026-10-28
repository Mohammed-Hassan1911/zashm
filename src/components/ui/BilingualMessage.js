import React from 'react';

export default function BilingualMessage({ en, ar, enStyle = {}, arStyle = {}, containerStyle = {} }) {
  return (
    <div style={containerStyle}>
      {en && (
        <div style={{ marginBottom: ar ? 6 : 0, ...enStyle }}>
          {typeof en === 'string' ? en.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          )) : en}
        </div>
      )}
      {ar && (
        <div style={{ direction: 'rtl', textAlign: 'right', ...arStyle }}>
          {typeof ar === 'string' ? ar.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          )) : ar}
        </div>
      )}
    </div>
  );
}
