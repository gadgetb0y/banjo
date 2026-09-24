import { describe, expect, it } from 'vitest';
import { classifyTranscript } from '../../src/session/transcriptQuality.js';

describe('classifyTranscript (#25)', () => {
  it('empty: finalised turns with no text, which live calls produce several of', () => {
    expect(classifyTranscript('')).toBe('empty');
    expect(classifyTranscript('   ')).toBe('empty');
  });

  it('suspect: text in a script the call is not in — the transcriber inventing speech from line noise', () => {
    expect(classifyTranscript('ᱤᱠ')).toBe('suspect'); // Santali, 2026-09-22
    expect(classifyTranscript('아...')).toBe('suspect'); // Korean, 2026-09-22
  });

  it('suspect: punctuation or symbols with no words or numbers', () => {
    expect(classifyTranscript('...')).toBe('suspect');
    expect(classifyTranscript('?!')).toBe('suspect');
  });

  it('ok: ordinary speech, including short fillers, accents and bare numbers', () => {
    for (const text of ['Hello?', 'Uh.', 'Friday at 10 a.m.', 'Café', '10:30', 'OK 아']) {
      expect(classifyTranscript(text), text).toBe('ok');
    }
  });
});
