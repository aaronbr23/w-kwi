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

export async function setBoard(id: string, board: string) {
  if (!BOARD_TYPES.includes(board)) throw new Error(`Unknown board type "${board}". Known: ${BOARD_TYPES.join(', ')}`);
  stopSimulation(id); // old compiled hex/session was built for the previous MCU
  const d = await store.getDiagram(id);
  const part = d.parts.find((p) => p.id === 'board');
  if (!part) throw new Error(`Project "${id}" has no part with id "board"`);
  part.type = board;
  await store.setDiagram(id, d);
}

export async function setPartAttr(id: string, partId: string, name: string, value: string) {
  const d = await store.getDiagram(id);
  const part = d.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`Unknown part "${partId}"`);
  part.attrs = { ...part.attrs, [name]: value };
  await store.setDiagram(id, d);
}

/** Zip exports commonly wrap everything in one top-level folder (e.g. "myproject/sketch.ino",
 *  "myproject/diagram.json"). Strip a single common folder prefix so diagram.json/libraries.txt/
 *  *.ino still land at the paths the rest of importProject looks for. No-op if there's no single
 *  shared folder (e.g. files already flat, or a genuine multi-root upload). */
function stripCommonPrefix(files: Record<string, string>): Record<string, string> {
  const names = Object.keys(files);
  const slash = names[0]?.indexOf('/') ?? -1;
  if (slash < 0) return files;
  const prefix = names[0].slice(0, slash + 1);
  if (!names.every((n) => n.startsWith(prefix))) return files;
  return Object.fromEntries(names.map((n) => [n.slice(prefix.length), files[n]]));
}

// Real Wokwi diagram.json files don't necessarily name the board part "board" (any id is legal,
// e.g. "esp", "uno1") - but every other part of this codebase assumes id === 'board'. Recognize a
// board-ish part by its type instead, for import only.
// Not anchored to a "wokwi-" prefix: real exports also use e.g. "board-esp32-devkit-c-v4" (verified
// against a real diagram.json) - match an MCU family keyword anywhere in the type string instead.
// Checked against every CATALOG part type string (basic/timing/displays/i2c parts, plus
// board-mfrc522) to confirm none of them contain one of these keywords and would false-positive.
const BOARD_TYPE_RE = /arduino|esp32|esp8266|rp2040|rpi-pico|stm32/i;

function rewriteEndpoint(ep: string, oldId: string, newId: string): string {
  return ep === oldId || ep.startsWith(oldId + ':') ? newId + ep.slice(oldId.length) : ep;
}

/** Normalizes an imported diagram so the rest of the app's id==='board' assumption holds:
 *  finds the board-ish part (by type, any id), renames it to 'board' and rewrites connections
 *  to match, swapping in a supported fallback type (Uno) if the original board isn't simulatable
 *  here (e.g. ESP32). Inserts a fresh Uno board if the diagram has no board-ish part at all. */
function normalizeImportedDiagram(d: Diagram): { diagram: Diagram; warnings: string[] } {
  const warnings: string[] = [];
  const boardPart = d.parts.find((p) => BOARD_TYPE_RE.test(p.type));
  if (!boardPart) {
    console.log('importProject: no board-like part found in uploaded diagram.json, inserting a default Uno');
    warnings.push('No board found in the imported diagram.json - inserted a default Uno.');
    return { diagram: { ...d, parts: [{ type: 'wokwi-arduino-uno', id: 'board', top: 0, left: 0, attrs: {} }, ...d.parts] }, warnings };
  }
  const oldId = boardPart.id;
  if (!BOARD_TYPES.includes(boardPart.type)) {
    console.log(`importProject: board type "${boardPart.type}" isn't supported here, swapping to wokwi-arduino-uno (wiring to it will need adjusting)`);
    warnings.push(`Board type "${boardPart.type}" isn't supported yet, wiring for board pins will not display correctly (swapped to Uno for now).`);
    boardPart.type = 'wokwi-arduino-uno';
  }
  if (oldId === 'board') return { diagram: d, warnings };
  boardPart.id = 'board';
  return { diagram: { ...d, connections: d.connections.map(([a, b, ...rest]) => [rewriteEndpoint(a, oldId, 'board'), rewriteEndpoint(b, oldId, 'board'), ...rest] as Diagram['connections'][number]) }, warnings };
}

/** Import a project from an uploaded file set (see api.ts POST /projects/import for the shape).
 *  Board comes from the uploaded diagram.json if present and valid, else defaults to an Uno. */
export async function importProject(rawFiles: Record<string, string>): Promise<{ id: string; warnings: string[] }> {
  const files = stripCommonPrefix(rawFiles);
  let normalizedDiagram: Diagram | undefined;
  let warnings: string[] = [];
  const diagramRaw = files['diagram.json'];
  if (diagramRaw !== undefined) {
    try { ({ diagram: normalizedDiagram, warnings } = normalizeImportedDiagram(JSON.parse(diagramRaw) as Diagram)); }
    catch {
      console.log('importProject: diagram.json in upload is not valid JSON, ignoring it and starting from a default diagram');
      warnings = ['diagram.json in the upload is not valid JSON - ignored it and started a blank default project.'];
    }
  }
  const id = await store.createProject(normalizedDiagram?.parts.find((p) => p.id === 'board')?.type ?? 'wokwi-arduino-uno');
  if (normalizedDiagram) await store.setDiagram(id, normalizedDiagram);
  for (const [name, content] of Object.entries(files)) {
    if (name === 'diagram.json' || name === 'libraries.txt') { if (name === 'libraries.txt') await store.writeFile(id, name, content); continue; }
    if (!name.includes('/') && name.endsWith('.ino')) { await store.writeFile(id, store.SKETCH_MAIN, content); continue; }
    await store.writeFile(id, name.startsWith('sketch/') ? name : `sketch/${name}`, content);
  }
  return { id, warnings };
}

export { store, type LogicSample };
