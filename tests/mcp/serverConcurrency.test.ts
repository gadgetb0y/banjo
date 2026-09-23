import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { registerMcpRoutes } from '../../src/mcp/server.js';

// #31. registerMcpRoutes built ONE McpServer per process and connected every
// SSE client to it, so the second concurrent client got a 500 ("Already
// connected to a transport"). Found 2026-09-22 when a script couldn't reach
// Banjo because a Claude Code session already held the connection. The route
// writes to the raw Node response, which Hono's in-memory app.request() can't
// provide, so this runs a real server on an ephemeral port.

type Server = ReturnType<typeof serve>;
let server: Server | undefined;
const open: AbortController[] = [];

afterEach(async () => {
  for (const ac of open.splice(0)) ac.abort();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(): Promise<number> {
  const app = new Hono();
  registerMcpRoutes(app);
  return new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });
}

/** Opens an SSE session and resolves with its status and, on success, the sessionId from the endpoint event. */
async function connect(port: number): Promise<{ status: number; sessionId?: string; ac: AbortController }> {
  const ac = new AbortController();
  open.push(ac);
  const res = await fetch(`http://127.0.0.1:${port}/mcp/sse`, {
    headers: { Authorization: `Bearer ${config.MCP_API_KEY}`, Accept: 'text/event-stream' },
    signal: ac.signal,
  });
  if (res.status !== 200 || !res.body) return { status: res.status, ac };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!buf.includes('event: endpoint')) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  const sessionId = buf.match(/sessionId=([\w-]+)/)?.[1];
  return { status: res.status, sessionId, ac };
}

describe('mcp server: concurrent clients', () => {
  it('serves two clients at the same time, each with its own session', async () => {
    const port = await start();

    const first = await connect(port);
    const second = await connect(port);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.sessionId).toBeTruthy();
    expect(second.sessionId).toBeTruthy();
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('still accepts a new client after an earlier one disconnects', async () => {
    const port = await start();

    const first = await connect(port);
    first.ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    const next = await connect(port);

    expect(next.status).toBe(200);
    expect(next.sessionId).toBeTruthy();
  });
});
