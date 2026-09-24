// Scenario runner: scripts a running Session from a YAML test file (delay/wait-serial/write-serial/
// expect-pin/set-control/take-screenshot), for CI-style E2E fixtures (test/scenarios/*.yaml) and the
// run_scenario MCP tool / REST route. Reimplemented from the step-name/parameter list only.
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as core from './core.ts';
import { store } from './core.ts';
import type { Session } from '../sim/session.ts';

export interface ScenarioResult { pass: boolean; log: string[] }

const DEFAULT_WAIT_SERIAL_TIMEOUT_MS = 5000;
const POLL_MS = 20;

type Step = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pinLabel(volts: number): string {
  if (Number.isNaN(volts)) return 'FLOATING';
  return volts > 2.5 ? 'HIGH' : 'LOW';
}

// Matches the digital-high threshold used elsewhere (mcp.ts read_pin, basic.ts LED forward-voltage check).
function pinMatches(volts: number, expected: unknown): boolean {
  if (expected === undefined) return !Number.isNaN(volts);
  if (typeof expected === 'number') return !Number.isNaN(volts) && Math.abs(volts - expected) < 0.1;
  const s = String(expected).toLowerCase();
  if (s === 'high') return volts > 2.5;
  if (s === 'low') return !Number.isNaN(volts) && volts <= 2.5;
  throw new Error(`expect-pin: invalid "value" ${JSON.stringify(expected)} (want "high", "low", a number of volts, or omit it)`);
}

export async function runScenario(id: string, yamlText: string): Promise<ScenarioResult> {
  const doc = (parseYaml(yamlText) ?? {}) as { name?: string; steps?: Step[] };
  const steps = doc.steps ?? [];
  const log: string[] = [];
  if (doc.name) log.push(`# ${doc.name}`);

  // Only stop the simulation at the end if this call is the one that started it.
  const startedHere = !core.isRunning(id);
  let session: Session;
  try {
    session = startedHere ? await core.startSimulation(id) : core.getSession(id);
  } catch (e) {
    log.push(`[start] ${e instanceof Error ? e.message : String(e)} — FAIL`);
    return { pass: false, log };
  }

  // Cumulative decoded serial text plus a "consumed up to here" cursor, so a wait-serial for a
  // substring that already matched earlier (e.g. Blink's repeating "on"/"off") waits for the NEXT
  // occurrence rather than re-matching stale output.
  let serialText = '';
  let serialByteLen = 0;
  let serialMatchFrom = 0;
  const refreshSerial = () => {
    const [bytes, next] = session.readSerial(serialByteLen);
    serialByteLen = next;
    serialText += Buffer.from(bytes).toString('utf8');
  };

  async function runStep(step: Step): Promise<{ ok: boolean; line: string }> {
    if ('delay' in step) {
      const ms = Number(step.delay);
      await sleep(ms);
      return { ok: true, line: `[delay] waited ${ms}ms` };
    }
    if ('wait-serial' in step) {
      const pattern = String(step['wait-serial']);
      const timeout = Number(step.timeout ?? DEFAULT_WAIT_SERIAL_TIMEOUT_MS);
      const start = Date.now();
      for (;;) {
        refreshSerial();
        const idx = serialText.indexOf(pattern, serialMatchFrom);
        if (idx !== -1) {
          serialMatchFrom = idx + pattern.length;
          return { ok: true, line: `[wait-serial] found ${JSON.stringify(pattern)} after ${Date.now() - start}ms` };
        }
        if (Date.now() - start >= timeout) {
          return { ok: false, line: `[wait-serial] timed out after ${timeout}ms waiting for ${JSON.stringify(pattern)} — FAIL` };
        }
        await sleep(POLL_MS);
      }
    }
    if ('write-serial' in step) {
      const data = String(step['write-serial']);
      session.writeSerial(new TextEncoder().encode(data));
      return { ok: true, line: `[write-serial] wrote ${JSON.stringify(data)}` };
    }
    if ('set-control' in step) {
      const { part, control, value } = step['set-control'] as { part: string; control: string; value: number };
      session.control(part, control, value);
      return { ok: true, line: `[set-control] ${part}.${control} = ${value}` };
    }
    if ('expect-pin' in step) {
      // ponytail: no timeout given means one immediate check, not a poll-until-true wait.
      const { pin, value, timeout } = step['expect-pin'] as { pin: string; value?: unknown; timeout?: number };
      const timeoutMs = Number(timeout ?? 0);
      const start = Date.now();
      let volts = session.readPin(pin);
      while (!pinMatches(volts, value) && Date.now() - start < timeoutMs) {
        await sleep(POLL_MS);
        volts = session.readPin(pin);
      }
      const ok = pinMatches(volts, value);
      const wanted = value === undefined ? 'NOT FLOATING' : String(value).toUpperCase();
      return ok
        ? { ok: true, line: `[expect-pin] ${pin} = ${pinLabel(volts)}` }
        : { ok: false, line: `[expect-pin] ${pin} = ${pinLabel(volts)}, expected ${wanted} — FAIL` };
    }
    if ('take-screenshot' in step) {
      const { part, save } = step['take-screenshot'] as { part: string; save: string };
      const png = session.screenshot(part);
      const dest = store.filePath(id, save); // bounds-checked against the project dir
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, png);
      return { ok: true, line: `[take-screenshot] ${part} -> ${save}` };
    }
    return { ok: false, line: `[?] unknown step: ${JSON.stringify(step)} — FAIL` };
  }

  let pass = true;
  try {
    for (const step of steps) {
      const r = await runStep(step);
      log.push(r.line);
      if (!r.ok) { pass = false; break; }
    }
  } finally {
    if (startedHere) core.stopSimulation(id);
  }
  return { pass, log };
}
