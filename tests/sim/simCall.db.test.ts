import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TextVoiceAIProvider } from '../../src/sim/simCall.js';
import type { VoiceAIEvent, VoiceAIEventListener } from '../../src/voice/types.js';

// DB-backed (banjo_test — see vitest.config.ts). The simulator's whole point is
// that only the phone line, calendar and voice transport are fake, so this runs
// the real place_call handler, orchestrator, CallSession and tools, with a
// scripted voice session standing in for OpenAI.

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let sim: typeof import('../../src/sim/simCall.js');
let formatInZone: typeof import('../../src/lib/timezone.js').formatInZone;
let timeZone: string;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  sim = await import('../../src/sim/simCall.js');
  ({ formatInZone } = await import('../../src/lib/timezone.js'));
  timeZone = (await import('../../src/config/index.js')).config.CALENDAR_TIMEZONE;
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}

beforeEach(clearTables);
afterEach(() => sim.endSimOverrides());
afterAll(clearTables);

/**
 * Plays Banjo's side of a booking: on the receptionist's first line it books
 * 2pm the day after tomorrow, then says goodbye and ends the call.
 */
class ScriptedBanjo implements TextVoiceAIProvider {
  readonly name = 'scripted';
  readonly typed: string[] = [];
  private emitter = new EventEmitter();
  constructor(private readonly confirmedStart: string) {}

  async connect(): Promise<void> {
    setImmediate(() => this.emit({ type: 'connected' }));
  }

  sendUserText(text: string): void {
    this.typed.push(text);
    this.emit({ type: 'transcript', role: 'user', text, isFinal: true });
    this.say("Hi, I'm an AI assistant calling for Alex to book a grooming.");
    this.emit({
      type: 'tool_call',
      call: { id: 'confirm-1', name: 'confirm_appointment', arguments: { confirmedStart: this.confirmedStart, durationMinutes: 60, summary: 'Grooming' } },
    });
  }

  sendToolResult(toolCallId: string, result: unknown): void {
    if (toolCallId !== 'confirm-1' || !(result as { ok?: boolean }).ok) return;
    this.say("You're all set. Thanks so much, bye!");
    this.emit({ type: 'tool_call', call: { id: 'end-1', name: 'end_call', arguments: { summary: 'Booked.' } } });
    this.emit({ type: 'turn_end' });
  }

  sendAudioChunk(): void {}
  interrupt(): void {}
  triggerResponse(): void {}
  sayVerbatim(): void {}
  async disconnect(): Promise<void> {}
  on(_event: 'event', listener: VoiceAIEventListener): void {
    this.emitter.on('event', listener);
  }
  off(_event: 'event', listener: VoiceAIEventListener): void {
    this.emitter.off('event', listener);
  }

  private say(text: string): void {
    this.emit({ type: 'transcript', role: 'assistant', text, isFinal: true });
    this.emit({ type: 'turn_end' });
  }

  private emit(event: VoiceAIEvent): void {
    this.emitter.emit('event', event);
  }
}

describe('startSimCall', () => {
  it('runs a booking through the real call path into the sim calendar, and reports it', async () => {
    const dayAfterTomorrow = formatInZone(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(), timeZone).slice(0, 10);
    const banjo = new ScriptedBanjo(`${dayAfterTomorrow}T14:00:00`);
    const printed: string[] = [];

    const call = await sim.startSimCall({
      business: "Claudia's Dog Grooming",
      category: 'salon',
      goal: 'Book a grooming appointment.',
      mode: 'booking',
      durationMinutes: 60,
      windowDays: 3,
      createVoiceAI: () => banjo,
      print: (line) => printed.push(line),
    });

    const voice = await call.ready;
    expect(voice).toBe(banjo);
    voice!.sendUserText("Claudia's, how can I help?");
    const task = await call.finished;

    expect(task.status).toBe('confirmed');
    expect(call.calendar.events).toHaveLength(1);
    expect(formatInZone(new Date(call.calendar.events[0]!.startMs).toISOString(), timeZone)).toBe(`${dayAfterTomorrow}T14:00:00`);
    expect(printed).toContain("Banjo: You're all set. Thanks so much, bye!");
    expect(printed.some((line) => line.startsWith('  → confirm_appointment'))).toBe(true);
    expect(printed.some((line) => line.startsWith('[calendar] would book "Grooming"'))).toBe(true);
    expect(printed).toContain('[Banjo hung up]');
  }, 20_000);

  it('resolves ready with null, and finishes, when the voice session never connects', async () => {
    class Unreachable extends ScriptedBanjo {
      override async connect(): Promise<void> {
        throw new Error('OpenAI is unreachable');
      }
    }
    const call = await sim.startSimCall({
      business: "Claudia's Dog Grooming",
      category: 'salon',
      goal: 'Book a grooming appointment.',
      mode: 'booking',
      durationMinutes: 60,
      windowDays: 3,
      createVoiceAI: () => new Unreachable('2026-01-01T14:00:00'),
      print: () => {},
    });

    expect(await call.ready).toBeNull();
    expect((await call.finished).status).toBe('failed');
    expect(call.calendar.events).toEqual([]);
  }, 20_000);

  // #148 review, finding 10: the sim called placeCallHandler directly, so
  // nothing checked its input against place_call's schema.
  describe("mode 'ask'", () => {
    class Unreachable extends ScriptedBanjo {
      override async connect(): Promise<void> {
        throw new Error('OpenAI is unreachable');
      }
    }
    const askCall = (questions: string[]) =>
      sim.startSimCall({
        business: "Claudia's Dog Grooming",
        category: 'salon',
        goal: 'Find out their hours.',
        mode: 'ask',
        questions,
        durationMinutes: 60,
        windowDays: 3,
        createVoiceAI: () => new Unreachable('2026-01-01T14:00:00'),
        print: () => {},
      });

    it('refuses questions place_call would refuse, with the schema\'s message, before creating anything', async () => {
      await expect(askCall([''])).rejects.toThrow(/questions/);
      await expect(askCall(['a', 'b', 'c', 'd', 'e', 'f'])).rejects.toThrow(/questions/);
      await expect(askCall(['Hours?\n2. Walk-ins?'])).rejects.toThrow(/one line/);
      expect(await db.select().from(tasks)).toEqual([]);
      expect(await db.select().from(contacts)).toEqual([]);
    });

    it('passes no appointment length or date windows', async () => {
      const call = await askCall(['What time do you close Saturday?']);
      const task = await call.finished;
      expect(task.mode).toBe('ask');
      expect(task.questions).toEqual(['What time do you close Saturday?']);
      expect(task.constraints?.durationMinutes).toBeUndefined();
      expect(task.constraints?.dateWindows).toBeUndefined();
    }, 20_000);
  });
});
