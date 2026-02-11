import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchRuns, Run } from '../api';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    fetchRuns(filters)
      .then(res => { setRuns(res.runs); setTotal(res.total); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filters]);

  const statusColor = (s: string) => {
    switch (s) {
      case 'completed': return '#22c55e';
      case 'failed': return '#ef4444';
      case 'running': return '#3b82f6';
      case 'paused': return '#eab308';
      default: return '#888';
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, color: '#fff' }}>Agent Runs</h2>
        <span style={{ color: '#666', fontSize: 13 }}>{total} total</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['', 'running', 'completed', 'failed'].map(s => (
          <button
            key={s}
            onClick={() => setFilters(f => s ? { ...f, status: s } : (() => { const { status, ...rest } = f; return rest; })())}
            style={{
              background: filters.status === s || (!s && !filters.status) ? '#222' : 'transparent',
              color: s ? statusColor(s) : '#aaa',
              border: '1px solid #333',
              padding: '4px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {error && <div style={{ color: '#ef4444', marginBottom: 16 }}>{error}</div>}
      {loading && <div style={{ color: '#666' }}>Loading...</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {runs.map(run => (
          <Link
            key={run.id}
            to={`/runs/${run.id}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '100px 1fr 120px 100px 100px',
              gap: 16,
              padding: '10px 16px',
              textDecoration: 'none',
              color: '#e0e0e0',
              borderRadius: 4,
              background: '#111',
              borderLeft: `3px solid ${statusColor(run.status)}`,
              alignItems: 'center',
              fontSize: 13,
            }}
          >
            <span style={{ color: statusColor(run.status), fontWeight: 600 }}>
              {run.status}
            </span>
            <span style={{ color: '#ccc' }}>
              {run.goal || run.agent_id}
              <span style={{ color: '#555', marginLeft: 8 }}>{run.id.slice(0, 8)}</span>
            </span>
            <span style={{ color: '#888' }}>{run.agent_id}</span>
            <span style={{ color: '#888' }}>
              {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'}
            </span>
            <span style={{ color: '#666', fontSize: 12 }}>
              {new Date(run.started_at).toLocaleTimeString()}
            </span>
          </Link>
        ))}
        {!loading && runs.length === 0 && (
          <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>
            No runs found. Instrument an agent with the SDK to get started.
          </div>
        )}
      </div>
    </div>
  );
}
