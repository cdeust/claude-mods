import { expect, test } from 'claude-code/testing'

import { Bitmap, CELL_H, CELL_W, MAX_BYTES, MAX_SIDE } from './bitmap'
import { INSIGHTS, PHASES } from './fixture'
import { CRITICAL, INK, phaseColor, rgb } from './palette'
import { curvePicture, lanesPicture } from './pixels'
import { sceneOf } from './scene'

const scene = sceneOf(PHASES, INSIGHTS, 100_000)
const has = (bytes: Uint8Array, color: number) => {
  const [r, g, b] = rgb(color)
  for (let i = 0; i < bytes.length; i += 4) if (bytes[i] === r && bytes[i + 1] === g && bytes[i + 2] === b) return true
  return false
}

test('the lanes picture holds every phase colour, the failed-call x and the advisor diamond', () => {
  const bmp = lanesPicture(scene, 100)
  expect([bmp.width, bmp.height]).toEqual([100 * CELL_W, 3 * 2 * CELL_H])
  for (const phase of ['analysis', 'implementation', 'test', 'review'] as const) expect(has(bmp.bytes, phaseColor(phase))).toBe(true)
  expect(has(bmp.bytes, CRITICAL)).toBe(true)
  expect(has(bmp.bytes, INK)).toBe(true)
  expect(atob(bmp.source().rgba).length).toBe(bmp.width * bmp.height * 4)
})

test('a curve at the widest pane stays under the 2 MiB an Image takes', () => {
  const c = scene.curves.find((x) => x.phase === 'test')!
  const bmp = curvePicture(c, 0.4, 255, 3)
  expect(bmp.bytes.length).toBeLessThanOrEqual(MAX_BYTES)
  expect(has(bmp.bytes, phaseColor('test'))).toBe(true)
  expect(has(bmp.bytes, INK)).toBe(true) // the dashed rule of the move
  expect(() => lanesPicture({ ...scene, lanes: Array(8).fill(scene.lanes[0]!) }, 255)).not.toThrow()
})

test('a picture refuses a side outside the 1..2048 pixels an Image takes; a wide box gets fewer pixels per cell', () => {
  expect(() => new Bitmap(0, 10, 0)).toThrow(/1\.\.2048/)
  expect(() => new Bitmap(MAX_SIDE + 1, 10, 0)).toThrow(/1\.\.2048/)
  const wide = lanesPicture(scene, 300)
  expect(wide.width).toBe(MAX_SIDE)
  expect(curvePicture(scene.curves[0]!, 0.4, 1, 3).width).toBe(CELL_W)
})
