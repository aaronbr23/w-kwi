// Minimal JSON REST API for the web UI. No framework: a handful of routes, plain node:http.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as core from './core.ts';
import { runScenario } from './scenario.ts';
import { unzip } from './zip.ts';

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(contentType === 'application/json' ? JSON.stringify(data) : data);
}

/** Returns true if it handled the request (path started with /api/). */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;
  const parts = url.pathname.slice(5).split('/').filter(Boolean); // e.g. ["projects", "abc", "diagram"]
  const method = req.method ?? 'GET';
  try {
    if (parts[0] === 'parts' && parts.length === 1 && method === 'GET') return ok(res, core.listPartTypes());

    if (parts[0] === 'projects' && parts.length === 1) {
      if (method === 'GET') return ok(res, await core.store.listProjects());
      if (method === 'POST') { const b = await body(req) as { board: string }; return ok(res, { id: await core.store.createProject(b.board) }); }
    }

    if (parts[0] === 'projects' && parts.length === 2) {
      const id = parts[1];
      if (id === 'import' && method === 'POST') {
        const b = await body(req) as { files?: Record<string, string>; zip?: string };
        const files = b.zip ? unzip(Buffer.from(b.zip, 'base64')) : (b.files ?? {});
        return ok(res, await core.importProject(files));
      }
      if (method === 'DELETE') { core.stopSimulation(id); await core.store.deleteProject(id); return ok(res, { ok: true }); }
    }

    if (parts[0] === 'projects' && parts.length === 3) {
      const [, id, action] = parts;
      if (action === 'files' && method === 'GET') return ok(res, await core.store.listFiles(id));
      if (action === 'file') {
        const name = url.searchParams.get('name') ?? '';
        if (method === 'GET') return ok(res, { content: await core.store.readFile(id, name) });
        if (method === 'PUT') { const b = await body(req) as { content: string }; await core.store.writeFile(id, name, b.content); return ok(res, { ok: true }); }
        if (method === 'DELETE') { await core.store.deleteFile(id, name); return ok(res, { ok: true }); }
      }
      if (action === 'diagram') {
        if (method === 'GET') return ok(res, await core.store.getDiagram(id));
        if (method === 'PUT') { await core.store.setDiagram(id, await body(req) as never); return ok(res, { ok: true }); }
      }
      if (action === 'board' && method === 'PATCH') { const b = await body(req) as { board: string }; await core.setBoard(id, b.board); return ok(res, { ok: true }); }
      if (action === 'compile' && method === 'POST') return ok(res, await core.compileProject(id));
      if (action === 'scenario' && method === 'POST') { const b = await body(req) as { yaml: string }; return ok(res, await runScenario(id, b.yaml)); }
      if (action === 'start' && method === 'POST') { await core.startSimulation(id); return ok(res, { ok: true }); }
      if (action === 'stop' && method === 'POST') { core.stopSimulation(id); return ok(res, { ok: true }); }
      if (action === 'state' && method === 'GET') return ok(res, core.getSession(id).state());
      if (action === 'serial') {
        if (method === 'GET') { const [data, next] = core.getSession(id).readSerial(Number(url.searchParams.get('since') ?? 0)); return ok(res, { text: Buffer.from(data).toString('utf8'), next }); }
        if (method === 'POST') { const b = await body(req) as { text: string }; core.getSession(id).writeSerial(new TextEncoder().encode(b.text)); return ok(res, { ok: true }); }
      }
      if (action === 'pin' && method === 'GET') { const v = core.getSession(id).readPin(url.searchParams.get('pin') ?? ''); return ok(res, { volts: v }); }
      if (action === 'control' && method === 'POST') { const b = await body(req) as { partId: string; name: string; value: number }; core.getSession(id).control(b.partId, b.name, b.value); return ok(res, { ok: true }); }
      if (action === 'screenshot' && method === 'GET') { send(res, 200, core.getSession(id).screenshot(url.searchParams.get('partId') ?? ''), 'image/png'); return true; }
      if (action === 'parts') {
        if (method === 'POST') { const b = await body(req) as { type: string; id: string; top?: number; left?: number; rotate?: number; attrs?: Record<string, string> }; await core.addPart(id, b); return ok(res, { ok: true }); }
      }
      if (action === 'connections') {
        // Bug fix: this used to be gated on parts.length === 4 alongside the parts/:id routes
        // below, but "/api/projects/:id/connections" only ever has 3 segments, so POST here
        // (the wire-two-pins endpoint) was unreachable - a 404 on every "connect" call.
        if (method === 'POST') { const b = await body(req) as { from: string; to: string; color?: string }; await core.connect(id, b.from, b.to, b.color); return ok(res, { ok: true }); }
        if (method === 'DELETE') { const b = await body(req) as { from: string; to: string }; await core.disconnect(id, b.from, b.to); return ok(res, { ok: true }); }
      }
    }

    if (parts[0] === 'projects' && parts.length === 4 && parts[2] === 'parts' && method === 'DELETE') { await core.removePart(parts[1], parts[3]); return ok(res, { ok: true }); }
    if (parts[0] === 'projects' && parts.length === 4 && parts[2] === 'parts' && method === 'PATCH') { const b = await body(req) as { top?: number; left?: number; rotate?: number }; await core.movePart(parts[1], parts[3], b); return ok(res, { ok: true }); }

    send(res, 404, { error: `No route for ${method} ${url.pathname}` });
    return true;
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    return true;
  }
}

function ok(res: ServerResponse, data: unknown): true { send(res, 200, data); return true; }
