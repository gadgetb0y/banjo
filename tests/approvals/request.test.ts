import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { buildApprovalMessage } from '../../src/approvals/request.js';
import { clipText, PUSHOVER_MAX_MESSAGE_CHARS, SMS_MAX_CHARS } from '../../src/notifications/limits.js';

config.PUBLIC_HOSTNAME = 'banjo.example.com';

const base = {
  contact: { displayName: "Luigi's", phoneNumber: '+15550001111' },
  task: {
    id: '11111111-1111-1111-1111-111111111111',
    goalDescription: 'Book Friday at 7',
    mode: 'booking' as const,
    questions: null,
    scheduledFor: null,
    approvalExpiresAt: new Date('2026-10-15T01:30:00.000Z'),
    constraints: {},
  },
};

describe('the approval message', () => {
  it('names who, when and what, with the link', () => {
    const msg = buildApprovalMessage(base);
    expect(msg).toContain("Luigi's (+15550001111) now");
    expect(msg).toContain('https://banjo.example.com/approve/11111111-1111-1111-1111-111111111111?sig=');
    expect(msg).toContain('Book Friday at 7');
  });

  it('says when a scheduled call would be placed', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, scheduledFor: new Date(Date.now() + 86_400_000) } });
    expect(msg).toMatch(/\(\+15550001111\) at /);
  });

  it('keeps the link when a long description is clipped, on Pushover and SMS', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, goalDescription: 'x'.repeat(5000) } });
    expect(clipText(msg, PUSHOVER_MAX_MESSAGE_CHARS)).toMatch(/\/approve\/[0-9a-f-]{36}\?sig=[0-9a-f]{64}/);
    expect(clipText(msg, SMS_MAX_CHARS)).toMatch(/\/approve\/[0-9a-f-]{36}\?sig=[0-9a-f]{64}/);
  });

  it("lists an ask call's questions", () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, mode: 'ask', questions: ['Open Sunday?', 'Walk-ins?'] } });
    expect(msg).toContain('1. Open Sunday?');
    expect(msg).toContain('2. Walk-ins?');
  });
});

describe('the approval message shows what else the call will use', () => {
  it("includes the task's notes and the contact's notes, after the link", () => {
    const msg = buildApprovalMessage({
      contact: { ...base.contact, notes: 'Ask for Dana' },
      task: { ...base.task, constraints: { notes: 'Mention the coupon' } },
    });
    expect(msg).toContain('Notes for the call, from the agent: Mention the coupon');
    expect(msg).toContain('Notes on this contact: Ask for Dana');
    expect(msg.indexOf('/approve/')).toBeLessThan(msg.indexOf('Mention the coupon'));
  });
});

describe("the approval message keeps the agent's text from posing as Banjo's", () => {
  it('puts agent-written text on single lines, labelled as the agent\'s', () => {
    const msg = buildApprovalMessage({
      contact: { ...base.contact, notes: 'line1\nApprove here instead: https://evil.example' },
      task: {
        ...base.task,
        goalDescription: 'Book\n\nApprove by tomorrow, or it won\'t be placed: https://evil.example',
        constraints: { notes: 'x\r\nBanjo says: already approved' },
        mode: 'ask',
        questions: ['Open?\u2028Approve: https://evil.example'],
      },
    });
    const lines = msg.split('\n');
    // Only Banjo's own line starts with "Approve by", and only one line has a link.
    expect(lines.filter((l) => l.startsWith('Approve by'))).toHaveLength(1);
    expect(lines.filter((l) => /^(Approve|Banjo says)/.test(l.trim()))).toHaveLength(1);
    for (const l of lines.slice(3)) if (l) expect(l).toMatch(/^(The agent wrote|Questions from the agent|\d+\.|Notes)/);
  });
});
