// An RGBA picture the mod paints itself, handed to an `Image` as `{ rgba, width, height }`: no PNG
// encoder, no library.
//
// source: claude-code types, ImageSource: `{ rgba, width, height }` base64 bytes the plugin holds,
// at most 2 MiB decoded, width and height each 1 to 2048 pixels; ImageProps: 1 to 255 columns. An
// Image draws pixels over the kitty graphics protocol (kitty, Ghostty) and its `alt` elsewhere.

import { base64 } from './grid'
import { rgb } from './palette'

export const MAX_BYTES = 2 * 1024 * 1024
export const MAX_SIDE = 2048
export const MAX_IMAGE_COLUMNS = 255
// source: own choice, the pixels one cell stands for when a picture is painted; the terminal
// scales the picture to its box, so this sets the detail, not the size on screen.
export const CELL_W = 8
export const CELL_H = 16

export class Bitmap {
  readonly bytes: Uint8Array
  private readonly pixels: Uint32Array

  constructor(
    readonly width: number,
    readonly height: number,
    background: number,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE)
      throw new Error(`picture ${width}×${height} is outside the 1..2048 pixels an Image takes per side`)
    if (width * height * 4 > MAX_BYTES) throw new Error(`picture ${width}×${height} is over the 2 MiB an Image takes`)
    this.bytes = new Uint8Array(width * height * 4)
    this.pixels = new Uint32Array(this.bytes.buffer)
    this.rect(0, 0, width, height, background)
  }

  // A row at a time through a 32-bit view: one pixel is the bytes R, G, B, A in memory order, read
  // as a little-endian word (the order every engine this runs on uses: x86-64 and arm64).
  rect(x: number, y: number, w: number, h: number, color: number): void {
    const [r, g, b] = rgb(color)
    const word = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
    const i0 = Math.max(0, Math.floor(x))
    const i1 = Math.min(this.width, Math.ceil(x + w))
    if (i1 <= i0) return
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(this.height, Math.ceil(y + h)); j++) this.pixels.fill(word, j * this.width + i0, j * this.width + i1)
  }

  // A line `thick` pixels wide, stamped square by square along its length.
  line(x0: number, y0: number, x1: number, y1: number, color: number, thick = 2): void {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let k = 0; k <= n; k++) this.rect(x0 + ((x1 - x0) * k) / n - thick / 2, y0 + ((y1 - y0) * k) / n - thick / 2, thick, thick, color)
  }

  source(): { rgba: string; width: number; height: number } {
    return { rgba: base64(this.bytes), width: this.width, height: this.height }
  }
}
