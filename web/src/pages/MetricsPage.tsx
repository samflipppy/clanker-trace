import React, { useEffect, useState } from 'react';
import { fetchMetrics, Metrics } from '../api';

export function MetricsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchMetrics()
      .then(m => { setMetrics(m); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: '#666' }}>Loading...</div>;
  if (error) return <div style={{ color: '#ef4444' }}>{error}</div>;
  if (!metrics) return null;

  const cards: Array<{ label: string; value: string; color: string }> = [
    { label: 'Total Runs', value: String(metrics.total_runs), color: '#3b82f6' },
    { label: 'Avg Duration', value: `${(metrics.avg_duration_ms / 1000).toFixed(2)}s`, color: '#8b5cf6' },
    { label: 'Failure Rate', value: `${(metrics.failure_rate * 100).toFixed(1)}%`, color: metrics.failure_rate > 0.1 ? '#ef4444' : '#22c55e' },
    { label: 'Avg Cost', value: `$${metrics.avg_cost.toFixed(4)}`, color: '#f59e0b' },
    { label: 'Total Tokens', value: metrics.total_tokens.toLocaleString(), color: '#06b6d4' },
    { label: 'Retry Count', value: String(metrics.retry_frequency), color: '#eab308' },
    { label: 'Tool Success Rate', value: `${(metrics.tool_success_rate * 100).toFixed(1)}%`, color: metrics.tool_success_rate > 0.9 ? '#22c55e' : '#ef4444' },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 18, color: '#fff', marginBottom: 20 }}>Metrics</h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 12,
      }}>
        {cards.map(c => (
          <div key={c.label} style={{
            background: '#111',
            borderRadius: 6,
            padding: 20,
            borderTop: `3px solid ${c.color}`,
          }}>
            <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>{c.label}</div>
            <div style={{ color: c.color, fontSize: 24, fontWeight: 700 }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
