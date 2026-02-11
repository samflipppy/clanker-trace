import React, { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { getApiKey, setApiKey } from './api';

export function App() {
  const [key, setKey] = useState(getApiKey());
  const [input, setInput] = useState('');

  if (!key) {
    return (
      <div style={styles.authContainer}>
        <h1 style={styles.title}>Clanker Trace</h1>
        <p style={styles.subtitle}>Runtime observability for AI agents</p>
        <div style={styles.authForm}>
          <input
            type="password"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Enter API key (ct_...)"
            style={styles.input}
          />
          <button
            onClick={() => { setApiKey(input); setKey(input); }}
            style={styles.button}
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.layout}>
      <nav style={styles.nav}>
        <Link to="/" style={styles.logo}>Clanker Trace</Link>
        <div style={styles.navLinks}>
          <Link to="/" style={styles.navLink}>Runs</Link>
          <Link to="/metrics" style={styles.navLink}>Metrics</Link>
        </div>
        <button
          onClick={() => { setApiKey(''); setKey(''); }}
          style={styles.logoutBtn}
        >
          Disconnect
        </button>
      </nav>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  authContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: '#fff',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginBottom: 24,
  },
  authForm: {
    display: 'flex',
    gap: 8,
  },
  input: {
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#e0e0e0',
    padding: '8px 12px',
    borderRadius: 4,
    fontFamily: 'inherit',
    fontSize: 14,
    width: 320,
  },
  button: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    padding: '8px 20px',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 14,
  },
  layout: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    height: 48,
    borderBottom: '1px solid #222',
    background: '#111',
    gap: 24,
  },
  logo: {
    color: '#fff',
    textDecoration: 'none',
    fontWeight: 700,
    fontSize: 15,
  },
  navLinks: {
    display: 'flex',
    gap: 16,
    flex: 1,
  },
  navLink: {
    color: '#aaa',
    textDecoration: 'none',
    fontSize: 13,
  },
  logoutBtn: {
    background: 'transparent',
    color: '#666',
    border: '1px solid #333',
    padding: '4px 12px',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
  },
  main: {
    flex: 1,
    overflow: 'auto',
    padding: 24,
  },
};
