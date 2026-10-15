/**
 * Who is calling Banjo's MCP tools: the owner (MCP_API_KEY) or an always-on
 * agent (MCP_AGENT_API_KEY), from the bearer key alone (mcp/server.ts's
 * requireAuth). Never from anything the caller says.
 */
export type McpRole = 'owner' | 'agent';
