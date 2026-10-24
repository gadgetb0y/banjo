import { describe, expect, it } from 'vitest';
import { bumpManifest, checkVersion } from '../../scripts/release/lib.js';

const SERVER = `{
  "name": "io.github.shatch/banjo",
  "version": "0.1.14",
  "packages": [
    {
      "registryType": "oci",
      "identifier": "ghcr.io/shatch/banjo:0.1.14",
      "environmentVariables": [
        { "name": "DATABASE_URL", "description": "Postgres connection URL.", "isRequired": true }
      ]
    }
  ]
}
`;

describe('checkVersion', () => {
  it('takes a plain X.Y.Z newer than the current one', () => {
    expect(checkVersion('0.1.15', '0.1.14')).toBe('0.1.15');
    expect(checkVersion('0.2.0', '0.1.14')).toBe('0.2.0');
    expect(checkVersion('1.0.0', '0.9.9')).toBe('1.0.0');
  });

  it('rejects a leading v, a pre-release, garbage, or a version not newer', () => {
    expect(() => checkVersion('v0.1.15', '0.1.14')).toThrow(/X\.Y\.Z/);
    expect(() => checkVersion('0.1.15-rc.1', '0.1.14')).toThrow(/X\.Y\.Z/);
    expect(() => checkVersion('0.1.15; rm -rf /', '0.1.14')).toThrow(/X\.Y\.Z/);
    expect(() => checkVersion('0.1.14', '0.1.14')).toThrow(/newer/);
    expect(() => checkVersion('0.1.9', '0.1.14')).toThrow(/newer/);
  });
});

describe('bumpManifest', () => {
  it("changes only server.json's version and image tag, keeping its layout", () => {
    const bumped = bumpManifest(SERVER, '0.1.14', '0.1.15');
    expect(bumped).toBe(SERVER.replace('"version": "0.1.14"', '"version": "0.1.15"').replace('banjo:0.1.14', 'banjo:0.1.15'));
  });

  it('bumps the plugin manifest', () => {
    const plugin = '{\n  "name": "banjo",\n  "version": "0.1.14",\n  "description": "x"\n}\n';
    expect(bumpManifest(plugin, '0.1.14', '0.1.15')).toBe(plugin.replace('0.1.14', '0.1.15'));
  });

  it('refuses a file whose version is not the current one, rather than leave it behind', () => {
    expect(() => bumpManifest(SERVER, '0.1.13', '0.1.15')).toThrow(/0\.1\.13/);
  });
});
