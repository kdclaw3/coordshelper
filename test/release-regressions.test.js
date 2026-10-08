import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as h from '../index.js';
import { esriCircle as circle } from './fixtures.js';

const feature = (geometry, id = 'a') => ({ attributes: { globalid: id }, geometry });
// Clockwise Esri outer ring, with two circular semicircles.

test('RELEASE-01: the ESM example runs without credentials', () => {
  const result = spawnSync(process.execPath, ['examples/v3.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
test('RELEASE-02: Esri curved shells are rewound and disjoint shells are separate', () => {
  const result = h.fromEsri({ curveRings: [circle(), circle(4)] });
  assert.equal(result.type, 'GeometryCollection');
  assert.equal(result.geometry.geometries.length, 2);
  assert.ok(result.diagnostics.some((d) => d.code === 'REWOUND'));
});
test('RELEASE-03: a repaired CompoundCurve section raises SpatialError, not TypeError', () => {
  assert.throws(
    () =>
      h.fromSpatial(
        {
          type: 'CompoundCurve',
          segments: [
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [2, 0],
                [1, 0],
              ],
            },
            {
              type: 'CircularString',
              coordinates: [
                [1, 0],
                [2, 1],
                [3, 0],
              ],
            },
          ],
        },
        { repair: 'topology' },
      ),
    h.SpatialError,
  );
});
test('RELEASE-04: legacy CRS on a Feature and FeatureCollection cannot be ignored', () => {
  const f = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    crs: { type: 'name', properties: { name: 'EPSG:3857' } },
  };
  assert.throws(
    () => h.fromGeoJSON(f),
    (e) => e.code === 'CRS',
  );
  assert.throws(
    () => h.fromGeoJSON({ type: 'FeatureCollection', features: [f], crs: f.crs }),
    (e) => e.code === 'CRS',
  );
});
test('RELEASE-05: legitimate Esri empties retain null or EMPTY', () => {
  assert.equal(h.fromEsri({ x: null }).wkt, 'POINT EMPTY');
  assert.equal(h.fromEsri(feature(undefined)), null);
  assert.equal(h.fromEsri({ attributes: {} }), null);
  assert.equal(h.fromEsri({ xmin: null }).wkt, 'POLYGON EMPTY');
  assert.throws(() => h.fromEsri({ x: 'NaN', y: 0 }), h.SpatialError);
});
test('RELEASE-06: FeatureSet metadata identifies arbitrary case-insensitive UUID fields', () => {
  const r = h.fromEsri({
    globalIdFieldName: 'source_uuid',
    objectIdFieldName: 'row_number',
    features: [
      { attributes: { SOURCE_UUID: '00123', ROW_NUMBER: 42 }, geometry: null },
    ],
  });
  assert.equal(r[0].id, '00123');
});
test('RELEASE-07: native planar coordinates are retained with projection disabled', () => {
  const r = h.fromEsri(
    { x: 123456, y: 654321, spatialReference: { wkid: 102999 } },
    { spatialType: 'geometry', project: false },
  );
  assert.equal(r.srid, 102999);
  assert.deepEqual(r.geometry.coordinates, [123456, 654321]);
});
test('RELEASE-08: explicit line repair preserves unaffected long sections', () => {
  const r = h.fromGeoJSON(
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 1],
        [3, 0],
        [2.5, 0.5],
      ],
    },
    { spatialType: 'geometry', repair: 'topology' },
  );
  assert.equal(r.type, 'GeometryCollection');
  assert.ok(r.geometry.geometries.some((g) => g.coordinates.length > 2));
});
test('RELEASE-09: small coordinates use decimal SQL text', () => {
  assert.equal(
    h.fromGeoJSON({ type: 'Point', coordinates: [1e-8, -1e-9] }).wkt,
    'POINT (0.00000001 -0.000000001)',
  );
});
test('RELEASE-10: ordinary large rings are not rejected by the pair budget', () => {
  const ring = Array.from({ length: 3000 }, (_, i) => [
    Math.cos((i * 2 * Math.PI) / 3000),
    Math.sin((i * 2 * Math.PI) / 3000),
  ]);
  ring.push(ring[0]);
  assert.equal(h.fromGeoJSON({ type: 'Polygon', coordinates: [ring] }).type, 'Polygon');
});
test('RELEASE-11: optional FeatureSet conversion returns per-feature failures', () => {
  assert.equal(typeof h.fromFeatureSet, 'function');
  const result = h.fromFeatureSet({
    features: [
      feature({ x: 1, y: 2 }),
      feature({ x: 1, y: 100 }, 'bad'),
      feature(null, 'null'),
    ],
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].error, null);
  assert.equal(result[1].spatial, null);
  assert.ok(result[1].error instanceof h.SpatialError);
  assert.match(result[1].error.path, /^\$\.features\[1\]/);
  assert.equal(result[2].spatial, null);
  assert.throws(
    () =>
      h.fromFeatureSet({ features: [feature({ x: 0, y: 100 })] }, { onError: 'throw' }),
    h.SpatialError,
  );
});
test('RELEASE-12: custom projection definitions and converters are supported', () => {
  const source = { x: 1113194.9079327357, y: 0, spatialReference: { wkid: 102999 } };
  const r = h.fromEsri(source, {
    projectionDefinitions: {
      'ESRI:102999': '+proj=merc +a=6378137 +b=6378137 +units=m +no_defs',
    },
  });
  assert.ok(Math.abs(r.geometry.coordinates[0] - 10) < 1e-8);
  let calls = 0;
  const l = h.fromEsri(
    {
      paths: [
        [
          [100, 200],
          [200, 300],
        ],
      ],
      spatialReference: { wkid: 102999 },
    },
    {
      converter: (xy) => {
        calls++;
        return xy.map((n) => n / 100);
      },
    },
  );
  assert.deepEqual(l.geometry.coordinates, [
    [1, 2],
    [2, 3],
  ]);
  assert.equal(calls, 2);
});
