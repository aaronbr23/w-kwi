// Compiles a project's sketch.ino via arduino-cli (installed in the Docker image, see Dockerfile).
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { FQBN } from '../sim/boards/index.ts';
import { projectDir } from './store.ts';

const run = promisify(execFile);

export interface CompileResult { ok: boolean; hex?: Uint8Array; output: string }

export async function compile(id: string, board: string): Promise<CompileResult> {
  const fqbn = FQBN[board];
  if (!fqbn) throw new Error(`Unknown board type "${board}"`);
  const dir = projectDir(id);
  const libsFile = path.join(dir, 'libraries.txt');
  const libs = (await fs.readFile(libsFile, 'utf8').catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const lib of libs) {
    await run('arduino-cli', ['lib', 'install', lib]).catch((e) => { throw new Error(`Failed to install library "${lib}": ${e.stderr || e.message}`); });
  }
  const outDir = path.join(dir, 'build');
  try {
    const { stdout } = await run('arduino-cli', ['compile', '--fqbn', fqbn, '--output-dir', outDir, dir]);
    const hexFile = (await fs.readdir(outDir)).find((f) => f.endsWith('.hex'));
    if (!hexFile) return { ok: false, output: stdout + '\n(no .hex produced)' };
    const hex = await fs.readFile(path.join(outDir, hexFile));
    return { ok: true, hex: new Uint8Array(hex.buffer, hex.byteOffset, hex.byteLength), output: stdout };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (err.stdout || '') + (err.stderr || err.message) };
  }
}

export async function lastHex(id: string): Promise<Uint8Array | undefined> {
  const outDir = path.join(projectDir(id), 'build');
  const hexFile = (await fs.readdir(outDir).catch(() => [] as string[])).find((f) => f.endsWith('.hex'));
  if (!hexFile) return undefined;
  const hex = await fs.readFile(path.join(outDir, hexFile));
  return new Uint8Array(hex.buffer, hex.byteOffset, hex.byteLength);
}
