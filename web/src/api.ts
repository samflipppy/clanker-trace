const API_BASE = '/v1/query';

let apiKey = localStorage.getItem('ct_api_key') || '';

export function setApiKey(key: string) {
  apiKey = key;
  localStorage.setItem('ct_api_key', key);
}

export function getApiKey(): string {
  return apiKey;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export interface Run {
  id: string;
  tenant_id: string;
  agent_id: string;
  goal?: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  total_cost: number;
  total_tokens: number;
  error_message?: string;
  metadata: Record<string, unknown>;
}

export interface TraceEvent {
  event_id: string;
  run_id: string;
  tenant_id: string;
  agent_id: string;
  timestamp: string;
  event_type: string;
  sequence_number: number;
  payload: Record<string, unknown>;
  latency_ms?: number;
  error_flag: boolean;
  parent_event_id?: string;
}

export interface Metrics {
  total_runs: number;
  avg_duration_ms: number;
  failure_rate: number;
  avg_cost: number;
  total_tokens: number;
  retry_frequency: number;
  tool_success_rate: number;
}

export interface RunsResponse {
  runs: Run[];
  total: number;
}

export async function fetchRuns(params?: Record<string, string>): Promise<RunsResponse> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request(`/runs${qs}`);
}

export async function fetchRun(runId: string): Promise<Run> {
  return request(`/runs/${runId}`);
}

export async function fetchTimeline(runId: string): Promise<{ run: Run; events: TraceEvent[] }> {
  return request(`/runs/${runId}/timeline`);
}

export async function fetchMetrics(agentId?: string): Promise<Metrics> {
  const qs = agentId ? `?agent_id=${agentId}` : '';
  return request(`/metrics${qs}`);
}

export async function fetchErrors(runId?: string): Promise<{ errors: TraceEvent[] }> {
  const qs = runId ? `?run_id=${runId}` : '';
  return request(`/errors${qs}`);
}
