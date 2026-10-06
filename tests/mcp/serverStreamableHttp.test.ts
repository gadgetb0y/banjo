import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config/index.js';

// list_recent_tasks reads Postgres; the round trip below only needs to prove
// the transport carries a tool call there and back, so stub its handler.
vi.mock('../../src/mcp/tools/listRecentTasks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/tools/listRecentTasks.js')>();
  return { ...actual, listRecentTasksHandler: vi.fn(async () => ({ tasks: [{ id: 'task-1' }] })) };
});

const { registerMcpRoutes } = await import('../../src/mcp/server.js');

// 4.1 (docs/ROADMAP.md). /mcp speaks Streamable HTTP, statelessly: no session
// to lose when the app restarts. The web-standard transport takes a Fetch
// Request and returns a Response, so Hono's in-memory app.request() can drive
// it end to end, unlike the raw-Node SSE routes in serverConcurrency.test.ts.

function buildApp(): Hono {
  const app = new Hono();
  registerMcpRoutes(app);
  return app;
}

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function connect(app: Hono, token = config.MCP_API_KEY): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://banjo.test/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init),
  });
  const client = new Client({ name: 'banjo-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe('mcp server: Streamable HTTP at /mcp', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await buildApp().request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  // #119: stateless, so there's no stream to offer on GET and no session to
  // end on DELETE. A GET that opened a stream and closed it at once made
  // Claude Code reconnect about once a second.
  it.each(['GET', 'DELETE'])('answers %s with 405 and Allow: POST', async (method) => {
    const res = await buildApp().request('/mcp', {
      method,
      headers: { Authorization: `Bearer ${config.MCP_API_KEY}`, Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('still asks for auth on GET before anything else', async () => {
    const res = await buildApp().request('/mcp', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('rejects the wrong bearer token', async () => {
    await expect(connect(buildApp(), 'wrong-token')).rejects.toThrow();
  });

  it('identifies itself as banjo, with the package version', async () => {
    const client = await connect(buildApp());
    const { name, version } = client.getServerVersion() ?? {};
    const pkg = (await import('../../package.json', { with: { type: 'json' } })).default;
    expect(name).toBe('banjo');
    expect(version).toBe(pkg.version);
  });

  it('lists every tool', async () => {
    const client = await connect(buildApp());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_contact',
      'cancel_task',
      'find_contact',
      'get_call_transcript',
      'get_task_status',
      'list_contacts',
      'list_recent_tasks',
      'place_call',
      'record_task_outcome',
      'stop_call',
      'update_contact',
    ]);
  });

  it('marks exactly the read tools read-only, and the call tools as reaching the outside world', async () => {
    // Without annotations, OpenClaw asks for approval before every Banjo
    // call, reads included (found testing it against Banjo, 2026-10-05).
    const client = await connect(buildApp());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));

    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual([
      'find_contact',
      'get_call_transcript',
      'get_task_status',
      'list_contacts',
      'list_recent_tasks',
    ]);
    expect(tools.filter((t) => t.annotations?.openWorldHint).map((t) => t.name).sort()).toEqual(['place_call', 'stop_call']);
    expect(byName.stop_call).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.place_call).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    for (const tool of tools) expect(tool.annotations?.title, tool.name).toBeTruthy();
  });

  it('carries a tool call there and back', async () => {
    const client = await connect(buildApp());
    const result = await client.callTool({ name: 'list_recent_tasks', arguments: {} });
    const [content] = result.content as { type: string; text: string }[];
    expect(JSON.parse(content!.text)).toEqual({ tasks: [{ id: 'task-1' }] });
  });

  it('serves two clients at once', async () => {
    const app = buildApp();
    const first = await connect(app);
    const second = await connect(app);
    await expect(first.listTools()).resolves.toBeTruthy();
    await expect(second.listTools()).resolves.toBeTruthy();
  });

  it('keeps working for a connected client after the server restarts', async () => {
    // Every deploy restarts Banjo, which killed each client's SSE session and
    // left Claude Code needing /mcp. Stateless, a client connected before the
    // restart carries on against the new process without reconnecting.
    let app = buildApp();
    const transport = new StreamableHTTPClientTransport(new URL('http://banjo.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${config.MCP_API_KEY}` } },
      fetch: async (url, init) => app.request(url.toString(), init),
    });
    const client = new Client({ name: 'banjo-test', version: '0.0.0' });
    await client.connect(transport);
    clients.push(client);
    expect(transport.sessionId).toBeUndefined();

    app = buildApp(); // the "restart"
    await expect(client.listTools()).resolves.toBeTruthy();
  });

  it('keeps the legacy SSE routes', async () => {
    const res = await buildApp().request('/mcp/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.MCP_API_KEY}` },
    });
    expect(res.status).toBe(400); // past auth, no SSE session: the old route is still there
  });
});
