import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The version lives in four places: package.json (what the MCP server
// reports), server.json (the MCP Registry listing and the image tag it
// points at), the Claude Code plugin manifest, and the Dockerfile label the
// registry checks the image against. A release that bumps one and not the
// others publishes a listing pointing at the wrong image.
const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

const pkg = json('package.json');
const server = json('server.json');
const plugin = json('.claude-plugin/plugin.json');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

describe('release manifests', () => {
  it('server.json and the plugin manifest carry the package.json version', () => {
    expect(server.version).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
  });

  it('server.json points at the image tag for that version', () => {
    expect(server.packages[0].identifier).toBe(`ghcr.io/shatch/banjo:${pkg.version}`);
  });

  it("the Dockerfile's registry label matches server.json's name", () => {
    expect(dockerfile).toContain(`LABEL io.modelcontextprotocol.server.name="${server.name}"`);
  });
});
