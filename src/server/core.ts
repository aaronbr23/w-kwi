// Business logic shared by the HTTP API and the MCP tools: one Session per running project.
import * as store from './store.ts';
import { compile as runCompile, lastHex } from './build.ts';
import { Session, type LogicSample } from '../sim/session.ts';
import { CATALOG } from '../parts/catalog.ts';
import { BOARD_TYPES } from '../sim/boards/index.ts';
import type { Diagram, Connection } from '../sim/types.ts';

const sessions = new Map<string, Session>();
/** Called right after a simulation starts, e.g. so ws.ts can wire up state/serial broadcast. */
export const onSessionStart: ((id: string, session: Session) => void)[] = [];

export function listPartTypes(): string[] {
  return [...BOARD_TYPES, ...Object.keys(CATALOG)].sort();
}

async function boardType(id: string, diagram?: Diagram): Promise<string> {
  const d = diagram ?? (await store.getDiagram(id));
  const t = d.parts.find((p) => p.id === 'board')?.type;
  if (!t) throw new Error(`Project "${id}" has no part with id "board"`);
  return t;
}

export async function compileProject(id: string) {
  return runCompile(id, await boardType(id));
}

export async function startSimulation(id: string) {
  if (sessions.has(id)) return sessions.get(id)!;
  const diagram = await store.getDiagram(id);
  const type = await boardType(id, diagram);
  let hex = await lastHex(id);
  if (!hex) {
    const r = await runCompile(id, type);
    if (!r.ok) throw new Error(`Compile failed:\n${r.output}`);
    hex = r.hex!;
  }
  const session = new Session(diagram, 'board', { kind: 'hex', data: hex });
  sessions.set(id, session);
  session.start();
  for (const fn of onSessionStart) fn(id, session);
  return session;
}

export function stopSimulation(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  s.destroy();
  sessions.delete(id);
}

export function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`Project "${id}" has no running simulation. Call start_simulation first.`);
  return s;
}

export function isRunning(id: string): boolean { return sessions.has(id); }

export async function addPart(id: string, part: { type: string; id: string; top?: number; left?: number; rotate?: number; attrs?: Record<string, string> }) {
  if (!CATALOG[part.type] && !BOARD_TYPES.includes(part.type)) throw new Error(`Unknown part type "${part.type}". Use list_parts.`);
  const d = await store.getDiagram(id);
  if (d.parts.some((p) => p.id === part.id)) throw new Error(`Part id "${part.id}" already exists`);
  d.parts.push({ top: 0, left: 0, attrs: {}, ...part });
  await store.setDiagram(id, d);
}

export async function removePart(id: string, partId: string) {
  if (partId === 'board') throw new Error('Cannot remove the board part');
  const d = await store.getDiagram(id);
  d.parts = d.parts.filter((p) => p.id !== partId);
  d.connections = d.connections.filter(([a, b]) => !a.startsWith(partId + ':') && !b.startsWith(partId + ':'));
  await store.setDiagram(id, d);
}

export async function movePart(id: string, partId: string, patch: { top?: number; left?: number; rotate?: number }) {
  const d = await store.getDiagram(id);
  const part = d.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`Unknown part "${partId}"`);
  if (patch.top !== undefined) part.top = patch.top;
  if (patch.left !== undefined) part.left = patch.left;
  if (patch.rotate !== undefined) part.rotate = patch.rotate;
  await store.setDiagram(id, d);
}

export async function connect(id: string, from: string, to: string, color = 'black') {
  const d = await store.getDiagram(id);
  d.connections.push([from, to, color] as Connection);
  await store.setDiagram(id, d);
}

export async function disconnect(id: string, from: string, to: string) {
  const d = await store.getDiagram(id);
  d.connections = d.connections.filter(([a, b]) => !(a === from && b === to) && !(a === to && b === from));
  await store.setDiagram(id, d);
}

export async function setPartAttr(id: string, partId: string, name: string, value: string) {
  const d = await store.getDiagram(id);
  const part = d.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`Unknown part "${partId}"`);
  part.attrs = { ...part.attrs, [name]: value };
  await store.setDiagram(id, d);
}

export { store, type LogicSample };
