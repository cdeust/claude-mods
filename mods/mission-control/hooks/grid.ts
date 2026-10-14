// A grid of terminal cells, each a glyph, a foreground and a background, encoded as a `Raster`'s
// `cells`. Braille cells carry a 2 × 4 dot mask, so a line is drawn at twice the columns and four
// times the rows.
//
// source: claude-code types, RasterProps: `cells` is standard padded base64 of `columns * rows`
// little-endian u32 triplets `[codePoint, foreground, background]`; a code point is one printable
// width-1 BMP character (blocks, box drawing, braille too) or the tree is refused; 1 to 512
// columns, 1 to 256 rows.

export const MAX_COLUMNS = 512
export const MAX_ROWS = 256
const BRAILLE = 0x2800
// source: Unicode braille patterns: dot (column, row) to bit, rows 0-2 then row 3.
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

export class Grid {
  readonly words: Uint32Array
  private readonly dots: Uint8Array

  constructor(
    readonly columns: number,
    readonly rows: number,
    readonly background: number,
  ) {
    if (columns < 1 || columns > MAX_COLUMNS || rows < 1 || rows > MAX_ROWS) throw new Error(`grid ${columns}×${rows} is outside 1..512 × 1..256`)
    this.words = new Uint32Array(columns * rows * 3)
    this.dots = new Uint8Array(columns * rows)
    for (let i = 0; i < columns * rows; i++) this.words.set([0x20, background, background], i * 3)
  }

  put(x: number, y: number, glyph: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return
    this.words.set([glyph, color, this.background], (y * this.columns + x) * 3)
  }

  // Printable ASCII only, cut at the right edge; anything else is a `?`.
  text(x: number, y: number, s: string, color: number): number {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      this.put(x + i, y, c >= 0x20 && c < 0x7f ? c : 0x3f, color)
    }
    return x + s.length
  }

  // One braille dot at dot coordinates; the cell takes the colour of its last dot.
  dot(px: number, py: number, color: number): void {
    const x = Math.floor(px / 2)
    const y = Math.floor(py / 4)
    if (px < 0 || py < 0 || x >= this.columns || y >= this.rows) return
    const i = y * this.columns + x
    this.dots[i]! |= DOT[px % 2]![py % 4]!
    this.words.set([BRAILLE | this.dots[i]!, color, this.background], i * 3)
  }

  // A straight run of dots from one point to the other (Bresenham).
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.dot(x0, y0, color)
      if (x0 === x1 && y0 === y1) return
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
    }
  }

  // The `cells` prop: the words' bytes, little-endian, in padded base64.
  encode(): string {
    const bytes = new Uint8Array(this.words.length * 4)
    const view = new DataView(bytes.buffer)
    this.words.forEach((w, i) => view.setUint32(i * 4, w, true))
    return base64(bytes)
  }

  // The glyphs as text rows, for tests and for the `alt` of nothing.
  glyphRows(): string[] {
    const out: string[] = []
    for (let y = 0; y < this.rows; y++) {
      let row = ''
      for (let x = 0; x < this.columns; x++) row += String.fromCharCode(this.words[(y * this.columns + x) * 3]!)
      out.push(row)
    }
    return out
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Standard padded base64 (RFC 4648 §4).
export const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : '='
  }
  return out
}
