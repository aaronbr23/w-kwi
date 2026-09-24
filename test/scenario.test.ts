// End-to-end: runs real scenario fixtures (test/scenarios/*.yaml) through runScenario against a
// freshly-created project. Needs arduino-cli on PATH to compile the sketch (present in the Docker
// image, see Dockerfile; not installed in this dev sandbox), so it skips gracefully without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the store at a scratch dir before importing it (it reads DATA_DIR at module load time),
// so this test never touches the repo's real data/ directory.
process.env.DATA_DIR = path.join(os.tmpdir(), `circuitlab-scenario-test-${process.pid}`);

const { runScenario } = await import('../src/server/scenario.ts');
const core = await import('../src/server/core.ts');

function haveArduinoCli(): boolean {
  try { execFileSync('which', ['arduino-cli'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const skip = haveArduinoCli() ? false : 'arduino-cli not on PATH (needed to compile the sketch) — run inside the Docker image to exercise this test';

test.after(() => fs.rm(process.env.DATA_DIR!, { recursive: true, force: true }));

test('run_scenario: blink.yaml passes against the default Blink sketch', { skip }, async () => {
  const id = await core.store.createProject('wokwi-arduino-uno');
  const yaml = await fs.readFile(new URL('./scenarios/blink.yaml', import.meta.url), 'utf8');
  const result = await runScenario(id, yaml);
  assert.equal(result.pass, true, result.log.join('\n'));
  assert.equal(core.isRunning(id), false); // scenario stopped what it started
});

test('run_scenario: button-led.yaml drives an LED through a wired pushbutton', { skip }, async () => {
  const id = await core.store.createProject('wokwi-arduino-uno');
  await core.addPart(id, { type: 'wokwi-pushbutton', id: 'btn1' });
  await core.addPart(id, { type: 'wokwi-led', id: 'led1' });
  await core.addPart(id, { type: 'wokwi-resistor', id: 'r1' });
  await core.connect(id, 'board:5V', 'btn1:1');
  await core.connect(id, 'btn1:2', 'led1:A');
  await core.connect(id, 'led1:A', 'r1:1');
  await core.connect(id, 'r1:2', 'board:GND');
  await core.connect(id, 'led1:C', 'board:GND');
  const yaml = await fs.readFile(new URL('./scenarios/button-led.yaml', import.meta.url), 'utf8');
  const result = await runScenario(id, yaml);
  assert.equal(result.pass, true, result.log.join('\n'));
});
