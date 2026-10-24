#!/usr/bin/env -S npx tsx
/**
 * Bumps every release manifest to a new version, for the release workflow
 * (.github/workflows/release.yml) or by hand: `npx tsx scripts/release/bump.ts 0.1.15`.
 * package.json and package-lock.json go through `npm version`; server.json
 * and the plugin manifest through bumpManifest(). tests/releaseManifests.test.ts
 * checks they agree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { bumpManifest, checkVersion } from './lib.js';

const MANIFESTS = ['server.json', '.claude-plugin/plugin.json'];

const current = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const next = checkVersion(process.argv[2] ?? '', current);

// Checked before anything is written, so a failure leaves every file as it was.
const bumped = MANIFESTS.map((path) => [path, bumpManifest(readFileSync(path, 'utf8'), current, next)] as const);
execFileSync('npm', ['version', next, '--no-git-tag-version'], { stdio: 'inherit' });
for (const [path, text] of bumped) writeFileSync(path, text);
console.log(`${current} -> ${next}`);
