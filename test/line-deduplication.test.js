import test from 'node:test';
import assert from 'node:assert/strict';
import { fromGeoJSON, fromEsri, fromSpatial, SpatialError } from '../index.js';
import {
  retrace,
  cleanRetrace,
  branch,
  deduplicationCases,
} from './line-deduplication-fixtures.js';

const cleanup = { repair: 'topology', lineOverlap: 'deduplicate' };
const errorCode = (code) => (error) =>
  error instanceof SpatialError && error.code === code;

test('uncertain geography edges identify the LineString source index', () => {
  const coordinates = [
    [10, 1],
    [0, 0],
    [179.99999999999, 0],
  ];
  assert.throws(
    () => fromGeoJSON({ type: 'LineString', coordinates }),
    (error) =>
      error instanceof SpatialError &&
      error.code === 'GEOGRAPHY_UNCERTAIN' &&
      error.path === '$.coordinates[1]',
  );
});

test('deduplicated uncertain edges retain their original source indices', () => {
  const coordinates = [
    [10, 1],
    [0, 0],
    [10, 1],
    [0, 0],
    [179.99999999999, 0],
  ];
  for (const [geometry, expected] of [
    [{ type: 'LineString', coordinates }, '$.coordinates[3]'],
    [
      { type: 'MultiLineString', coordinates: [[], coordinates] },
      '$.coordinates[1][3]',
    ],
  ])
    assert.throws(
      () => fromGeoJSON(geometry, cleanup),
      (error) =>
        error instanceof SpatialError &&
        error.code === 'GEOGRAPHY_UNCERTAIN' &&
        error.path === expected,
    );
});

test('line comparison limits identify source edges after deduplication', () => {
  for (const spatialType of ['geography', 'geometry'])
    for (const [geometry, expected] of [
      [retrace, '$.coordinates[3]'],
      [
        { type: 'MultiLineString', coordinates: [[], retrace.coordinates] },
        '$.coordinates[1][3]',
      ],
    ])
      assert.throws(
        () => fromGeoJSON(geometry, { ...cleanup, spatialType, maxTopologyChecks: 4 }),
        (error) =>
          error instanceof SpatialError &&
          error.code === 'LIMIT' &&
          error.path === expected,
      );
});

test('collection wrappers retain the indexed source edge error path', () => {
  const features = [
    { type: 'Feature', id: 'good', geometry: cleanRetrace },
    {
      type: 'Feature',
      id: 'bad',
      geometry: {
        type: 'LineString',
        coordinates: [
          [10, 1],
          [0, 0],
          [10, 1],
          [0, 0],
          [179.99999999999, 0],
        ],
      },
    },
  ];
  const rows = fromGeoJSON(
    { type: 'FeatureCollection', features },
    { ...cleanup, onError: 'collect' },
  );
  assert.equal(rows[1].error.code, 'GEOGRAPHY_UNCERTAIN');
  assert.equal(rows[1].error.path, '$.features[1].coordinates[3]');
});

test('default rejection and traversal-preserving repair retain their current behavior', () => {
  assert.throws(() => fromGeoJSON(retrace), errorCode('LINE_OVERLAP'));
  const result = fromGeoJSON(retrace, { repair: 'topology' });
  assert.equal(result.type, 'GeometryCollection');
  assert.ok(result.diagnostics.some((d) => d.code === 'LINE_OVERLAP_REPAIRED'));
});

for (const [name, input, expected] of deduplicationCases) {
  test(`exact line cleanup retains the complete ${name} shape in both SQL models`, () => {
    const before = structuredClone(input);
    for (const spatialType of ['geography', 'geometry']) {
      const result = fromGeoJSON(input, { ...cleanup, spatialType });
      assert.deepEqual(result.geometry, expected);
      const diagnostic = result.diagnostics.find(
        (d) => d.code === 'LINE_OVERLAP_DEDUPLICATED',
      );
      assert.ok(diagnostic);
      assert.ok(diagnostic.detail.removedTraversals > 0);
      assert.equal(diagnostic.detail.afterType, expected.type);
      assert.equal(result.validation.sqlServerValidated, false);
      const repeated = fromGeoJSON(result.geometry, { ...cleanup, spatialType });
      assert.deepEqual(repeated.geometry, expected);
      assert.equal(repeated.wkt, result.wkt);
      assert.ok(
        !repeated.diagnostics.some((d) => d.code === 'LINE_OVERLAP_DEDUPLICATED'),
      );
    }
    assert.deepEqual(input, before);
  });
}

test('cleanup diagnostics account for each duplicate traversal', () => {
  const result = fromGeoJSON(retrace, cleanup);
  const d = result.diagnostics.find((d) => d.code === 'LINE_OVERLAP_DEDUPLICATED');
  assert.equal(d.detail.inputSegments, 4);
  assert.equal(d.detail.uniqueSegments, 2);
  assert.equal(d.detail.removedTraversals, 2);
  assert.equal(d.path, '$.coordinates');
});

test('valid lines and original multipart boundaries stay unchanged when no edge repeats', () => {
  for (const input of [
    cleanRetrace,
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0, 1],
          [1, 0, 2],
        ],
        [
          [1, 0, 20],
          [2, 1, 30],
        ],
      ],
    },
  ]) {
    const result = fromGeoJSON(input, cleanup);
    assert.deepEqual(result.geometry, input);
    assert.ok(!result.diagnostics.some((d) => d.code === 'LINE_OVERLAP_DEDUPLICATED'));
  }
});

test('cleanup refuses partial overlaps without rounding or inventing vertices', () => {
  const input = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [2, 0],
      [1, 0],
    ],
  };
  const before = structuredClone(input);
  for (const spatialType of ['geometry', 'geography'])
    assert.throws(
      () => fromGeoJSON(input, { ...cleanup, spatialType }),
      errorCode('LINE_OVERLAP'),
    );
  assert.deepEqual(input, before);
});

test('deduplication requires explicit topology repair and a known option value', () => {
  for (const repair of [undefined, 'safe', 'none'])
    assert.throws(
      () => fromGeoJSON(retrace, { repair, lineOverlap: 'deduplicate' }),
      errorCode('REPAIR'),
    );
  for (const lineOverlap of [null, true, 'merge', ''])
    assert.throws(
      () => fromGeoJSON(null, { repair: 'topology', lineOverlap }),
      errorCode('REPAIR'),
    );
});

test('matching altitude and measure survive; conflicting values are refused', () => {
  for (const tail of [[7], [7, 12], [null, 12]]) {
    const input = {
      ...retrace,
      coordinates: retrace.coordinates.map((p) => [...p, ...tail]),
    };
    const expected = {
      ...cleanRetrace,
      coordinates: cleanRetrace.coordinates.map((p) => [...p, ...tail]),
    };
    assert.deepEqual(fromSpatial(input, cleanup).geometry, expected);
  }
  const bad = {
    type: 'LineString',
    coordinates: [
      [0, 0, 1],
      [1, 0, 2],
      [0, 0, 3],
      [1, 0, 2],
    ],
  };
  assert.throws(() => fromGeoJSON(bad, cleanup), errorCode('REPAIR_DIMENSION'));
  const badMeasure = {
    type: 'LineString',
    coordinates: [
      [0, 0, null, 1],
      [1, 0, null, 2],
      [0, 0, null, 3],
    ],
  };
  assert.throws(() => fromSpatial(badMeasure, cleanup), errorCode('REPAIR_DIMENSION'));
});

test('Esri linear paths and XYM use the same cleanup', () => {
  const paths = retrace.coordinates.map((p) => [...p, p[0] + p[1]]);
  const result = fromEsri(
    { paths: [paths], hasM: true, hasZ: false, spatialReference: { wkid: 4326 } },
    cleanup,
  );
  assert.deepEqual(
    result.geometry.coordinates,
    cleanRetrace.coordinates.map((p) => [...p, null, p[0] + p[1]]),
  );
});

test('generated paths retain projected coordinates without projecting them twice', () => {
  let calls = 0;
  const result = fromGeoJSON(retrace, {
    ...cleanup,
    converter: ([x, y]) => {
      calls++;
      return [x + 0.01, y + 0.01];
    },
  });
  assert.deepEqual(
    result.geometry.coordinates,
    cleanRetrace.coordinates.map(([x, y]) => [x + 0.01, y + 0.01]),
  );
  assert.equal(calls, retrace.coordinates.length);
});

test('collections retain feature identity and isolate a refused partial overlap', () => {
  const features = [
    { type: 'Feature', id: 'good', geometry: retrace },
    {
      type: 'Feature',
      id: 'bad',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [2, 0],
          [1, 0],
        ],
      },
    },
    { type: 'Feature', id: 'next', geometry: retrace },
  ];
  const rows = fromGeoJSON(
    { type: 'FeatureCollection', features },
    { ...cleanup, onError: 'collect' },
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['good', 'bad', 'next'],
  );
  assert.deepEqual(rows[0].spatial.geometry, cleanRetrace);
  assert.deepEqual(rows[2].spatial.geometry, cleanRetrace);
  assert.equal(rows[1].error.code, 'LINE_OVERLAP');
  assert.match(rows[1].error.path, /^\$\.features\[1\]/);
});

test('duplicate globe edges work at the dateline, a pole and sub-metre scale', () => {
  for (const line of [
    [
      [170, 0],
      [-170, 0],
    ],
    [
      [0, 90],
      [45, 80],
    ],
    [
      [-83, 43],
      [-82.999999, 43.000001],
    ],
  ]) {
    const result = fromGeoJSON(
      { type: 'MultiLineString', coordinates: [line, line.toReversed()] },
      cleanup,
    );
    assert.deepEqual(result.geometry, { type: 'LineString', coordinates: line });
  }
});

test('mixed empty members survive cleanup and all-empty inputs remain typed EMPTY', () => {
  const line = [
    [0, 0],
    [1, 0],
  ];
  const result = fromGeoJSON(
    { type: 'MultiLineString', coordinates: [line, [], line.toReversed()] },
    cleanup,
  );
  assert.deepEqual(result.geometry, {
    type: 'MultiLineString',
    coordinates: [line, []],
  });
  assert.match(result.wkt, /EMPTY/);
  assert.deepEqual(
    fromGeoJSON({ type: 'MultiLineString', coordinates: [[], []] }, cleanup).geometry
      .coordinates,
    [[], []],
  );
});

test('branch cleanup in a CompoundCurve reports a typed curve repair error', () => {
  assert.throws(
    () => fromSpatial({ type: 'CompoundCurve', segments: [branch] }, cleanup),
    errorCode('CURVE_REPAIR'),
  );
});

test('processing and generated-output limits remain bounded and point to the feature', () => {
  assert.throws(
    () => fromGeoJSON(retrace, { ...cleanup, maxTopologyChecks: 1 }),
    (e) =>
      e instanceof SpatialError &&
      e.code === 'LIMIT' &&
      e.path.startsWith('$.coordinates'),
  );
  assert.throws(
    () => fromGeoJSON(retrace, { ...cleanup, maxPositions: 6 }),
    errorCode('LIMIT'),
  );
  assert.throws(
    () => fromGeoJSON(branch, { ...cleanup, maxComponents: 2 }),
    errorCode('LIMIT'),
  );
  const rows = fromGeoJSON(
    {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'one', geometry: retrace },
        { type: 'Feature', id: 'two', geometry: retrace },
      ],
    },
    { ...cleanup, maxTopologyChecks: 1, onError: 'collect' },
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.error?.code === 'LIMIT'));
  assert.match(rows[1].error.path, /^\$\.features\[1\]/);
});

test('many exact repeats are removed before pairwise overlap validation', () => {
  const coordinates = Array.from({ length: 5001 }, (_, i) => [i % 2, 0]);
  const result = fromGeoJSON(
    { type: 'LineString', coordinates },
    { ...cleanup, maxTopologyChecks: 6000 },
  );
  assert.deepEqual(result.geometry.coordinates, [
    [0, 0],
    [1, 0],
  ]);
  assert.ok(result.validation.topologyChecks <= 6000);
});
