/**
 * FR.1 Wave A — Premissas Validator
 *
 * Recebe um pedaco de conteudo (descricao de mission, diff de PR,
 * step de raciocinio) + o documento de premissas do workspace e
 * retorna a lista de violacoes encontradas.
 *
 * Engine determinista por hora (regex/keyword). Premissa V.7 exige
 * que toda decisao autonoma respeite a constituicao — entao mesmo
 * uma checagem leve e infinitamente melhor do que nada.
 */

export type ViolationSeverity = 'info' | 'warning' | 'critical';

export interface PremissaViolation {
  rule: string;
  severity: ViolationSeverity;
  message: string;
  evidence?: string;
}

export interface ValidationInput {
  content: string;
  premissas?: string;
  context?: 'mission_description' | 'reasoning_step' | 'artifact' | 'pr_diff' | 'manual';
}

export interface ValidationResult {
  ok: boolean;
  violations: PremissaViolation[];
  forbiddenTermsHit: string[];
  rulesViolated: string[];
}

const FORBIDDEN_TERMS = [
  'revolução',
  'revolucao',
  'revolucionar',
  'disrupção',
  'disrupcao',
  'disruptivo',
  'disruptiva',
  'sinergia',
  'sinergias',
  'game-changer',
  'game changer',
  'unicórnio',
  'unicornio',
];

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /xox[abp]-[A-Za-z0-9-]{10,}/g,
  /SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]?ey[A-Za-z0-9._-]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const RULES = {
  brand: 'V.14 brand discipline',
  secret: 'V.17 segurança first',
  arch: 'I.1 arquitetura limpa',
  perf: 'IV.11 performance budget',
  audit: 'V.8 auditabilidade',
} as const;

function findEvidence(content: string, needle: string, span = 80): string {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return needle;
  const start = Math.max(0, idx - Math.floor(span / 2));
  const end = Math.min(content.length, idx + needle.length + Math.floor(span / 2));
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

export function validateContent(input: ValidationInput): ValidationResult {
  const { content } = input;
  const violations: PremissaViolation[] = [];
  const forbiddenHit = new Set<string>();
  const ruleHit = new Set<string>();

  const haystack = ' ' + content.toLowerCase() + ' ';

  for (const term of FORBIDDEN_TERMS) {
    const needle = term.toLowerCase();
    const re = new RegExp('\\b' + needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'i');
    if (re.test(haystack)) {
      forbiddenHit.add(term);
      ruleHit.add(RULES.brand);
      violations.push({
        rule: RULES.brand,
        severity: 'warning',
        message: `Termo proibido pelo Manual de Marca Veridian V2: "${term}".`,
        evidence: findEvidence(content, term),
      });
    }
  }

  for (const re of SECRET_PATTERNS) {
    const matches = content.match(re);
    if (matches && matches.length > 0) {
      ruleHit.add(RULES.secret);
      violations.push({
        rule: RULES.secret,
        severity: 'critical',
        message: 'Possivel secret/credencial detectado. Use o secret manager.',
        evidence: matches[0].slice(0, 32) + '…',
      });
    }
  }

  // I.1 Arquitetura limpa: dominio nao importa infra. Heuristica simples
  // checa imports cruzados em diffs/codigo.
  if (input.context === 'pr_diff' || input.context === 'artifact') {
    const domainImportingInfra = /from ['"]@\/lib\/supabase\/(?:server|client)['"]/g;
    const hasDomainPath = /src\/lib\/(?:domain|core)\//;
    if (hasDomainPath.test(content) && domainImportingInfra.test(content)) {
      ruleHit.add(RULES.arch);
      violations.push({
        rule: RULES.arch,
        severity: 'warning',
        message: 'Modulo de dominio importando infra (supabase). Inverter dependencia.',
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    forbiddenTermsHit: Array.from(forbiddenHit),
    rulesViolated: Array.from(ruleHit),
  };
}

export function summarizeResult(r: ValidationResult): string {
  if (r.ok) return 'sem violacoes';
  const counts = r.violations.reduce<Record<ViolationSeverity, number>>(
    (acc, v) => {
      acc[v.severity] = (acc[v.severity] ?? 0) + 1;
      return acc;
    },
    { info: 0, warning: 0, critical: 0 }
  );
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} criticas`);
  if (counts.warning)  parts.push(`${counts.warning} warnings`);
  if (counts.info)     parts.push(`${counts.info} infos`);
  return parts.join(' · ');
}
