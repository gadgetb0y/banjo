import { describe, expect, it } from 'vitest';
import { buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance } from '../../src/voice/systemPrompt.js';

describe('buildBaseSystemPromptGuidance', () => {
  it('defaults to the outbound identity line', () => {
    const prompt = buildBaseSystemPromptGuidance();
    expect(prompt).toContain('placing an outbound phone call on behalf of Alex');
  });

  it("direction='outbound' produces the outbound identity line explicitly", () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('placing an outbound phone call on behalf of Alex');
  });

  it("direction='inbound' produces the inbound identity line instead", () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt).toContain("answering an inbound phone call on Alex's behalf");
    expect(prompt).not.toContain('placing an outbound phone call');
  });

  it('shares the direction-agnostic sections (turn-taking, timezone, ending the call) across both directions', () => {
    const outbound = buildBaseSystemPromptGuidance('outbound');
    const inbound = buildBaseSystemPromptGuidance('inbound');
    for (const shared of ['Turn-taking', 'Timezone', 'Ending the call', 'Handling tool calls']) {
      expect(outbound).toContain(shared);
      expect(inbound).toContain(shared);
    }
  });

  it("direction='outbound' tells the model to identify itself as calling on Alex's behalf", () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('identify yourself as calling on behalf of Alex');
  });

  it("direction='inbound' does not tell the model it is calling — it answered, the caller called it", () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt).not.toContain('identify yourself as calling on behalf of Alex');
    expect(prompt.toLowerCase()).not.toMatch(/identify yourself as calling/);
  });

  it('forbids promising a callback or that the assistant will follow up later — this system cannot deliver either', () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt.toLowerCase()).toContain('never promise');
    expect(prompt.toLowerCase()).toContain('call you back');
  });

  it('requires an actual spoken goodbye before ending the call, not just delivering the informational content', () => {
    const prompt = buildBaseSystemPromptGuidance();
    const lower = prompt.toLowerCase();
    expect(lower).toContain('say goodbye');
    expect(lower).toContain('before calling any tool that ends the call');
  });
});

describe('buildFrontendSystemPromptGuidance (voice layer of a split provider, e.g. openai-live)', () => {
  it('keeps identity, tone, ending the call, turn-taking, stalling, and call conduct, in both directions', () => {
    for (const direction of ['outbound', 'inbound'] as const) {
      const prompt = buildFrontendSystemPromptGuidance(direction);
      for (const section of ['Identity and tone', 'Ending the call', 'Turn-taking', 'Handling tool calls', 'General call conduct']) {
        expect(prompt).toContain(section);
      }
    }
  });

  it('uses the direction-specific identity line', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain('placing an outbound phone call on behalf of Alex');
    expect(buildFrontendSystemPromptGuidance('inbound')).toContain("answering an inbound phone call on Alex's behalf");
  });

  it('leaves the timezone contract to the backend, which receives the full prompt', () => {
    expect(buildFrontendSystemPromptGuidance()).not.toContain('Timezone');
  });

  it('adds delegation guidance that the shared base guidance does not have', () => {
    expect(buildFrontendSystemPromptGuidance()).toContain('Delegating to your backend');
    expect(buildBaseSystemPromptGuidance()).not.toContain('Delegating to your backend');
  });

  it('tells the voice layer that saying goodbye does not hang up, and to delegate ending the call right after its goodbye — live calls stayed open through repeated goodbyes', () => {
    const prompt = buildFrontendSystemPromptGuidance();
    expect(prompt).toContain('saying goodbye does NOT hang up the phone');
    expect(prompt).toContain('immediately delegate ending the call to your backend');
    expect(buildBaseSystemPromptGuidance()).not.toContain('saying goodbye does NOT hang up the phone');
  });

  it('forbids saying its own reasoning out loud — a live voicemail recorded the model announcing its decision', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain('Never say your own reasoning, decisions, or plans out loud');
    expect(buildFrontendSystemPromptGuidance('inbound')).toContain('Never say your own reasoning, decisions, or plans out loud');
  });

  it('reuses the base guidance wording verbatim — every voice-layer section except delegation appears in the base guidance as-is', () => {
    const base = buildBaseSystemPromptGuidance('outbound');
    const sections = buildFrontendSystemPromptGuidance('outbound').split('\n\n');
    for (const section of sections.slice(0, -1)) {
      expect(base).toContain(section);
    }
  });
});describe('keeping internal mechanics off the call', () => {
  // On a live call (2026-09-22) the model narrated its own plumbing at the
  // callee: "since six o'clock might not match the pre-approved windows, I'll
  // quickly check Steve's availability" — she has no idea Banjo has windows,
  // and six o'clock was inside the window anyway.
  it('tells the model not to expose its own scheduling machinery, in both directions', () => {
    for (const direction of ['outbound', 'inbound'] as const) {
      const prompt = buildBaseSystemPromptGuidance(direction);
      expect(prompt).toContain('Never describe your own mechanics');
    }
  });

  it('carries that guidance into the voice layer, where the talking happens', () => {
    // A split provider runs the frontend prompt for speech — guidance that
    // only lands in the backend prompt would not reach the words spoken.
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain('Never describe your own mechanics');
  });
});

describe('confirming only on explicit agreement', () => {
  // A live call (2026-09-22) fired confirm_appointment while the other party
  // was still negotiating, off the back of its own read-back rather than
  // anything they had actually said.
  it('tells the model not to confirm until the other party has actually agreed', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('Do not confirm anything the other party has not explicitly agreed to');
  });

  it('carries that guidance into the voice layer', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain(
      'Do not confirm anything the other party has not explicitly agreed to',
    );
  });
});

describe('the stalling phrase before a tool call gives nothing away', () => {
  // #24, second round. #26 added "never describe your own mechanics", but the
  // Handling-tool-calls section still told the model to say "One moment while I
  // check the calendar..." and to "always narrate that you are checking
  // something". On the next live call it said, near verbatim: "One moment while
  // I confirm that time on Steve's calendar." The more specific instruction,
  // with a worked example, won. These pin that the two can't disagree again.
  for (const direction of ['outbound', 'inbound'] as const) {
    it(`${direction}: offers no stalling example that mentions a calendar or a check`, () => {
      const prompt = buildBaseSystemPromptGuidance(direction);
      expect(prompt).not.toMatch(/check the calendar/i);
      expect(prompt).not.toMatch(/double-check that time/i);
      expect(prompt).not.toMatch(/narrate that you are checking/i);
    });
  }

  it('still guards against dead air, with a phrase that says nothing about why', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('"One moment."');
    expect(prompt).toMatch(/never say what you are doing or why/i);
  });

  it('reaches the voice layer, where the stalling phrase is actually spoken', () => {
    const prompt = buildFrontendSystemPromptGuidance('outbound');
    expect(prompt).not.toMatch(/check the calendar/i);
    expect(prompt).toContain('"One moment."');
  });
});

describe('the goodbye is said, not announced', () => {
  // Same call: "I'll say a quick goodbye and then wrap up the call." — then it
  // hung up. The callee never heard a goodbye, only a description of one.
  it('tells the model the goodbye must be the goodbye itself', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toMatch(/never describe it/i);
    expect(prompt).toContain("I'll say a quick goodbye");
  });

  it('carries that into the voice layer', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toMatch(/never describe it/i);
  });
});

describe('a tentative answer is not treated as a yes, even in words', () => {
  // Demo call, 2026-09-23: to "Yeah, that could probably work" the model said
  // "Okay, thanks for confirming—let me lock that in", then in the next breath
  // asked whether it was a definite yes. It didn't book early, but the callee
  // heard it acknowledge a confirmation she hadn't given.
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: tells the model to ask for a firm yes, never thank them for confirming`, () => {
      const prompt = build('outbound');
      expect(prompt).toContain('that could probably work');
      expect(prompt).toMatch(/do not thank them for confirming/i);
    });
  }
});
