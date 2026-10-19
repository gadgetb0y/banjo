import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOwnerQuestion, answerQuestion } = vi.hoisted(() => ({ getOwnerQuestion: vi.fn(), answerQuestion: vi.fn() }));
vi.mock('../../src/ownerQuestions/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ownerQuestions/service.js')>()),
  getOwnerQuestion,
  answerQuestion,
}));

const { ownerQuestionRoutes } = await import('../../src/ownerQuestions/routes.js');
const { answerSignature } = await import('../../src/ownerQuestions/link.js');

const ID = '22222222-2222-2222-2222-222222222222';
const EXPIRES = new Date(Date.now() + 2 * 60_000);
const SIG = answerSignature(ID, EXPIRES);

const question = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  question: 'Which <b>day</b> works?',
  answer: null,
  answeredAt: null,
  expiresAt: EXPIRES,
  ...overrides,
});

const post = (fields: Record<string, string>) =>
  ownerQuestionRoutes.request(`/answer/${ID}`, { method: 'POST', body: new URLSearchParams(fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

beforeEach(() => {
  vi.clearAllMocks();
  getOwnerQuestion.mockResolvedValue(question());
});

describe('GET /answer/:id', () => {
  it('shows the question escaped, with a form, and answers nothing', async () => {
    const res = await ownerQuestionRoutes.request(`/answer/${ID}?sig=${SIG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Which &lt;b&gt;day&lt;/b&gt; works?');
    expect(html).toContain('<textarea name="answer"');
    expect(html).toContain('saved in the call');
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('gives the same invalid page for a bad signature or an unknown question', async () => {
    expect((await ownerQuestionRoutes.request(`/answer/${ID}?sig=${'0'.repeat(64)}`)).status).toBe(404);
    getOwnerQuestion.mockResolvedValue(undefined);
    expect((await ownerQuestionRoutes.request(`/answer/${ID}?sig=${SIG}`)).status).toBe(404);
    expect((await ownerQuestionRoutes.request(`/answer/not-a-uuid?sig=${SIG}`)).status).toBe(404);
  });

  it('shows an answered question without the form', async () => {
    getOwnerQuestion.mockResolvedValue(question({ answer: 'Tuesday', answeredAt: new Date() }));
    const html = await (await ownerQuestionRoutes.request(`/answer/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('Already answered: Tuesday');
    expect(html).not.toContain('<form');
  });
});

describe('POST /answer/:id', () => {
  it('saves the answer and says whether Banjo got it', async () => {
    answerQuestion.mockResolvedValue({ result: 'answered', delivered: true });
    const res = await post({ sig: SIG, answer: 'Tuesday morning' });
    expect(answerQuestion).toHaveBeenCalledWith(ID, 'Tuesday morning');
    expect(await res.text()).toContain('Banjo has your answer');
  });

  it('says so when the call has already ended', async () => {
    answerQuestion.mockResolvedValue({ result: 'answered', delivered: false });
    expect(await (await post({ sig: SIG, answer: 'x' })).text()).toContain('already ended');
  });

  it('refuses a bad signature and an empty answer', async () => {
    expect((await post({ sig: 'bad', answer: 'x' })).status).toBe(404);
    expect((await post({ sig: SIG, answer: '   ' })).status).toBe(400);
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
