// Regression test for a real Wokwi project export (Downloads/smarthome/diagram.json, copied
// verbatim into test/fixtures/) that exposed three separate bugs when imported:
//  - board-esp32-devkit-c-v4 (no "wokwi-" prefix) wasn't recognized as a board part at all.
//  - wokwi-breadboard / dot-suffixed rail pins (bb1:tp.1 .. bb1:tp.50) weren't in the catalog.
//  - wokwi-text annotation labels rendered as "unknown part" placeholders showing the type string.
// DATA_DIR must be overridden to an isolated temp dir *before* store.ts (a transitive import of
// core.ts) is loaded, since it reads process.env.DATA_DIR once at module-evaluation time - hence
// the dynamic imports below instead of static ones.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(path.join(tmpdir(), 'circuitlab-import-test-'));
process.env.DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const core = await import('../src/server/core.ts');
const { key } = await import('../src/sim/netlist.ts');
const { CATALOG } = await import('../src/parts/catalog.ts');
const { BOARD_TYPES } = await import('../src/sim/boards/index.ts');
import type { Diagram } from '../src/sim/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(__dirname, 'fixtures/smarthome-diagram.json'), 'utf8');

test('importing a real Wokwi export normalizes the board and preserves everything else', async () => {
  const { id, warnings } = await core.importProject({ 'diagram.json': fixture });
  const diagram: Diagram = await core.store.getDiagram(id);

  // board-esp32-devkit-c-v4 (id "esp") was recognized as a board-ish part (BOARD_TYPE_RE fix),
  // renamed to id "board", and swapped to a type this app can actually simulate.
  const board = diagram.parts.find((p) => p.id === 'board');
  assert.ok(board, 'no part with id "board" after import');
  assert.ok(BOARD_TYPES.includes(board!.type), `swapped board type "${board!.type}" should be a supported board`);
  assert.equal(diagram.parts.some((p) => p.id === 'esp'), false); // old id gone, renamed to "board"

  // The unsupported-board swap is surfaced to the user, not just console.log'd server-side.
  assert.ok(warnings.some((w) => w.includes('board-esp32-devkit-c-v4')), 'expected a warning about the unsupported board type swap');

  // Connections that referenced the old board id "esp:..." were rewritten to "board:...".
  const espRefs = diagram.connections.flatMap(([a, b]) => [a, b]).filter((e) => e.startsWith('esp:'));
  assert.deepEqual(espRefs, []);
  assert.ok(diagram.connections.some(([a, b]) => a.startsWith('board:') || b.startsWith('board:')));

  // wokwi-breadboard is in the catalog and its part survived import untouched (not board-ish).
  const bb = diagram.parts.find((p) => p.id === 'bb1');
  assert.equal(bb?.type, 'wokwi-breadboard');
  assert.ok(CATALOG['wokwi-breadboard']);

  // The breadboard's rail connections (bb1:tp.1, bb1:tp.35, bb1:tp.49, bb1:tp.50) all resolve to
  // the SAME net key - i.e. they're really one shared top-positive-rail net, not four dead ends.
  const tpEndpoints = diagram.connections.flatMap(([a, b]) => [a, b]).filter((e) => e.startsWith('bb1:tp.'));
  assert.ok(tpEndpoints.length >= 4, 'expected at least 4 bb1:tp.* endpoints in the fixture');
  assert.equal(new Set(tpEndpoints.map(key)).size, 1);

  // wokwi-text parts are preserved as-is - normalizeImportedDiagram doesn't touch non-board parts -
  // and their actual label text (not the "wokwi-text" type string) is what main.ts must render.
  const text1 = diagram.parts.find((p) => p.id === 'text1');
  assert.equal(text1?.type, 'wokwi-text');
  assert.equal(text1?.attrs?.text, 'Feuchtigkeitssensor');
  assert.ok(CATALOG['wokwi-text']);

  // board-mfrc522 (no simulated model) is left in the diagram untouched - it's fine for this to
  // stay an "unknown part" placeholder, it must just not break import of everything else.
  const rfid = diagram.parts.find((p) => p.id === 'rfid1');
  assert.equal(rfid?.type, 'board-mfrc522');
  assert.equal(CATALOG['board-mfrc522'], undefined);

  // Every OTHER part type in this diagram has a real simulated factory (nothing silently dropped).
  for (const p of diagram.parts) {
    if (p.id === 'board' || p.id === 'rfid1') continue;
    assert.ok(CATALOG[p.type], `no CATALOG factory for part "${p.id}" (${p.type})`);
  }

  // Pushbuttons wired via their real pin names (1.l/2.l) still resolve their two legs to two
  // distinct net keys (they're on either side of the switch, not accidentally shorted together).
  const btnConns = diagram.connections.filter(([a, b]) => a.startsWith('btn1:') || b.startsWith('btn1:'));
  assert.equal(btnConns.length, 2);
  const btnKeys = new Set(btnConns.flatMap(([a, b]) => [a, b]).filter((e) => e.startsWith('btn1:')).map(key));
  assert.equal(btnKeys.size, 2); // "btn1:1" and "btn1:2" - two distinct legs, not merged into one
});
