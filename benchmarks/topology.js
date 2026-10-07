/** Synthetic performance probe; no customer data or database dependencies. */
import { performance } from 'node:perf_hooks';
import { fromGeoJSON } from '../index.js';
for (const size of [1000, 3000, 10000]) {
  const ring = Array.from({ length: size }, (_, i) => [
    Math.cos((i * Math.PI * 2) / size),
    Math.sin((i * Math.PI * 2) / size),
  ]);
  ring.push(ring[0]);
  const line = Array.from({ length: size }, (_, i) => [
    i / size,
    0.01 * Math.sin(i / 100),
  ]);
  for (const input of [
    { type: 'Polygon', coordinates: [ring] },
    { type: 'LineString', coordinates: line },
  ]) {
    const start = performance.now();
    const result = fromGeoJSON(input);
    console.log(
      JSON.stringify({
        type: input.type,
        vertices: size,
        milliseconds: performance.now() - start,
        resultType: result.type,
      }),
    );
  }
}
