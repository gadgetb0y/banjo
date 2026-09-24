import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOwnerProfile, OWNER_PROFILE_MAX_CHARS, readOwnerProfile } from '../../src/tasks/ownerProfile.js';

const dir = mkdtempSync(join(tmpdir(), 'banjo-profile-'));
function profileFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('loadOwnerProfile (boot: fail fast)', () => {
  it('returns the trimmed file contents', () => {
    expect(loadOwnerProfile(profileFile('ok.md', '\n  Banjo is a doodle.  \n'))).toBe('Banjo is a doodle.');
  });

  it('throws a message naming the setting when the file is missing', () => {
    expect(() => loadOwnerProfile(join(dir, 'nope.md'))).toThrow(/PROMPT_PROFILE_FILE/);
  });

  it('refuses a profile over the size cap rather than silently cutting it', () => {
    // Every call pays for this text in the prompt, and a truncated profile
    // could drop exactly the line that mattered.
    const path = profileFile('big.md', 'x'.repeat(OWNER_PROFILE_MAX_CHARS + 1));
    expect(() => loadOwnerProfile(path)).toThrow(/characters/);
  });
});

describe('readOwnerProfile (per call: never fails the call)', () => {
  it('returns undefined when no profile is configured', () => {
    expect(readOwnerProfile(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty file, so no empty section reaches the prompt', () => {
    expect(readOwnerProfile(profileFile('empty.md', '  \n'))).toBeUndefined();
  });

  it('returns undefined instead of throwing when the file has gone missing since boot', () => {
    expect(readOwnerProfile(join(dir, 'deleted.md'))).toBeUndefined();
  });

  it('picks up edits without a restart', () => {
    const path = profileFile('edit.md', 'first');
    expect(readOwnerProfile(path)).toBe('first');
    writeFileSync(path, 'second');
    expect(readOwnerProfile(path)).toBe('second');
  });
});
