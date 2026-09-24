import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { handleApi } from './api.ts';
import { handleUpgrade } from './ws.ts';
import { createMcpServer } from './mcp.ts';

const PORT = Number(process.env.PORT ?? 8080);
const WEB_DIR = path.join(import.meta.dirname, '..', '..', 'dist', 'web');
const MCP_TOKEN = process.env.MCP_TOKEN;

// One MCP server+transport pair per client session (Claude Code reconnecting after a restart
// needs a fresh session, not "already initialized" forever).
const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const sid = req.headers['mcp-session-id'];
  let transport = typeof sid === 'string' ? mcpSessions.get(sid) : undefined;
  if (!transport) {
    if (sid) { res.writeHead(404).end('Unknown MCP session'); return; }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { mcpSessions.set(id, transport!); },
      onsessionclosed: (id) => { mcpSessions.delete(id); },
    });
    await createMcpServer().connect(transport);
  }
  await transport.handleRequest(req, res);
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

async function serveStatic(url: URL, res: import('node:http').ServerResponse) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(WEB_DIR, rel);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback for client-side routes
    try {
      const data = await readFile(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found. Run `npm run build` first.');
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/mcp') {
    if (MCP_TOKEN && req.headers.authorization !== `Bearer ${MCP_TOKEN}`) { res.writeHead(401).end('Unauthorized'); return; }
    handleMcp(req, res).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500).end('MCP error'); });
    return;
  }

  handleApi(req, res, url).then((handled) => { if (!handled) return serveStatic(url, res); })
    .catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500).end('Internal error'); });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/ws/')) handleUpgrade(req, socket, head, url);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`CircuitLab running on http://localhost:${PORT}  (MCP: http://localhost:${PORT}/mcp)`);
});
