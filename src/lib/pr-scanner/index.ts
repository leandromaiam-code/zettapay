/**
 * FR.1 Wave A — PR Scanner
 *
 * Recebe um diff em formato unified e produz contagens + lista de
 * arquivos. O verdict consolida violacoes do Premissas Validator
 * + File Guard.
 */

export interface DiffStat {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  files: string[];
  fullText: string;
}

export interface ScanVerdict {
  verdict: 'clean' | 'review' | 'blocked';
  summary: string;
}

export function parseUnifiedDiff(diff: string): DiffStat {
  const files: string[] = [];
  let added = 0;
  let removed = 0;

  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      // diff --git a/path b/path
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) files.push(match[2]);
    } else if (line.startsWith('+++ b/')) {
      const p = line.slice(6).trim();
      if (p && p !== '/dev/null' && !files.includes(p)) files.push(p);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }

  return {
    filesChanged: files.length,
    linesAdded: added,
    linesRemoved: removed,
    files,
    fullText: diff,
  };
}

export function decideVerdict(input: {
  premissasViolations: number;
  premissasCritical: number;
  fileGuardViolations: number;
}): ScanVerdict {
  if (input.premissasCritical > 0 || input.fileGuardViolations > 0) {
    return {
      verdict: 'blocked',
      summary: 'PR bloqueado: violacoes criticas detectadas.',
    };
  }
  if (input.premissasViolations > 0) {
    return {
      verdict: 'review',
      summary: `PR exige revisao humana: ${input.premissasViolations} violacao(oes) leve(s).`,
    };
  }
  return {
    verdict: 'clean',
    summary: 'PR sem violacoes detectadas.',
  };
}
