export type WorkspaceRole = 'owner' | 'operator' | 'viewer';
export type HipoteseSource = 'benchmark' | 'nps' | 'churn' | 'manual';
export type HipoteseStatus = 'pending' | 'approved' | 'rejected' | 'deferred';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  brand_color: string;
  owner_id: string;
  logo_url: string | null;
  autodev_enabled: boolean;
  autodev_start_hour: number;
  autodev_stop_hour: number;
  autodev_manual_until: string | null;
  autodev_timezone: string;
  allowed_mission_squads: Squad[];
  created_at: string;
}

export const ALL_SQUADS: readonly Squad[] = ['dev', 'marketing', 'sales', 'ops'] as const;

export interface Member {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface Premissas {
  workspace_id: string;
  content: string;
  updated_at: string;
  updated_by: string | null;
}

export interface Hipotese {
  id: string;
  workspace_id: string;
  source: HipoteseSource;
  title: string;
  body: string | null;
  score: number;
  status: HipoteseStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface JournalEntry {
  id: string;
  workspace_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: string;
}

export interface Metric {
  workspace_id: string;
  captured_at: string;
  nps: number | null;
  churn_rate: number | null;
  active_users: number | null;
}

// ============ Squad missions ============

export type MissionPhase = 'plan' | 'execution' | 'improvement' | 'done';
export type MissionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'paused';
export type Squad = 'dev' | 'marketing' | 'sales' | 'ops';
export type VercelDeploymentState = 'queued' | 'building' | 'ready' | 'error' | 'canceled';

export interface Mission {
  id: string;
  workspace_id: string;
  squad: Squad;
  name: string;
  description: string | null;
  phase: MissionPhase;
  status: MissionStatus;
  progress: number;
  source: string | null;
  hipotese_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_check_at: string | null;
  branch_name: string | null;
  preview_url: string | null;
  vercel_deployment_id: string | null;
  vercel_deployment_state: VercelDeploymentState | null;
  vercel_deployment_created_at: string | null;
  vercel_deployment_ready_at: string | null;
  vercel_deployment_error_message: string | null;
}

export interface Artifact {
  id: string;
  workspace_id: string;
  mission_id: string;
  kind: string;
  label: string;
  url: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface ReasoningStep {
  id: string;
  workspace_id: string;
  mission_id: string;
  step: number;
  role: 'assistant' | 'tool' | 'observation' | 'plan';
  text: string;
  ts: string;
}

// ============ Notifications ============

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface Notification {
  id: string;
  workspace_id: string;
  user_id: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  href: string | null;
  meta: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}
