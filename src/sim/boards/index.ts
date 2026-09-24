import type { Board, Firmware } from '../types.ts';
import { AVRBoard, AVR_VARIANTS } from './avr.ts';

/** FQBN for arduino-cli compile, per board type. */
export const FQBN: Record<string, string> = {
  'wokwi-arduino-uno': 'arduino:avr:uno',
  'wokwi-arduino-nano': 'arduino:avr:nano',
  'wokwi-arduino-mega': 'arduino:avr:mega',
};

export const BOARD_TYPES = Object.keys(FQBN);

export function createBoard(type: string, id: string, fw: Firmware): Board {
  if (type in AVR_VARIANTS) return new AVRBoard(id, type, fw);
  // ponytail: rp2040/esp32/stm32 backends not implemented yet, see plan phases 3-5
  throw new Error(`Board type "${type}" not supported yet (planned: rp2040, esp32, stm32)`);
}
