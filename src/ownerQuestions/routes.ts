import { Hono, type Context } from 'hono';
import { config } from '../config/index.js';
import { escapeHtml, page } from '../approvals/page.js';
import { HEADERS, UUID } from '../approvals/routes.js';
import { isValidAnswerSignature } from './link.js';
import type { OwnerQuestion } from './schema.js';
import { MAX_ANSWER_CHARS, answerQuestion, getOwnerQuestion } from './service.js';

/**
 * The owner's page for answering an ask_owner question. As with approvals,
 * GET only shows it, so a link preview or prefetch can't answer anything,
 * and every bad link gets the same page, so it can't be used to find ids.
 */
export const ownerQuestionRoutes = new Hono();

function invalid(c: Context) {
  return c.html(page('Banjo', '<h1>This link isn’t valid</h1>'), 404, HEADERS);
}

async function signedQuestion(id: string, sig: string | undefined): Promise<OwnerQuestion | undefined> {
  if (!sig || !UUID.test(id)) return undefined;
  const question = await getOwnerQuestion(id);
  if (!question) return undefined;
  return isValidAnswerSignature(question.id, question.expiresAt, sig) ? question : undefined;
}

ownerQuestionRoutes.get('/answer/:id', async (c) => {
  const sig = c.req.query('sig');
  const question = await signedQuestion(c.req.param('id'), sig);
  if (!question) return invalid(c);
  const asked = `<dl><dt>Banjo asks</dt><dd>${escapeHtml(question.question)}</dd></dl>`;
  const action = question.answeredAt
    ? `<p>Already answered: ${escapeHtml(question.answer ?? '')}</p>`
    : question.expiresAt.getTime() <= Date.now()
      ? '<p>This question has expired. Banjo carried on without the answer.</p>'
      : `<form method="post" action="/answer/${question.id}"><input type="hidden" name="sig" value="${escapeHtml(sig!)}">` +
        `<p><textarea name="answer" rows="4" maxlength="${MAX_ANSWER_CHARS}" required style="width:100%;font:inherit"></textarea></p>` +
        `<p class="warn">Banjo will use your answer on the call, and it's saved in the call's transcript.</p>` +
        `<button type="submit">Send to Banjo</button></form>`;
  return c.html(page('Banjo has a question', `<h1>Banjo has a question for ${escapeHtml(config.ASSISTANT_PRINCIPAL_NAME)}</h1>${asked}${action}`), 200, HEADERS);
});

ownerQuestionRoutes.post('/answer/:id', async (c) => {
  const body = await c.req.parseBody();
  const sig = typeof body.sig === 'string' ? body.sig : undefined;
  const question = await signedQuestion(c.req.param('id'), sig);
  if (!question) return invalid(c);
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!answer) return c.html(page('Banjo', '<h1>The answer was empty</h1><p>Go back and type an answer.</p>'), 400, HEADERS);
  const outcome = await answerQuestion(question.id, answer);
  const message =
    outcome.result === 'answered'
      ? outcome.delivered
        ? 'Sent. Banjo has your answer.'
        : 'Saved, but the call has already ended, so Banjo couldn’t use it.'
      : outcome.result === 'already_answered'
        ? 'This question was already answered.'
        : 'This question has expired. Banjo carried on without the answer.';
  return c.html(page('Banjo', `<h1>${escapeHtml(message)}</h1>`), 200, HEADERS);
});
