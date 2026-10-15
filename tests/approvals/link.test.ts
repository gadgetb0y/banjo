import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { approvalSignature, approvalUrl, isValidApprovalSignature } from '../../src/approvals/link.js';

const ID = '11111111-1111-1111-1111-111111111111';
const EXPIRES = new Date('2026-10-15T01:30:00.000Z');

describe('approval links', () => {
  it('verifies its own signature and nothing else', () => {
    const sig = approvalSignature(ID, EXPIRES);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidApprovalSignature(ID, EXPIRES, sig)).toBe(true);
    expect(isValidApprovalSignature('22222222-2222-2222-2222-222222222222', EXPIRES, sig)).toBe(false);
    expect(isValidApprovalSignature(ID, new Date(EXPIRES.getTime() + 1), sig)).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, sig.slice(0, -1))).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, sig.toUpperCase())).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, '')).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, 'zz'.repeat(32))).toBe(false);
  });

  it('is keyed from MCP_API_KEY, so rotating it voids old links', () => {
    const sig = approvalSignature(ID, EXPIRES);
    const original = config.MCP_API_KEY;
    config.MCP_API_KEY = 'a-different-owner-key-0123456789abcdef';
    try {
      expect(isValidApprovalSignature(ID, EXPIRES, sig)).toBe(false);
    } finally {
      config.MCP_API_KEY = original;
    }
  });

  it('is not keyed by the agent key, which the agent holds', () => {
    const sig = approvalSignature(ID, EXPIRES);
    config.MCP_AGENT_API_KEY = 'agent-key-for-tests-only-0123456789';
    try {
      expect(approvalSignature(ID, EXPIRES)).toBe(sig);
    } finally {
      config.MCP_AGENT_API_KEY = undefined;
    }
  });

  it('builds the link on PUBLIC_HOSTNAME', () => {
    const original = config.PUBLIC_HOSTNAME;
    config.PUBLIC_HOSTNAME = 'banjo.example.com';
    try {
      expect(approvalUrl(ID, EXPIRES)).toBe(`https://banjo.example.com/approve/${ID}?sig=${approvalSignature(ID, EXPIRES)}`);
    } finally {
      config.PUBLIC_HOSTNAME = original;
    }
  });
});
