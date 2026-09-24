// Live view for the web UI: part state (~20Hz) and serial output, pushed over WebSocket per project.
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as core from './core.ts';

const wss = new WebSocketServer({ noServer: true });
const clientsByProject = new Map<string, Set<WebSocket>>();

core.onSessionStart.push((id, session) => {
  session.onState = (states) => broadcast(id, { type: 'state', states });
  session.onSerial = (data) => broadcast(id, { type: 'serial', text: Buffer.from(data).toString('utf8') });
});

function broadcast(id: string, msg: unknown) {
  const clients = clientsByProject.get(id);
  if (!clients) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
  const m = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
  if (!m) { socket.destroy(); return; }
  const id = m[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    let set = clientsByProject.get(id);
    if (!set) clientsByProject.set(id, (set = new Set()));
    set.add(ws);
    ws.on('close', () => set!.delete(ws));
  });
}
