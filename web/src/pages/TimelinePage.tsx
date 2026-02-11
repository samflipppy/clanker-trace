import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchTimeline, Run, TraceEvent, TimelineGroup } from '../api';

const GROUP_KIND_COLORS: Record<string, string> = {
  reasoning: '#a78bfa',
  tool_chain: '#34d399',
  retry_cluster: '#fbbf24',
  memory_sequence: '#22d3ee',
  custom: '#9ca3af',
};

function kindColor(kind: string): string {
  return GROUP_KIND_COLORS[kind] || GROUP_KIND_COLORS.custom;
}

function eventColor(evt: TraceEvent): string {
  if (evt.error_flag) return '#ef4444';
  switch (evt.event_type) {
    case 'run_started':
    case 'run_completed': return '#3b82f6';
    case 'step_started':
    case 'step_completed': return '#8b5cf6';
    case 'group_started':
    case 'group_completed': return '#9ca3af';
    case 'llm_invocation': return '#f59e0b';
    case 'tool_invocation':
    case 'tool_response': return '#10b981';
    case 'memory_query':
    case 'memory_response': return '#06b6d4';
    case 'retry_attempt': return '#eab308';
    case 'error_raised': return '#ef4444';
    default: return '#666';
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    case 'running': return '#3b82f6';
    default: return '#888';
  }
}

function EventRow({ evt, expandedEvents, toggleExpand, indent = 0 }: {
  evt: TraceEvent;
  expandedEvents: Set<string>;
  toggleExpand: (id: string) => void;
  indent?: number;
}) {
  const isExpanded = expandedEvents.has(evt.event_id);
  const hasPayload = Object.keys(evt.payload).length > 0;

  return (
    <div style={{ marginLeft: indent, marginBottom: 2, position: 'relative' }}>
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
          <span style={{ color: eventColor(evt), fontWeight: 600, minWidth: 160 }}>
            {evt.event_type}
          </span>
          {evt.latency_ms != null && (
            <span style={{ color: '#666', fontSize: 12 }}>{evt.latency_ms.toFixed(0)}ms</span>
          )}
          <span style={{ color: '#444', fontSize: 12, marginLeft: 'auto' }}>#{evt.sequence_number}</span>
          <span style={{ color: '#444', fontSize: 11 }}>
            {new Date(evt.timestamp).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 } as any)}
          </span>
          {hasPayload && (
            <span style={{ color: '#555', fontSize: 11 }}>{isExpanded ? '[-]' : '[+]'}</span>
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
}

function GroupSection({ group, expandedEvents, toggleExpand, expandedGroups, toggleGroup }: {
  group: TimelineGroup;
  expandedEvents: Set<string>;
  toggleExpand: (id: string) => void;
  expandedGroups: Set<string>;
  toggleGroup: (id: string) => void;
}) {
  const isExpanded = expandedGroups.has(group.group_id);
  const kc = kindColor(group.kind);

  return (
    <div style={{ marginBottom: 4, position: 'relative' }}>
      {/* Group dot */}
      <div style={{
        position: 'absolute',
        left: -20,
        top: 12,
        width: 10,
        height: 10,
        borderRadius: 2,
        background: kc,
        border: group.error ? '2px solid #ef4444' : 'none',
      }} />

      {/* Group header - collapsible */}
      <div
        onClick={() => toggleGroup(group.group_id)}
        style={{
          background: group.error ? '#1a0505' : '#0d0d0d',
          border: `1px solid ${group.error ? '#3f1111' : '#1a1a1a'}`,
          borderLeft: `3px solid ${kc}`,
          borderRadius: 4,
          padding: '10px 14px',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#555', fontSize: 12, fontFamily: 'monospace', width: 18 }}>
            {isExpanded ? '\u25BC' : '\u25B6'}
          </span>
          <span style={{
            background: kc + '22',
            color: kc,
            padding: '2px 8px',
            borderRadius: 3,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}>
            {group.kind.replace('_', ' ')}
          </span>
          <span style={{ color: '#ddd', fontWeight: 600 }}>{group.name}</span>
          <span style={{ color: '#555', fontSize: 12, marginLeft: 'auto' }}>
            {group.event_count} event{group.event_count !== 1 ? 's' : ''}
          </span>
          {group.latency_ms != null && (
            <span style={{ color: '#666', fontSize: 12 }}>{group.latency_ms.toFixed(0)}ms</span>
          )}
          {group.error && (
            <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 600 }}>ERROR</span>
          )}
        </div>
      </div>

      {/* Group children */}
      {isExpanded && (
        <div style={{
          marginLeft: 12,
          paddingLeft: 16,
          borderLeft: `2px solid ${kc}33`,
          marginTop: 2,
        }}>
          {group.events.map(evt => (
            <EventRow
              key={evt.event_id}
              evt={evt}
              expandedEvents={expandedEvents}
              toggleExpand={toggleExpand}
            />
          ))}
          {group.events.length === 0 && (
            <div style={{ color: '#444', fontSize: 12, padding: '8px 0' }}>No child events</div>
          )}
        </div>
      )}
    </div>
  );
}

export function TimelinePage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [groups, setGroups] = useState<TimelineGroup[]>([]);
  const [ungrouped, setUngrouped] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    fetchTimeline(runId)
      .then(res => {
        setRun(res.run);
        setEvents(res.events);
        setGroups(res.groups || []);
        setUngrouped(res.ungrouped || res.events);
        setError('');
      })
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

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedGroups(new Set(groups.map(g => g.group_id)));
  };

  const collapseAll = () => {
    setExpandedGroups(new Set());
  };

  if (loading) return <div style={{ color: '#666' }}>Loading...</div>;
  if (error) return <div style={{ color: '#ef4444' }}>{error}</div>;
  if (!run) return <div style={{ color: '#888' }}>Run not found</div>;

  const hasGroups = groups.length > 0;

  // Build an ordered rendering list that preserves chronological order.
  // Groups are placed at the position of their group_started event.
  // Ungrouped events fill the rest.
  type TimelineItem = { type: 'group'; group: TimelineGroup } | { type: 'event'; event: TraceEvent };
  const timelineItems: TimelineItem[] = [];

  if (hasGroups) {
    // Build a set of all event_ids that belong to groups or are group_started/group_completed
    const groupEventIds = new Set<string>();
    const groupStartSeq = new Map<string, number>();

    for (const evt of events) {
      if (evt.event_type === 'group_started' && evt.payload?.group_id) {
        groupStartSeq.set(evt.payload.group_id as string, evt.sequence_number);
        groupEventIds.add(evt.event_id);
      }
      if (evt.event_type === 'group_completed') {
        groupEventIds.add(evt.event_id);
      }
    }
    for (const g of groups) {
      for (const child of g.events) {
        groupEventIds.add(child.event_id);
      }
    }

    // Sort groups by their start sequence number
    const sortedGroups = [...groups].sort((a, b) => {
      return (groupStartSeq.get(a.group_id) ?? 0) - (groupStartSeq.get(b.group_id) ?? 0);
    });

    let groupIdx = 0;
    for (const evt of events) {
      // Insert any groups whose start position is at or before this event
      while (groupIdx < sortedGroups.length) {
        const gSeq = groupStartSeq.get(sortedGroups[groupIdx].group_id) ?? 0;
        if (gSeq <= evt.sequence_number) {
          timelineItems.push({ type: 'group', group: sortedGroups[groupIdx] });
          groupIdx++;
        } else {
          break;
        }
      }
      // Only render events that aren't part of a group
      if (!groupEventIds.has(evt.event_id)) {
        timelineItems.push({ type: 'event', event: evt });
      }
    }
    // Append remaining groups
    while (groupIdx < sortedGroups.length) {
      timelineItems.push({ type: 'group', group: sortedGroups[groupIdx] });
      groupIdx++;
    }
  } else {
    for (const evt of events) {
      timelineItems.push({ type: 'event', event: evt });
    }
  }

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
          <div><span style={{ color: '#666' }}>Duration:</span> <span style={{ color: '#ccc' }}>{run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(2)}s` : '\u2014'}</span></div>
          <div><span style={{ color: '#666' }}>Cost:</span> <span style={{ color: '#ccc' }}>${run.total_cost.toFixed(4)}</span></div>
          <div><span style={{ color: '#666' }}>Tokens:</span> <span style={{ color: '#ccc' }}>{run.total_tokens.toLocaleString()}</span></div>
          <div><span style={{ color: '#666' }}>Events:</span> <span style={{ color: '#ccc' }}>{events.length}</span></div>
          {hasGroups && (
            <div><span style={{ color: '#666' }}>Groups:</span> <span style={{ color: '#ccc' }}>{groups.length}</span></div>
          )}
          {run.error_message && (
            <div><span style={{ color: '#ef4444' }}>Error: {run.error_message}</span></div>
          )}
        </div>
      </div>

      {/* Timeline controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, color: '#fff', margin: 0 }}>Execution Timeline</h3>
        {hasGroups && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              onClick={expandAll}
              style={{
                background: '#1a1a1a',
                border: '1px solid #333',
                color: '#888',
                padding: '4px 10px',
                borderRadius: 3,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Expand All
            </button>
            <button
              onClick={collapseAll}
              style={{
                background: '#1a1a1a',
                border: '1px solid #333',
                color: '#888',
                padding: '4px 10px',
                borderRadius: 3,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Collapse All
            </button>
          </div>
        )}
      </div>

      {/* Timeline */}
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

        {timelineItems.map((item, idx) => {
          if (item.type === 'group') {
            return (
              <GroupSection
                key={item.group.group_id}
                group={item.group}
                expandedEvents={expandedEvents}
                toggleExpand={toggleExpand}
                expandedGroups={expandedGroups}
                toggleGroup={toggleGroup}
              />
            );
          }
          const evt = item.event;
          const indent = evt.parent_event_id ? 24 : 0;
          return (
            <EventRow
              key={evt.event_id}
              evt={evt}
              expandedEvents={expandedEvents}
              toggleExpand={toggleExpand}
              indent={indent}
            />
          );
        })}
      </div>
    </div>
  );
}
