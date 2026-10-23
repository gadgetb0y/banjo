import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_TASK_STATUSES, KNOWN_TOOL_NAMES, loadScenario, loadScenarios } from '../../src/evals/scenario.js';

const VALID = `
id: basic
title: A basic booking
source: hand-written
task:
  business: Claudia's Dog Grooming
  category: salon
  goal: Book a grooming.
  mode: booking
  durationMinutes: 60
  windowDays: 3
script:
  - Claudia's, how can I help?
  - ~Please hold.
  - (silence 10)
expect:
  status: [confirmed]
  toolsCalled:
    - name: confirm_appointment
`;

function write(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('loadScenario', () => {
  it('loads a valid scenario, with flag defaults and parsed script steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    const s = loadScenario(write(dir, 'basic.yaml', VALID));
    expect(s.flags).toEqual({ transfer: false, warm: false, owner: 'accept' });
    expect(s.script).toEqual([
      { kind: 'line', text: "Claudia's, how can I help?" },
      { kind: 'recording', text: 'Please hold.' },
      { kind: 'silence', seconds: 10 },
    ]);
    expect(s.expect.toolsCalled).toEqual([{ name: 'confirm_appointment' }]);
  });

  it('an unknown tool name fails with the file and path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    const path = write(dir, 'basic.yaml', VALID.replace('name: confirm_appointment', 'name: confirm_apointment'));
    expect(() => loadScenario(path)).toThrow(/basic\.yaml.*expect\.toolsCalled\.0\.name.*confirm_appointment/s);
  });

  it('an unknown status fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    expect(() => loadScenario(write(dir, 'basic.yaml', VALID.replace('[confirmed]', '[booked]')))).toThrow(/expect\.status\.0/);
  });

  it('a misspelled key fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    expect(() => loadScenario(write(dir, 'basic.yaml', VALID.replace('toolsCalled:', 'toolCalled:')))).toThrow(/toolCalled/);
  });

  it('an unknown universal check in skipUniversal fails, and so does one without a reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    expect(() => loadScenario(write(dir, 'basic.yaml', `${VALID}skipUniversal:\n  - check: say_hello\n    reason: x\n`))).toThrow(/skipUniversal/);
    expect(() => loadScenario(write(dir, 'basic.yaml', `${VALID}skipUniversal:\n  - check: disclosure_once\n`))).toThrow(/reason/);
  });

  it('a bad script step fails with the file named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    expect(() => loadScenario(write(dir, 'basic.yaml', VALID.replace('(silence 10)', '(silence 0)')))).toThrow(/basic\.yaml.*silence/s);
  });

  it('the id must match the file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    expect(() => loadScenario(write(dir, 'other.yaml', VALID))).toThrow(/other\.yaml.*id "basic"/s);
  });
});

describe('loadScenarios', () => {
  it('loads every .yaml in a directory, sorted by id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    write(dir, 'zeta.yaml', VALID.replace('id: basic', 'id: zeta'));
    write(dir, 'alpha.yaml', VALID.replace('id: basic', 'id: alpha'));
    expect(loadScenarios(dir).map((s) => s.id)).toEqual(['alpha', 'zeta']);
  });
});

describe('the known names', () => {
  it('KNOWN_TOOL_NAMES are exactly the tools a call can be given', async () => {
    const t = await import('../../src/voice/tools/callTools.js');
    const { pressDigitsTool } = await import('../../src/telephony/dtmf.js');
    const { TRANSFER_TOOL_NAME } = await import('../../src/telephony/transfer.js');
    const { ASK_OWNER_TOOL_NAME } = await import('../../src/ownerQuestions/tool.js');
    // callTools is booking + common; the conversation and ask modes' tools, hold and digits are offered apart.
    const others = [t.endConversationCallTool, t.recordAnswerTool, t.reportAnswersAndEndCallTool, t.waitOnHoldTool, pressDigitsTool];
    const actual = new Set([...t.callTools, ...others].map((tool) => tool.name).concat(TRANSFER_TOOL_NAME, ASK_OWNER_TOOL_NAME));
    expect(new Set(KNOWN_TOOL_NAMES)).toEqual(actual);
  });

  it('KNOWN_TASK_STATUSES are exactly the task status enum', async () => {
    const { taskStatusEnum } = await import('../../src/tasks/schema.js');
    expect([...KNOWN_TASK_STATUSES]).toEqual(taskStatusEnum.enumValues);
  });
});
