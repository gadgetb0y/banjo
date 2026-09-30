/**
 * The testable half of `npm run setup` (#39): validating answers, rendering a
 * .env from .env.example, and checking the result with the app's own config
 * schema. The prompts live in scripts/setup.ts.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A validator returns an error message for a bad answer, or undefined when it's fine. */
export type Validator = (value: string) => string | undefined;

export const E164: Validator = (value) =>
  /^\+[1-9]\d{1,14}$/.test(value) ? undefined : 'Use E.164 format: a leading +, the country code, no spaces or dashes (e.g. +15551234567).';

const PLACEHOLDER_HOSTNAME = 'your-alb-or-ngrok-hostname.example.com';

/** PUBLIC_HOSTNAME is used as `https://<host>/…` and `wss://<host>/…`, so it must be a bare hostname. */
export const HOSTNAME: Validator = (value) => {
  if (/^[a-z]+:\/\//i.test(value)) return 'Leave off the https:// — just the hostname, e.g. banjo.example.com.';
  if (value.includes('/')) return 'Just the hostname, with no path after it.';
  if (value === PLACEHOLDER_HOSTNAME) return "That's the .env.example placeholder. Use your tunnel or server's hostname.";
  const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
  return new RegExp(`^${label}(\\.${label})+$`, 'i').test(value) ? undefined : 'Not a valid hostname, e.g. banjo.example.com.';
};

export const TWILIO_ACCOUNT_SID: Validator = (value) =>
  /^AC[0-9a-f]{32}$/i.test(value) ? undefined : 'A Twilio Account SID is "AC" followed by 32 letters and digits. Copy it from the Twilio console home page.';

export const TWILIO_AUTH_TOKEN: Validator = (value) =>
  /^[0-9a-f]{32}$/i.test(value) ? undefined : 'A Twilio Auth Token is 32 letters and digits. Copy it from the Twilio console home page.';

export const REQUIRED: Validator = (value) => (value.trim() ? undefined : 'This one is required.');

export const TIMEZONE: Validator = (value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return undefined;
  } catch {
    return 'Not an IANA time zone, e.g. America/New_York or Europe/London.';
  }
};

/**
 * One `KEY=value` line, quoted when dotenv (or docker compose) would otherwise
 * misread the value. dotenv doesn't unescape quotes, so the value is wrapped
 * in a quote character it doesn't contain.
 */
function formatLine(key: string, value: string): string {
  if (!/[\s#"'`\\]/.test(value)) return `${key}=${value}`;
  const quote = ['"', "'", '`'].find((q) => !value.includes(q));
  if (!quote) throw new Error(`${key}: a value containing ", ' and \` can't be written to .env`);
  return `${key}=${quote}${value}${quote}`;
}

/**
 * Renders a .env from .env.example's text, keeping its comments and order.
 * Each key in `values` replaces its first line in the template, active or
 * commented out; keys the template lacks are appended at the end. An active
 * line left empty is commented out rather than kept as `KEY=`: an empty value
 * fails validation for some optional settings (e.g. a phone number), and a
 * commented line means the same thing — unset.
 */
export function renderEnvFile(template: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const lines = template.split('\n').map((line) => {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return line;
    const [, commented, key] = match;
    if (key && remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return formatLine(key, value);
    }
    if (!commented && match[3]!.trim() === '') return `# ${key}=`;
    return line;
  });
  const extra = [...remaining].map(([key, value]) => formatLine(key, value));
  if (extra.length) lines.push('', '# Added by npm run setup', ...extra, '');
  return lines.join('\n');
}

/** One problem the app's config schema found in a draft .env. */
export interface ConfigProblem {
  setting: string;
  message: string;
}

/**
 * Checks `envText` with the same Zod schema the app runs at startup
 * (src/config/index.ts), in a child process so nothing here reads the
 * developer's real .env or environment. Resolves to [] when it would boot.
 */
export function validateWithAppConfig(envText: string, repoRoot: string): ConfigProblem[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'banjo-setup-'));
  const draft = path.join(dir, '.env');
  try {
    writeFileSync(draft, envText, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `try { await import('./src/config/index.ts'); } catch (err) {
           console.error('BANJO_SETUP_ISSUES' + JSON.stringify(err.issues ?? [{ path: [], message: String(err.message ?? err) }]));
           process.exit(1);
         }`,
      ],
      // Only what's needed to run node: the draft is the whole environment
      // the config sees, loaded by src/config's own `import 'dotenv/config'`.
      { cwd: repoRoot, env: { PATH: process.env.PATH ?? '', DOTENV_CONFIG_PATH: draft }, encoding: 'utf8' },
    );
    if (result.status === 0) return [];
    const marker = result.stderr.split('\n').find((line) => line.startsWith('BANJO_SETUP_ISSUES'));
    if (!marker) return [{ setting: '', message: result.stderr.trim() || 'The config check could not run.' }];
    const issues = JSON.parse(marker.slice('BANJO_SETUP_ISSUES'.length)) as { path: (string | number)[]; message: string }[];
    return issues.map((issue) => ({ setting: issue.path.join('.'), message: issue.message }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A backup name for an existing .env, ignored by git via `.env.bak*`. */
export function backupName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `.env.bak-${stamp}`;
}
