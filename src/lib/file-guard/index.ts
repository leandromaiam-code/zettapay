/**
 * FR.1 Wave A — File Guard
 *
 * Decide se o AutoDev pode escrever em um conjunto de arquivos.
 * Regras vem da tabela fabric_file_guard_rules:
 *   - workspace_id null  -> regra global (todos os workspaces)
 *   - workspace_id setado -> regra especifica do workspace
 *
 * Acao 'deny' tem precedencia. Se nada matchar, default e 'allow'
 * (politica permissiva fora dos diretorios sensiveis listados).
 */

export type FileGuardAction = 'allow' | 'deny';

export interface FileGuardRule {
  id?: string;
  workspace_id: string | null;
  pattern: string;
  action: FileGuardAction;
  reason: string | null;
}

export interface FileDecision {
  path: string;
  action: FileGuardAction;
  matchedRule?: FileGuardRule;
}

export interface CheckResult {
  allowed: boolean;
  decisions: FileDecision[];
  blocked: FileDecision[];
}

/**
 * Glob -> RegExp simples. Suporta:
 *   *      - matches qualquer coisa exceto /
 *   **     - matches recursivo (incluindo /)
 *   ?      - 1 char
 *   {a,b}  - alternativas
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        const opts = pattern.slice(i + 1, end).split(',').map((s) => s.trim());
        re += '(?:' + opts.map(escapeRegex).join('|') + ')';
        i = end + 1;
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function normalize(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function decideFile(file: string, rules: FileGuardRule[]): FileDecision {
  const path = normalize(file);
  let allowMatch: FileGuardRule | undefined;

  for (const rule of rules) {
    if (!rule.pattern) continue;
    const re = globToRegExp(rule.pattern);
    if (re.test(path)) {
      if (rule.action === 'deny') {
        return { path, action: 'deny', matchedRule: rule };
      }
      if (!allowMatch) allowMatch = rule;
    }
  }

  return {
    path,
    action: 'allow',
    matchedRule: allowMatch,
  };
}

export function checkFiles(files: string[], rules: FileGuardRule[]): CheckResult {
  const decisions = files.map((f) => decideFile(f, rules));
  const blocked = decisions.filter((d) => d.action === 'deny');
  return {
    allowed: blocked.length === 0,
    decisions,
    blocked,
  };
}
