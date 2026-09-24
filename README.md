# CircuitLab

Self-hosted Arduino simulator (Wokwi-style): code editor, circuit diagram, live simulation,
serial monitor — and an MCP server so Claude can build and test circuits directly, no browser
needed. Everything runs server-side in one Docker container.

Not affiliated with or endorsed by Wokwi. `diagram.json` uses the same structure as Wokwi's
for interop (import/export), but no Wokwi UI, docs, or example code was copied — see
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) for the (MIT) libraries actually reused.

## Quickstart

```sh
docker compose up --build
```

Open http://localhost:8080. A default Uno project with a Blink sketch is created automatically.

## Claude / MCP

```sh
claude mcp add --transport http circuitlab http://localhost:8080/mcp
```

Then ask Claude to, e.g., "create a new Uno project, wire an LED to pin 13 with a resistor,
compile it, start the simulation, and confirm the LED blinks by reading the pin." Set
`MCP_TOKEN` in `docker-compose.yml` to require a bearer token on `/mcp` if exposing it beyond
localhost.

## What works today (Phase 1)

- Boards: Arduino Uno, Nano, Mega (avr8js — real ATmega328/2560 emulation, not a mock).
- ~35 parts implemented from datasheets: LEDs, buttons, switches, potentiometers, sensors
  (DHT22, HC-SR04, PIR, LDR, gas/flame/sound, MPU6050), LCD1602/2004 (+ I2C backpack),
  SSD1306 OLED, ILI9341 TFT, 7-segment, NeoPixel/WS2812, servo, stepper, RTC, HX711, IR, relay.
- Compile via `arduino-cli` (baked into the image), run, read/write serial, read pin voltages,
  drive part controls (press a button, turn a knob, set a sensor value), screenshot displays,
  capture a VCD logic trace — all via MCP tools or the plain JSON `/api`.
- Visual diagram editor in the browser: drag parts from the palette onto the canvas, click a pin
  then another pin to wire them, drag to move, select a part/wire for a rotate/delete toolbar.

## What's already covered without dedicated UI

- Library Manager: `libraries.txt` (one Arduino library name per line) is just a project file —
  edit it in the same tab bar as `sketch.ino`, `compile` runs `arduino-cli lib install` for each
  line before building. No separate "Library Manager" panel needed.

## Not yet built

- RP2040 / ESP32 / STM32 boards. ESP32/STM32 need a QEMU/Renode subprocess bridge (see the plan).
  RP2040 (`rp2040js`) runs in-process like AVR, but the only `@wokwi/elements`-renderable RP2040
  board (Nano RP2040 Connect) defaults `Serial` to USB-CDC, not UART — bridging that plus the
  `arduino-pico` core's multicore boot handshake is real, unverified-here work; see
  [docs/arc42/architektur.md](./docs/arc42/architektur.md) section 11.
- Scenario runner (YAML test steps, e.g. for CI regression checks).

## Architecture

```
src/sim/      Netlist (union-find over wires/switches/resistors) + per-board backends (avr.ts)
src/parts/    One factory per part, behavior implemented from datasheets
src/server/   store (project files on disk), build (arduino-cli), core (session manager),
              api (JSON REST for the web UI), mcp (MCP tools), ws (live state/serial), index
src/web/      Monaco editor + @wokwi/elements web components, built with Vite
```

## Development

```sh
npm install
npm run dev      # vite build --watch + tsx watch src/server/index.ts
npm test
npm run typecheck
```

`arduino-cli` must be installed locally (with the `arduino:avr` core) for `compile`/
`start_simulation` to work outside Docker; everything else (parts, netlist, the web UI) works
without it.
