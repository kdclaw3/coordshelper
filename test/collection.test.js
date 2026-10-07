import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromFeatureSet,
  fromGeoJSON,
  fromEsri,
  SpatialError,
  toSqlSpatial,
} from '../index.js';

test('FeatureSet M-only metadata distinguishes measures from elevations', () => {
  const r = fromFeatureSet({
    hasM: true,
    hasZ: false,
    spatialReference: { wkid: 4326 },
    features: [
      {
        geometry: {
          paths: [
            [
              [0, 0, 4],
              [1, 1, 5],
            ],
          ],
        },
      },
    ],
  });
  assert.equal(r[0].spatial.wkt, 'LINESTRING (0 0 NULL 4,1 1 NULL 5)');
  assert.equal(r[0].error, null);
});
test('optional Esri measures preserve dimensionality without inventing values', () => {
  assert.equal(
    fromEsri({ x: 0, y: 0, m: 4, hasM: true, hasZ: false }).wkt,
    'POINT (0 0 NULL 4)',
  );
  const r = fromEsri({
    hasM: true,
    hasZ: false,
    paths: [
      [
        [0, 0],
        [1, 1, 5],
      ],
    ],
  });
  assert.equal(r.wkt, 'LINESTRING (0 0 NULL NULL,1 1 NULL 5)');
  assert.throws(
    () => fromEsri({ hasZ: true, points: [[0, 0]] }),
    (e) => e.code === 'DIMENSION',
  );
  assert.equal(fromEsri({ points: [[], [null], [1, 2]] }).wkt, 'MULTIPOINT (1 2)');
});
test('conflicting per-feature metadata fails locally while other features continue', () => {
  for (const geometry of [
    { x: 0, y: 0, spatialReference: { wkid: 3857 } },
    { points: [[0, 0, 1]], hasM: false },
  ]) {
    const rows = fromFeatureSet({
      spatialReference: { wkid: 4326 },
      hasM: true,
      features: [{ geometry }, { geometry: null }],
    });
    assert.ok(rows[0].error instanceof SpatialError);
    assert.match(rows[0].error.path, /^\$\.features\[0\]/);
    assert.equal(rows[1].error, null);
  }
});
test('FeatureSet inherits first-feature CRS without mutation', () => {
  const input = {
    features: [
      { geometry: { x: 0, y: 0, spatialReference: { wkid: 3857 } } },
      { geometry: { x: 1113194.9079327357, y: 0 } },
    ],
  };
  const original = structuredClone(input);
  const rows = fromFeatureSet(input);
  assert.ok(Math.abs(rows[1].spatial.geometry.coordinates[0] - 10) < 1e-8);
  assert.deepEqual(input, original);
});
test('ambiguous identifier casing is reported without losing other records', () => {
  const r = fromFeatureSet({
    features: [{ attributes: { GlobalID: 'a', GLOBALID: 'b' }, geometry: null }],
  });
  assert.equal(r[0].error.code, 'IDENTITY');
});
test('GeoJSON collections offer independent results and strict failure with full paths', () => {
  const input = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'good', geometry: null },
      {
        type: 'Feature',
        id: 'bad',
        geometry: { type: 'Point', coordinates: [0, 100] },
      },
    ],
  };
  const r = fromGeoJSON(input);
  assert.equal(r[0].error, null);
  assert.equal(r[1].id, 'bad');
  assert.equal(r[1].error.path, '$.features[1].coordinates');
  assert.throws(
    () => fromGeoJSON(input, { onError: 'throw' }),
    (e) => e.path === '$.features[1].coordinates',
  );
  assert.throws(
    () => fromGeoJSON(input, { maxFeatures: 1 }),
    (e) => e.code === 'LIMIT',
  );
  assert.throws(
    () => fromGeoJSON(input, { onError: 'ignore' }),
    (e) => e.code === 'OPTIONS',
  );
});
test('shared type conflicts are rejected and service metadata is optional for native points', () => {
  const r = fromFeatureSet({
    geometryType: 'esriGeometryPolygon',
    features: [{ geometry: { x: 1, y: 2 } }],
  });
  assert.equal(r[0].error.code, 'TYPE');
  assert.equal(
    toSqlSpatial({ features: [{ geometry: { x: 1, y: 2 } }] })[0].spatial.wkt,
    'POINT (1 2)',
  );
});
test('empty Esri shapes and null geometry retain distinct representations', () => {
  for (const g of [
    { rings: [] },
    { paths: [] },
    { points: [] },
    { curveRings: [] },
    { curvePaths: [] },
  ])
    assert.match(fromEsri(g).wkt, / EMPTY$/);
  assert.equal(fromEsri({ attributes: {} }), null);
  assert.throws(
    () => fromEsri({ x: 0 }),
    (e) => e.code === 'COORDINATE',
  );
});
