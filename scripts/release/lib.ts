/**
 * The release workflow's version bump (.github/workflows/release.yml), kept
 * here so it can be tested. It rewrites only the version strings, leaving each
 * file's layout as it is: server.json is hand-formatted.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** `next` if it's a plain X.Y.Z newer than `current`; throws otherwise. */
export function checkVersion(next: string, current: string): string {
  const n = VERSION.exec(next);
  const c = VERSION.exec(current);
  if (!n) throw new Error(`"${next}" is not a version: give X.Y.Z, e.g. 0.1.15 (no leading v)`);
  if (!c) throw new Error(`package.json's version "${current}" is not X.Y.Z`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(n[i]) - Number(c[i]);
    if (diff > 0) return next;
    if (diff < 0) break;
  }
  throw new Error(`${next} is not newer than the current ${current}`);
}

/**
 * `text` with its `"version": "<from>"` and any `banjo:<from>` image tag set
 * to `to`. Throws if the file doesn't carry `from`, so a manifest left behind
 * on an older version fails the release instead of shipping it.
 */
export function bumpManifest(text: string, from: string, to: string): string {
  const versionField = `"version": "${from}"`;
  if (!text.includes(versionField)) throw new Error(`no ${versionField} in this file`);
  return text.replaceAll(versionField, `"version": "${to}"`).replaceAll(`banjo:${from}`, `banjo:${to}`);
}
