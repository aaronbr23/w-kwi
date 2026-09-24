// Maps diagram part "type" strings (same names @wokwi/elements uses) to part factories.
// Board types (wokwi-arduino-*, …) are not here: sim/boards/index.ts handles those.
import type { PartFactory } from '../sim/types.ts';
import * as basic from './basic.ts';
import * as timing from './timing.ts';
import * as displays from './displays.ts';
import * as i2c from './i2c.ts';

export const CATALOG: Record<string, PartFactory> = {
  'wokwi-led': basic.led,
  'wokwi-rgb-led': basic.rgbLed,
  'wokwi-resistor': basic.resistor,
  'wokwi-pushbutton': basic.pushbutton,
  'wokwi-pushbutton-6mm': basic.pushbutton,
  'wokwi-slide-switch': basic.slideSwitch,
  'wokwi-tilt-switch': basic.tiltSwitch,
  'wokwi-dip-switch-8': basic.dipSwitch8,
  'wokwi-potentiometer': basic.potentiometer,
  'wokwi-slide-potentiometer': basic.slidePotentiometer,
  'wokwi-analog-joystick': basic.joystick,
  'wokwi-photoresistor-sensor': basic.photoresistor,
  'wokwi-ntc-temperature-sensor': basic.ntc,
  'wokwi-gas-sensor': basic.gasSensor,
  'wokwi-flame-sensor': basic.flameSensor,
  'wokwi-small-sound-sensor': basic.soundSensor,
  'wokwi-big-sound-sensor': basic.soundSensor,
  'wokwi-heart-beat-sensor': basic.heartBeat,
  'wokwi-pir-motion-sensor': basic.pir,
  'wokwi-buzzer': basic.buzzer,
  'wokwi-7segment': basic.sevenSegment,
  'wokwi-led-bar-graph': basic.ledBarGraph,
  'wokwi-membrane-keypad': basic.keypad,
  'wokwi-ky-040': basic.rotaryEncoder,
  'wokwi-biaxial-stepper': basic.stepper,
  'wokwi-stepper-motor': basic.stepper,
  'wokwi-servo': timing.servo,
  'wokwi-dht22': timing.dht22,
  'wokwi-hc-sr04': timing.hcsr04,
  'wokwi-neopixel': timing.neopixel,
  'wokwi-neopixel-matrix': timing.neopixelMatrix,
  'wokwi-led-ring': timing.ledRing,
  'wokwi-hx711': timing.hx711,
  'wokwi-ir-receiver': timing.irReceiver,
  'wokwi-lcd1602': displays.lcd1602,
  'wokwi-lcd2004': displays.lcd2004,
  'wokwi-ssd1306': displays.ssd1306,
  'wokwi-ili9341': displays.ili9341,
  'wokwi-ds1307': i2c.ds1307,
  'wokwi-mpu6050': i2c.mpu6050,
};
