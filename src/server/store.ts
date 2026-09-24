// Project storage on disk: /data/projects/<id>/{sketch/sketch.ino, diagram.json, libraries.txt}
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Diagram } from '../sim/types.ts';
import { BOARD_TYPES } from '../sim/boards/index.ts';

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

function dir(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid project id "${id}"`);
  return path.join(PROJECTS_DIR, id);
}

const BLINK_INO = `void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  Serial.println("on");\n  delay(500);\n  digitalWrite(LED_BUILTIN, LOW);\n  Serial.println("off");\n  delay(500);\n}\n`;

function defaultDiagram(board: string): Diagram {
  return { version: 1, author: 'circuitlab', editor: 'circuitlab', parts: [{ type: board, id: 'board', top: 0, left: 0, attrs: {} }], connections: [] };
}

export interface ProjectInfo { id: string; board: string; name: string }

export async function listProjects(): Promise<ProjectInfo[]> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const ids = await fs.readdir(PROJECTS_DIR).catch(() => []);
  const out: ProjectInfo[] = [];
  for (const id of ids) {
    try { out.push({ id, board: (await getDiagram(id)).parts.find((p) => p.id === 'board')?.type ?? '?', name: id }); }
    catch { /* skip broken project dirs */ }
  }
  return out;
}

// arduino-cli requires the main .ino to be named after its containing folder, so the sketch
// lives in its own "sketch/" subfolder while diagram.json/libraries.txt sit at the project root.
export const SKETCH_MAIN = 'sketch/sketch.ino';

export async function createProject(board: string, id = randomUUID()): Promise<string> {
  if (!BOARD_TYPES.includes(board)) throw new Error(`Unknown board type "${board}". Known: ${BOARD_TYPES.join(', ')}`);
  const d = dir(id);
  await fs.mkdir(path.join(d, 'sketch'), { recursive: true });
  await fs.writeFile(path.join(d, SKETCH_MAIN), BLINK_INO);
  await fs.writeFile(path.join(d, 'diagram.json'), JSON.stringify(defaultDiagram(board), null, 2));
  await fs.writeFile(path.join(d, 'libraries.txt'), '');
  return id;
}

export async function deleteProject(id: string) {
  await fs.rm(dir(id), { recursive: true, force: true });
}

export function filePath(id: string, name: string): string {
  const base = dir(id);
  const p = path.join(base, name);
  // path.join() already collapses "..", so this actually rejects anything that escapes the
  // project dir (the previous check compared p against itself and could never throw).
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Invalid file path');
  return p;
}

export async function listFiles(id: string): Promise<string[]> {
  const base = dir(id);
  const out: string[] = [];
  async function walk(sub: string) {
    for (const e of await fs.readdir(path.join(base, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name);
      if (e.isDirectory()) await walk(rel); else out.push(rel);
    }
  }
  await walk('.');
  return out.sort();
}

export async function readFile(id: string, name: string): Promise<string> {
  return fs.readFile(filePath(id, name), 'utf8');
}

export async function writeFile(id: string, name: string, content: string) {
  const p = filePath(id, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

export async function deleteFile(id: string, name: string) {
  await fs.rm(filePath(id, name));
}

export async function getDiagram(id: string): Promise<Diagram> {
  return JSON.parse(await readFile(id, 'diagram.json'));
}

export async function setDiagram(id: string, diagram: Diagram) {
  await writeFile(id, 'diagram.json', JSON.stringify(diagram, null, 2));
}

export function projectDir(id: string): string { return dir(id); }
