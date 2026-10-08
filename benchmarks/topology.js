/** Synthetic bounded-work probes; timings are observations, not performance guarantees. */
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fromGeoJSON, fromEsri } from '../index.js';

const circle = (size, radius = 1) => {
  const ring = Array.from({ length: size }, (_, i) => [
    Math.cos((i * Math.PI * 2) / size) * radius,
    Math.sin((i * Math.PI * 2) / size) * radius,
  ]);
  ring.push(ring[0]);
  return ring;
};
const triangle = (vertices, size) => {
  const points = [];
  vertices.forEach((a, i) => {
    const b = vertices[(i + 1) % vertices.length];
    for (let j = 0; j < size; j++)
      points.push([
        a[0] + ((b[0] - a[0]) * j) / size,
        a[1] + ((b[1] - a[1]) * j) / size,
      ]);
  });
  points.push(points[0]);
  return points;
};
for (const size of [1000, 3000, 10000]) {
  const ring = circle(size),
    hole = circle(Math.floor(size / 4), 0.5);
  const east = Array.from({ length: size }, (_, i) => [
    i / size,
    0.01 * Math.sin(i / 100),
  ]);
  const north = east.map(([x, y]) => [y, x]);
  const long = Array.from({ length: size }, (_, i) => [
    -170 + (340 * i) / (size - 1),
    40 + 10 * Math.sin((i / size) * Math.PI),
  ]);
  const cases = [
    ['circle', { type: 'Polygon', coordinates: [ring] }],
    ['east-west line', { type: 'LineString', coordinates: east }],
    ['north-south line', { type: 'LineString', coordinates: north }],
    [
      'tall ring',
      { type: 'Polygon', coordinates: [ring.map(([x, y]) => [x / 100, y])] },
    ],
    ['large hole', { type: 'Polygon', coordinates: [ring, hole] }],
    [
      'corner-touching part boxes',
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            triangle(
              [
                [-1, 3],
                [2, 2],
                [3, -1],
              ],
              Math.floor(size / 3),
            ),
          ],
          [
            triangle(
              [
                [2, 2],
                [5, 2],
                [2, 5],
              ],
              Math.floor(size / 12),
            ),
          ],
        ],
      },
      (input) => fromGeoJSON(input, { spatialType: 'geometry' }),
    ],
    [
      'touching hole',
      {
        type: 'Polygon',
        coordinates: [
          circle(size, 2),
          circle(Math.floor(size / 4), 0.5).map(([x, y]) => [x + 1.5, y]),
        ],
      },
    ],
    [
      'many-part lines',
      {
        type: 'MultiLineString',
        coordinates: Array.from(
          { length: Math.max(20, Math.floor(size / 50)) },
          (_, p) => Array.from({ length: 51 }, (_, i) => [i * 20, p / 100]),
        ),
      },
      (input) => fromGeoJSON(input, { spatialType: 'geometry' }),
    ],
    [
      'many curved rings',
      {
        curveRings: Array.from(
          { length: Math.max(20, Math.floor(size / 50)) },
          (_, p) =>
            triangle(
              [
                [p * 3, 0],
                [p * 3 + 1, 0],
                [p * 3, 1],
              ],
              16,
            ),
        ),
      },
      (input) => fromEsri(input, { spatialType: 'geometry' }),
    ],
    [
      'empty components',
      {
        type: 'GeometryCollection',
        geometries: Array.from({ length: Math.min(size, 9000) }, () => ({
          type: 'Point',
          coordinates: [],
        })),
      },
    ],
    [
      'overlapping part boxes',
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            triangle(
              [
                [0, 0],
                [4, 0],
                [0, 4],
              ],
              Math.floor(size / 3),
            ),
          ],
          [
            triangle(
              [
                [4, 4],
                [1, 4],
                [4, 1],
              ],
              Math.floor(size / 3),
            ),
          ],
        ],
      },
    ],
    ['Esri multi-ring', { rings: [[...ring].reverse(), hole] }, fromEsri],
    ['long geography line', { type: 'LineString', coordinates: long }],
    [
      'long geography edges',
      {
        type: 'LineString',
        coordinates: [
          [-150, 40],
          [-50, 60],
          [50, 40],
          [150, 60],
        ],
      },
    ],
  ];
  for (const [name, input, convert = fromGeoJSON] of cases) {
    const coldStart = performance.now();
    let result = convert(input);
    const coldMilliseconds = performance.now() - coldStart;
    for (let i = 0; i < 2; i++) convert(input);
    const times = [],
      before = process.memoryUsage();
    let peakHeap = before.heapUsed,
      peakRss = before.rss;
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      result = convert(input);
      times.push(performance.now() - start);
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        name,
        size,
        node: process.version,
        coldMilliseconds,
        medianMilliseconds: times[3],
        p95Milliseconds: times[6],
        repetitions: times.length,
        sampledPeakHeapBytes: peakHeap,
        sampledPeakRssBytes: peakRss,
        heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed,
        topologyChecks: result.validation.topologyChecks,
        resultType: result.type,
      }),
    );
  }
}
// Scheduling is measured in the caller: async wrappers alone cannot move CPU conversion.
for (const yieldEvery of [0, 2]) {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await setTimeout(15);
  const start = performance.now();
  for (let i = 0; i < 12; i++) {
    fromGeoJSON({ type: 'Polygon', coordinates: [circle(10000)] });
    if (yieldEvery && (i + 1) % yieldEvery === 0) await setImmediate();
  }
  await setTimeout(15);
  delay.disable();
  console.log(
    JSON.stringify({
      name: 'batch responsiveness',
      node: process.version,
      yieldEvery,
      milliseconds: performance.now() - start,
      eventLoopMaxMilliseconds: delay.max / 1e6,
      eventLoopP95Milliseconds: delay.percentile(95) / 1e6,
    }),
  );
}
