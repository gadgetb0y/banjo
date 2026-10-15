/** Escapes text for HTML element content and double-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  ':root{--fg:#1a1a1a;--bg:#fff;--muted:#555;--accent:#1d6b3a;--warn:#b45309}',
  '@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#141414;--muted:#aaa;--accent:#2f9a57;--warn:#f59e0b}}',
  'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px;color:var(--fg);background:var(--bg)}',
  'dt{font-weight:600;margin-top:.75rem;color:var(--muted)}',
  'dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
  'button{font:inherit;font-weight:600;padding:.75rem 1.5rem;margin-top:1.5rem;border:0;border-radius:.5rem;background:var(--accent);color:#fff}',
  '.warn{color:var(--warn)}',
].join('');

/** A whole page. `title` is escaped here; `bodyHtml` must already be safe. */
export function page(title: string, bodyHtml: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${bodyHtml}</body></html>`
  );
}
