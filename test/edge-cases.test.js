import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { square, shell, hole, globals } from './fixtures.js';
test('bounded topology verification fails before excessive comparisons', () => {
  assert.throws(
    () =>
      h.fromGeoJSON(
        { type: 'Polygon', coordinates: [shell, hole] },
        { maxTopologyChecks: 1 },
      ),
    (e) => e.code === 'LIMIT',
  );
});
test('FullGlobe is never nested in a collection', () => {
  assert.throws(
    () =>
      h.fromSpatial({
        type: 'GeometryCollection',
        geometries: [{ type: 'FullGlobe' }],
      }),
    (e) => e.code === 'TYPE',
  );
});
test('3D polygon and line preserve altitude and reject inconsistent closure', () => {
  const r = h.fromGeoJSON({
    type: 'Polygon',
    coordinates: [square().map(([x, y]) => [x, y, 10])],
  });
  assert.ok(r.geometry.coordinates[0].every((p) => p[2] === 10));
  const c = square().map(([x, y]) => [x, y, 10]);
  c.at(-1)[2] = 20;
  assert.throws(
    () => h.fromGeoJSON({ type: 'Polygon', coordinates: [c] }),
    (e) => e.code === 'CLOSURE',
  );
  assert.throws(
    () =>
      h.fromGeoJSON({
        type: 'LineString',
        coordinates: [
          [0, 0, 1],
          [0, 0, 2],
          [1, 1, 3],
        ],
      }),
    (e) => e.code === 'DIMENSION',
  );
});
test('empty and absent inputs remain distinguishable', () => {
  assert.equal(h.fromGeoJSON(null), null);
  assert.equal(
    h.fromGeoJSON({ type: 'Feature', geometry: null, properties: {} }),
    null,
  );
  assert.equal(h.fromGeoJSON({ type: 'Point', coordinates: [] }).wkt, 'POINT EMPTY');
});
test('polar/global repair refuses planar clipping and preserved topology refuses guessing', () => {
  assert.throws(
    () => h.fromGeoJSON(globals[1].geometry, { repair: 'topology' }),
    (e) => e.code === 'GLOBAL_REPAIR',
  );
  const bow = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ],
    ],
  };
  assert.throws(
    () => h.fromGeoJSON(bow, { repair: 'topology', orientation: 'preserve' }),
    (e) => e.code === 'GLOBAL_REPAIR',
  );
});
test('geometry projection explicitly uses its own target CRS', () => {
  const r = h.fromGeoJSON(
    { type: 'Point', coordinates: [10, 0] },
    {
      spatialType: 'geometry',
      srid: 3857,
      sourceCrs: 'EPSG:4326',
      targetCrs: 'EPSG:3857',
    },
  );
  assert.ok(Math.abs(r.geometry.coordinates[0] - 1113194.9079327357) < 1e-6);
});
test('parameterized target cannot be overridden by untrusted spatial type', () => {
  const r = h.fromGeoJSON({ type: 'Point', coordinates: [0, 0] });
  assert.throws(
    () => h.sqlBinding({ ...r, spatialType: 'geography; anything' }),
    (e) => e.code === 'BINDING',
  );
  assert.equal(
    h.sqlBinding(r, { wktParameter: 'geo_text', sridParameter: 'geo_srid' }).expression,
    'geography::STGeomFromText(@geo_text, @geo_srid)',
  );
});
// Deterministic metamorphic cases check behavior across positions and input winding.
for (const x of [-179, -83, 0, 120])
  for (const y of [-60, 0, 43])
    test(`translated shell/hole, both windings ${x}/${y}`, () => {
      const outer = square(x, y, 0.5),
        inner = square(x + 0.1, y + 0.1, 0.2);
      const a = h.fromGeoJSON({ type: 'Polygon', coordinates: [outer, inner] });
      const b = h.fromGeoJSON({
        type: 'Polygon',
        coordinates: [[...outer].reverse(), [...inner].reverse()],
      });
      assert.deepEqual(a.geometry, b.geometry);
      assert.equal(a.geometry.coordinates[0].length, 5);
      assert.equal(a.geometry.coordinates[1].length, 5);
    });
