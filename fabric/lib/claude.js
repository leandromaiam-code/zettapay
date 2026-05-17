// Invoke /usr/bin/claude CLI with a prompt, return stdout.

'use strict';

const { execFile } = require('child_process');

const DEFAULTS = {
  bin: '/usr/bin/claude',
  effort: 'medium',
  outputFormat: 'text',
  timeoutMs: 90_000,
  maxBufferBytes: 4 * 1024 * 1024,
};

function invokeClaude(prompt, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  return new Promise((resolve, reject) => {
    execFile(
      o.bin,
      ['-p', '--bare', '--effort', o.effort, '--output-format', o.outputFormat, prompt],
      { timeout: o.timeoutMs, maxBuffer: o.maxBufferBytes },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || '')))
    );
  });
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

module.exports = { invokeClaude, extractJson };
