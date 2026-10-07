import test from 'node:test';
import assert from 'node:assert/strict';
import { fromEsri, fromGeoJSON } from '../index.js';
import { repairs, hole, square } from './fixtures.js';

test('BACKTEST-01: explicit Esri repair preserves a hole when a separate ring self-touches', () => {
  const input = { rings: [repairs.spike.coordinates[0], hole] };
  const before = structuredClone(input);
  assert.throws(
    () => fromEsri(input),
    (error) => error.code === 'ESRI_RING',
  );
  const result = fromEsri(input, { repair: 'topology' });
  assert.equal(result.type, 'Polygon');
  assert.equal(result.geometry.coordinates.length, 2);
  assert.deepEqual(result.geometry.coordinates[1], hole);
  assert.ok(result.diagnostics.some((d) => d.code === 'ESRI_RING_REPAIRED'));
  assert.deepEqual(input, before);
});
test('BACKTEST-02: repaired Esri shells may split while retaining disjoint shells', () => {
  const result = fromEsri(
    { rings: [repairs.bowtie.coordinates[0], square(5, 5)] },
    { repair: 'topology' },
  );
  assert.equal(result.type, 'MultiPolygon');
  assert.equal(result.geometry.coordinates.length, 3);
  assert.ok(
    result.geometry.coordinates.some((poly) =>
      poly[0].some((p) => p[0] === 5 && p[1] === 5),
    ),
  );
});
test('BACKTEST-03: repair refuses crossing independent rings and preserves dimension policy', () => {
  assert.throws(
    () =>
      fromEsri({ rings: [square(0, 0, 2), square(1, 1, 2)] }, { repair: 'topology' }),
    (e) => e.code === 'ESRI_RING',
  );
  const rings = [
    repairs.spike.coordinates[0].map((p) => [...p, 1]),
    hole.map((p) => [...p, 1]),
  ];
  assert.throws(
    () => fromEsri({ rings, hasZ: true }, { repair: 'topology' }),
    (e) => e.code === 'REPAIR_DIMENSION',
  );
});
test('BACKTEST-04: equivalent dateline coordinates close rings and cannot form a line alone', () => {
  assert.throws(
    () =>
      fromGeoJSON({
        type: 'LineString',
        coordinates: [
          [-180, 0],
          [180, 0],
        ],
      }),
    (e) => e.code === 'COLLAPSED',
  );
  const result = fromGeoJSON({
    type: 'Polygon',
    coordinates: [
      [
        [-180, 0],
        [-179, 0],
        [-179, 1],
        [180, 0],
      ],
    ],
  });
  assert.equal(result.geometry.coordinates[0].length, 4);
  assert.ok(result.diagnostics.some((d) => d.code === 'CANONICAL_LONGITUDE'));
});
const overlappingLines = [
  {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 0],
      [0.5, 0],
    ],
  },
  {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1],
      [0, 0],
    ],
  },
  {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 0],
      [0.5, 0],
    ],
  },
  {
    type: 'MultiLineString',
    coordinates: [
      [
        [0, 0],
        [2, 0],
      ],
      [
        [1, 0],
        [3, 0],
      ],
    ],
  },
];
test('BACKTEST-05: overlapping geography lines are rejected under safe repair', () => {
  for (const input of overlappingLines)
    assert.throws(
      () => fromGeoJSON(input),
      (e) => e.code === 'LINE_OVERLAP',
    );
});
test('BACKTEST-06: explicit line repair preserves each traversal and altitude in a collection', () => {
  const input = {
    type: 'LineString',
    coordinates: [
      [0, 0, 5],
      [1, 0, 6],
      [0.5, 0, 7],
    ],
  };
  const result = fromGeoJSON(input, { repair: 'topology' });
  assert.equal(result.type, 'GeometryCollection');
  assert.deepEqual(result.geometry.geometries, [
    {
      type: 'LineString',
      coordinates: [
        [0, 0, 5],
        [1, 0, 6],
      ],
    },
    {
      type: 'LineString',
      coordinates: [
        [1, 0, 6],
        [0.5, 0, 7],
      ],
    },
  ]);
  assert.ok(result.diagnostics.some((d) => d.code === 'LINE_OVERLAP_REPAIRED'));
  assert.equal(
    fromGeoJSON(input, { spatialType: 'geometry', repair: 'topology' }).type,
    'GeometryCollection',
  );
});
test('BACKTEST-07: crossing, meeting and separately collected lines remain valid', () => {
  const crossing = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ],
  };
  assert.equal(fromGeoJSON(crossing).type, 'LineString');
  assert.equal(
    fromGeoJSON({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [1, 0],
          [2, 0],
        ],
      ],
    }).type,
    'MultiLineString',
  );
  assert.equal(
    fromGeoJSON({
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [2, 0],
          ],
        },
        {
          type: 'LineString',
          coordinates: [
            [1, 0],
            [3, 0],
          ],
        },
      ],
    }).type,
    'GeometryCollection',
  );
});
test('BACKTEST-08: a close but distinct geodesic is not misclassified as an overlapping line', () => {
  const input = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 0],
      [0.5, 0.00000001],
    ],
  };
  assert.equal(fromGeoJSON(input).type, 'LineString');
});

test('BACKTEST-09: planar overlapping lines follow the same safe rejection and traversal repair contract', () => {
  for (const input of overlappingLines) {
    assert.throws(
      () => fromGeoJSON(input, { spatialType: 'geometry' }),
      (e) => e.code === 'LINE_OVERLAP',
    );
    const fixed = fromGeoJSON(input, {
      spatialType: 'geometry',
      repair: 'topology',
    });
    assert.equal(fixed.type, 'GeometryCollection');
    assert.ok(fixed.diagnostics.some((d) => d.code === 'LINE_OVERLAP_REPAIRED'));
  }
  assert.equal(
    fromGeoJSON(
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
          [0.5, 1e-8],
        ],
      },
      { spatialType: 'geometry' },
    ).type,
    'LineString',
  );
});
