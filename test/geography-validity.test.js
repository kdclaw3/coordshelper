/** SQL geography regressions: straight longitude/latitude edges are not great ellipses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { globals } from './fixtures.js';

import {
  notch,
  curvedHole,
  curvedParts,
  greatEllipseOverlap,
} from './geography-fixtures.js';
const topologyError = (e) => e instanceof h.SpatialError && e.code === 'TOPOLOGY';

test('line overlap uses great ellipses, not shortest ellipsoidal geodesics', () => {
  assert.throws(
    () => h.fromGeoJSON(greatEllipseOverlap),
    (e) => e instanceof h.SpatialError && e.code === 'LINE_OVERLAP',
  );
  assert.doesNotThrow(() =>
    h.fromGeoJSON(greatEllipseOverlap, { spatialType: 'geometry' }),
  );
  const result = h.fromGeoJSON(greatEllipseOverlap, { repair: 'topology' });
  assert.equal(result.type, 'GeometryCollection');
  assert.deepEqual(
    result.geometry.geometries.map((g) => g.coordinates),
    greatEllipseOverlap.coordinates,
  );
});
test('line envelopes and overlaps work across the dateline and a pole', () => {
  for (const coordinates of [
    [
      [
        [170, 0],
        [-170, 0],
      ],
      [
        [-175, 0],
        [-170, 0],
      ],
    ],
    [
      [
        [-135, 80],
        [45, 80],
      ],
      [
        [0, 90],
        [45, 80],
      ],
    ],
  ])
    assert.throws(
      () => h.fromGeoJSON({ type: 'MultiLineString', coordinates }),
      (e) => e.code === 'LINE_OVERLAP',
    );
  assert.doesNotThrow(() =>
    h.fromGeoJSON({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 45],
          [2, 45],
        ],
        [
          [1, 45],
          [2, 45],
        ],
      ],
    }),
  );
});
test('short duplicate geography edges are detected without cancellation in the plane normal', () => {
  for (const x of [-179, -83, 0, 120])
    for (const y of [-80, -43, 0, 43, 80])
      for (const size of [0.000001, 0.001, 1]) {
        const line = [
          [x, y],
          [x + size, y + size],
        ];
        assert.throws(
          () =>
            h.fromGeoJSON({
              type: 'MultiLineString',
              coordinates: [line, line.toReversed()],
            }),
          (e) => e.code === 'LINE_OVERLAP',
          `${x}/${y}/${size}`,
        );
      }
});
test('safe geography normalization preserves Z/M and bounds work with useful error paths', () => {
  const input = notch(0.000001);
  input.coordinates[0] = input.coordinates[0].map((p) => [...p, 12, 34]);
  const original = structuredClone(input);
  const result = h.fromSpatial(input);
  assert.deepEqual(result.geometry, input);
  assert.deepEqual(input, original);
  assert.throws(
    () => h.fromSpatial(input, { maxTopologyChecks: 1 }),
    (e) => e.code === 'LIMIT' && e.path === '$.coordinates[0]',
  );
  assert.throws(
    () =>
      h.fromSpatial(
        {
          ...input,
          coordinates: notch().coordinates.map((r) => r.map((p) => [...p, 12, 34])),
        },
        { repair: 'topology' },
      ),
    (e) => e.code === 'REPAIR_DIMENSION',
  );
});

test('great-ellipse crossings rejected before SQL generation, planar target unchanged', () => {
  for (const input of [notch(), curvedHole, curvedParts]) {
    const original = structuredClone(input);
    assert.throws(() => h.fromGeoJSON(input), topologyError);
    assert.doesNotThrow(() => h.fromGeoJSON(input, { spatialType: 'geometry' }));
    assert.deepEqual(input, original);
  }
});
test('notch validation follows latitude, longitude, the dateline and clearance', () => {
  for (const longitude of [0, -83, 179.999]) {
    assert.throws(() => h.fromGeoJSON(notch(0.0000002, 45, longitude)), topologyError);
    assert.doesNotThrow(() => h.fromGeoJSON(notch(0.000001, 45, longitude)));
    assert.doesNotThrow(() => h.fromGeoJSON(notch(0.0000002, 0, longitude)));
  }
  const south = notch();
  south.coordinates[0] = south.coordinates[0].map(([x, y]) => [x, -y]);
  assert.throws(() => h.fromGeoJSON(south), topologyError);
});
test('every polygon entry point enforces geography topology and indexed collection errors', () => {
  const input = notch();
  assert.throws(() => h.fromSpatial(input), topologyError);
  assert.throws(
    () => h.fromGeoJSON({ type: 'Feature', geometry: input }),
    topologyError,
  );
  assert.throws(() => h.fromEsri({ rings: input.coordinates }), topologyError);
  const feature = { type: 'Feature', id: 'bad', geometry: input };
  const good = { type: 'Feature', id: 'good', geometry: notch(0.000001) };
  const rows = h.fromGeoJSON({ type: 'FeatureCollection', features: [feature, good] });
  assert.equal(rows[0].error.code, 'TOPOLOGY');
  assert.match(rows[0].error.path, /features\[0\]/);
  assert.equal(rows[1].error, null);
  const esri = h.fromFeatureSet({
    features: [
      { geometry: { rings: input.coordinates } },
      { geometry: { rings: good.geometry.coordinates } },
    ],
  });
  assert.equal(esri[0].error.code, 'TOPOLOGY');
  assert.equal(esri[1].error, null);
});
test('explicit repair must repair actual geography, not only a flat preview', () => {
  for (const input of [notch(), curvedHole, curvedParts]) {
    const result = h.fromGeoJSON(input, { repair: 'topology' });
    assert.ok(result.diagnostics.some((d) => d.code === 'TOPOLOGY_REPAIRED'));
    assert.doesNotThrow(() => h.fromGeoJSON(result.geometry));
    assert.equal(result.validation.sqlServerValidated, false);
  }
});
test('polar/dateline controls remain supported without a skipped topology diagnostic', () => {
  for (const { geometry } of globals) {
    const result = h.fromGeoJSON(geometry);
    assert.ok(!result.diagnostics.some((d) => d.code === 'SQL_VALIDATION_REQUIRED'));
  }
});
test('two shell contacts remain accepted under SQL geography validity rules', () => {
  const input = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [0, 2],
        [2, 1],
        [4, 2],
        [2, 3],
        [0, 2],
      ],
    ],
  };
  assert.doesNotThrow(() => h.fromGeoJSON(input));
});
test('uncertifiable global polygons fail explicitly instead of promising validity', () => {
  const input = {
    type: 'Polygon',
    coordinates: [
      [
        [-170, 10],
        [-60, 10],
        [60, 10],
        [170, 10],
        [170, -10],
        [60, -10],
        [-60, -10],
        [-170, -10],
        [-170, 10],
      ],
    ],
  };
  assert.throws(
    () => h.fromGeoJSON(input),
    (e) => e instanceof h.SpatialError && e.code === 'GEOGRAPHY_UNCERTAIN',
  );
});
test('preserved interiors cannot bypass hole winding or multipart complement checks', () => {
  const shell = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ];
  const hole = [
    [1, 1],
    [2, 1],
    [2, 2],
    [1, 2],
    [1, 1],
  ];
  assert.throws(
    () =>
      h.fromGeoJSON(
        { type: 'Polygon', coordinates: [shell, hole] },
        { orientation: 'preserve' },
      ),
    (e) => e.code === 'WINDING',
  );
  const other = shell.map(([x, y]) => [x + 10, y]);
  assert.throws(
    () =>
      h.fromGeoJSON(
        { type: 'MultiPolygon', coordinates: [[shell.toReversed()], [other]] },
        { orientation: 'preserve' },
      ),
    (e) => e.code === 'GEOGRAPHY_UNCERTAIN',
  );
  assert.doesNotThrow(() =>
    h.fromGeoJSON(
      { type: 'Polygon', coordinates: [shell.toReversed()] },
      { orientation: 'preserve' },
    ),
  );
});
