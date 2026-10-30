import { describe, expect, it } from 'vitest';
import { findOffset, type Pixels } from '../src/capture/drift';

function blank(width: number, height: number, rgba: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { data, width, height };
}

/** A probe that looks like two lines of text: light, irregular strokes on a transparent box. */
function probe(width = 60, height = 20): Pixels {
  const p = blank(width, height, [0, 0, 0, 0]);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const inLine = (y >= 2 && y <= 7) || (y >= 11 && y <= 16);
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      if (inLine && seed % 2 === 0) p.data.set([230, 230, 230, 255], (y * width + x) * 4);
    }
  }
  return p;
}

/** A dark page with the probe's opaque pixels painted at (x, y). */
function viewWith(p: Pixels, x: number, y: number): Pixels {
  const v = blank(400, 300, [12, 12, 14, 255]);
  for (let py = 0; py < p.height; py++) {
    for (let px = 0; px < p.width; px++) {
      const i = (py * p.width + px) * 4;
      if (p.data[i + 3]! > 0) v.data.set(p.data.subarray(i, i + 4), ((y + py) * v.width + (x + px)) * 4);
    }
  }
  return v;
}

describe('findOffset', () => {
  it('finds the element where the render drew it', () => {
    const p = probe();
    expect(findOffset(viewWith(p, 100, 152), p, { x: 100, y: 120 })).toEqual({ dx: 0, dy: 32 });
    expect(findOffset(viewWith(p, 100, 88), p, { x: 100, y: 120 })).toEqual({ dx: 0, dy: -32 });
    expect(findOffset(viewWith(p, 105, 120), p, { x: 100, y: 120 })).toEqual({ dx: 5, dy: 0 });
  });

  it('reports no drift when the render matches the page', () => {
    const p = probe();
    expect(findOffset(viewWith(p, 100, 120), p, { x: 100.4, y: 119.6 })).toEqual({ dx: 0, dy: 0 });
  });

  it('gives up on a see-through element', () => {
    expect(findOffset(blank(400, 300, [12, 12, 14, 255]), blank(60, 20, [0, 0, 0, 0]), { x: 100, y: 120 })).toBeNull();
  });

  it('gives up when nothing stands out (a flat box on a flat page)', () => {
    const flat = blank(60, 20, [12, 12, 14, 255]);
    expect(findOffset(blank(400, 300, [12, 12, 14, 255]), flat, { x: 100, y: 120 })).toBeNull();
  });

  it('gives up when the element is off screen', () => {
    const p = probe();
    expect(findOffset(viewWith(p, 100, 120), p, { x: 100, y: 900 })).toBeNull();
  });
});
