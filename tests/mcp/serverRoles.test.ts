import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config/index.js';

// The role comes from which key the caller presented, and only from that:
// place_call is the one tool that behaves differently by role.
const { placeCallHandler } = vi.hoisted(() => ({
  placeCallHandler: vi.fn(async () => ({ taskId: 't', ackMessage: 'ok' })),
}));
vi.mock('../../src/mcp/tools/placeCall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/tools/placeCall.js')>()),
  placeCallHandler,
}));

const { registerMcpRoutes, sessionRoleMatches } = await import('../../src/mcp/server.js');

const AGENT_KEY = 'agent-key-for-tests-only-0123456789';
const CONTACT_ID = '11111111-1111-1111-1111-111111111111';

function buildApp(): Hono {
  const app = new Hono();
  registerMcpRoutes(app);
  return app;
}

const clients: Client[] = [];

async function connect(token: string): Promise<Client> {
  const app = buildApp();
  const transport = new StreamableHTTPClientTransport(new URL('http://banjo.test/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init),
  });
  const client = new Client({ name: 'banjo-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  config.MCP_AGENT_API_KEY = AGENT_KEY;
});

afterEach(async () => {
  config.MCP_AGENT_API_KEY = undefined;
  for (const client of clients.splice(0)) await client.close();
});

describe('mcp server: owner and agent keys', () => {
  it('accepts the agent key on every route', async () => {
    const res = await buildApp().request('/mcp/messages', { method: 'POST', headers: { Authorization: `Bearer ${AGENT_KEY}` } });
    expect(res.status).toBe(400); // past auth: no sessionId
  });

  it('rejects the agent key when no agent key is configured', async () => {
    config.MCP_AGENT_API_KEY = undefined;
    const res = await buildApp().request('/mcp/messages', { method: 'POST', headers: { Authorization: `Bearer ${AGENT_KEY}` } });
    expect(res.status).toBe(401);
  });

  it.each([
    ['agent', AGENT_KEY],
    ['owner', 'owner'],
  ])('place_call runs as %s with that key', async (role, key) => {
    const client = await connect(key === 'owner' ? config.MCP_API_KEY : key);
    await client.callTool({ name: 'place_call', arguments: { contactId: CONTACT_ID, taskDescription: 'Test' } });
    expect(placeCallHandler).toHaveBeenCalledWith(expect.objectContaining({ contactId: CONTACT_ID }), { role });
  });
});

describe('sessionRoleMatches (an SSE session keeps the role it was opened with)', () => {
  it('only the same role may post to a session', () => {
    const sessions = new Map([['s1', { role: 'owner' as const }]]);
    expect(sessionRoleMatches(sessions, 's1', 'owner')).toBe(true);
    expect(sessionRoleMatches(sessions, 's1', 'agent')).toBe(false);
    expect(sessionRoleMatches(sessions, 'nope', 'owner')).toBe(false);
  });
});
