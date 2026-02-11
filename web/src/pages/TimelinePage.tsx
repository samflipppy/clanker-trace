import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchTimeline, Run, TraceEvent } from '../api';

export function TimelinePage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    fetchTimeline(runId)
      .then(res => { setRun(res.run); setEvents(res.events); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runId]);

  const toggleExpand = (eventId: string) => {
    setExpandedEvents(prev => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const eventColor = (evt: TraceEvent) => {
    if (evt.error_flag) return '#ef4444';
    switch (evt.event_type) {
      case 'run_started':
      case 'run_completed': return '#3b82f6';
      case 'step_started':
      case 'step_completed': return '#8b5cf6';
      case 'llm_invocation': return '#f59e0b';
      case 'tool_invocation':
      case 'tool_response': return '#10b981';
      case 'memory_query':
      case 'memory_response': return '#06b6d4';
      case 'retry_attempt': return '#eab308';
      case 'error_raised': return '#ef4444';
      default: return '#666';
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'completed': return '#22c55e';
      case 'failed': return '#ef4444';
      case 'running': return '#3b82f6';
      default: return '#888';
    }
  };

  if (loading) return <div style={{ color: '#666' }}>Loading...</div>;
  if (error) return <div style={{ color: '#ef4444' }}>{error}</div>;
  if (!run) return <div style={{ color: '#888' }}>Run not found</div>;

  return (
    <div>
      <Link to="/" style={{ color: '#666', textDecoration: 'none', fontSize: 13, marginBottom: 16, display: 'block' }}>
        &larr; All Runs
      </Link>

      {/* Run header */}
      <div style={{
        background: '#111',
        borderRadius: 6,
        padding: 20,
        marginBottom: 24,
        borderLeft: `4px solid ${statusColor(run.status)}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: 16, color: '#fff', marginBottom: 4 }}>
              {run.goal || 'Untitled Run'}
            </h2>
            <div style={{ fontSize: 13, color: '#888' }}>
              {run.agent_id} &middot; {run.id}
            </div>
          </div>
          <span style={{ color: statusColor(run.status), fontWeight: 600, fontSize: 14 }}>
            {run.status}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 13 }}>
          <div><span style={{ color: '#666' }}>Duration:</span> <span style={{ color: '#ccc' }}>{run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(2)}s` : '—'}</span></div>
          <div><span style={{ color: '#666' }}>Cost:</span> <span style={{ color: '#ccc' }}>${run.total_cost.toFixed(4)}</span></div>
          <div><span style={{ color: '#666' }}>Tokens:</span> <span style={{ color: '#ccc' }}>{run.total_tokens.toLocaleString()}</span></div>
          <div><span style={{ color: '#666' }}>Events:</span> <span style={{ color: '#ccc' }}>{events.length}</span></div>
          {run.error_message && (
            <div><span style={{ color: '#ef4444' }}>Error: {run.error_message}</span></div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <h3 style={{ fontSize: 14, color: '#fff', marginBottom: 12 }}>Execution Timeline</h3>
      <div style={{ position: 'relative', paddingLeft: 24 }}>
        {/* Vertical line */}
        <div style={{
          position: 'absolute',
          left: 8,
          top: 0,
          bottom: 0,
          width: 2,
          background: '#222',
        }} />

        {events.map((evt) => {
          const isExpanded = expandedEvents.has(evt.event_id);
          const hasPayload = Object.keys(evt.payload).length > 0;
          const indent = evt.parent_event_id ? 24 : 0;

          return (
            <div key={evt.event_id} style={{ marginLeft: indent, marginBottom: 2, position: 'relative' }}>
              {/* Dot */}
              <div style={{
                position: 'absolute',
                left: -20,
                top: 10,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: eventColor(evt),
                border: evt.error_flag ? '2px solid #ef4444' : 'none',
              }} />

              <div
                onClick={() => hasPayload && toggleExpand(evt.event_id)}
                style={{
                  background: evt.error_flag ? '#1a0505' : '#111',
                  border: evt.error_flag ? '1px solid #3f1111' : '1px solid transparent',
                  borderRadius: 4,
                  padding: '8px 12px',
                  cursor: hasPayload ? 'pointer' : 'default',
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    color: eventColor(evt),
                    fontWeight: 600,
                    minWidth: 160,
                  }}>
                    {evt.event_type}
                  </span>
                  {evt.latency_ms != null && (
                    <span style={{ color: '#666', fontSize: 12 }}>
                      {evt.latency_ms.toFixed(0)}ms
                    </span>
                  )}
                  <span style={{ color: '#444', fontSize: 12, marginLeft: 'auto' }}>
                    #{evt.sequence_number}
                  </span>
                  <span style={{ color: '#444', fontSize: 11 }}>
                    {new Date(evt.timestamp).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 } as any)}
                  </span>
                  {hasPayload && (
                    <span style={{ color: '#555', fontSize: 11 }}>
                      {isExpanded ? '[-]' : '[+]'}
                    </span>
                  )}
                </div>

                {isExpanded && hasPayload && (
                  <pre style={{
                    marginTop: 8,
                    padding: 12,
                    background: '#0a0a0a',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#aaa',
                    overflow: 'auto',
                    maxHeight: 400,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {JSON.stringify(evt.payload, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
