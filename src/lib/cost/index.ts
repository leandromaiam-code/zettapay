/**
 * FR.1 Wave A — Cost Ledger helpers
 *
 * Append-only por contrato. O trigger fabric_trg_check_budget cuida
 * dos alertas (70/90) e do kill switch (100). Aqui fica apenas a
 * tabela de pricing default e funcoes de calculo.
 */

export type CostSource = 'autodev' | 'plan_squad' | 'validator' | 'manual' | 'other';

export interface CostEntry {
  workspace_id: string;
  mission_id?: string | null;
  agent_id?: string | null;
  source?: CostSource;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  usd_amount?: number;
  meta?: Record<string, unknown>;
}

/**
 * Pricing publico Anthropic / OpenAI por 1M tokens (USD).
 * Mantido aqui para que o ledger possa estimar quando o caller
 * nao tiver o valor exato em maos.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-4-7':           { input: 15.0, output: 75.0 },
  'claude-opus-4-6':           { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6':         { input:  3.0, output: 15.0 },
  'claude-haiku-4-5':          { input:  0.8, output:  4.0 },
  // OpenAI fallbacks
  'gpt-4o':                    { input:  2.5, output: 10.0 },
  'gpt-4o-mini':               { input:  0.15, output: 0.6 },
  // Catch-all conservador (assume opus)
  'unknown':                   { input: 15.0, output: 75.0 },
};

export function estimateUsd(model: string, promptTokens: number, completionTokens: number): number {
  const key = PRICING[model] ? model : 'unknown';
  const p = PRICING[key];
  const inUsd = (promptTokens / 1_000_000) * p.input;
  const outUsd = (completionTokens / 1_000_000) * p.output;
  return Math.round((inUsd + outUsd) * 1_000_000) / 1_000_000;
}

export function buildLedgerRow(entry: CostEntry) {
  const usd = entry.usd_amount ?? estimateUsd(entry.model, entry.prompt_tokens, entry.completion_tokens);
  return {
    workspace_id: entry.workspace_id,
    mission_id: entry.mission_id ?? null,
    agent_id: entry.agent_id ?? null,
    source: entry.source ?? 'autodev',
    model: entry.model,
    prompt_tokens: Math.max(0, Math.floor(entry.prompt_tokens)),
    completion_tokens: Math.max(0, Math.floor(entry.completion_tokens)),
    usd_amount: Math.max(0, usd),
    meta: entry.meta ?? {},
  };
}
