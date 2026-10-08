import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { curve, compound, curvedPolygon } from './fixtures.js';
for (const g of [curve, compound, curvedPolygon, { type: 'FullGlobe' }])
  test(`SQL-only type: ${g.type}`, () => {
    const r = h.fromSpatial(g);
    assert.equal(r.type, g.type);
    assert.ok(r.wkt.startsWith(g.type.toUpperCase()));
    assert.deepEqual(h.toSqlSpatial(g, { format: 'spatial' }), r);
    assert.throws(
      () => h.fromGeoJSON(g),
      (e) => e.code === 'TYPE',
    );
  });
test('SQL-only empties and curved GeometryCollection', () => {
  for (const g of [
    { type: 'CircularString', coordinates: [] },
    { type: 'CompoundCurve', segments: [] },
    { type: 'CurvePolygon', rings: [] },
  ])
    assert.equal(h.fromSpatial(g).wkt, `${g.type.toUpperCase()} EMPTY`);
  assert.equal(
    h.fromSpatial({ type: 'GeometryCollection', geometries: [curve, compound] })
      .geometry.geometries.length,
    2,
  );
});
test('curved rings preserve explicit orientation', () => {
  const reversed = {
    type: 'CurvePolygon',
    rings: [
      {
        type: 'CircularString',
        coordinates: [...curvedPolygon.rings[0].coordinates].reverse(),
      },
    ],
  };
  const r = h.fromSpatial(reversed);
  assert.deepEqual(r.geometry, reversed);
});
test('invalid curves do not emit SQL', () => {
  const bad = [
    {
      type: 'CircularString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      type: 'CircularString',
      coordinates: [
        [0, 0],
        [1, 1],
        [0, 0],
      ],
    },
    {
      type: 'CompoundCurve',
      segments: [
        curve,
        {
          type: 'LineString',
          coordinates: [
            [3, 0],
            [4, 0],
          ],
        },
      ],
    },
    {
      type: 'CompoundCurve',
      segments: [{ type: 'Point', coordinates: [0, 0] }],
    },
    { type: 'CurvePolygon', rings: [curve] },
  ];
  for (const g of bad) assert.throws(() => h.fromSpatial(g), h.SpatialError);
  assert.throws(() =>
    h.fromSpatial({ type: 'FullGlobe' }, { spatialType: 'geometry' }),
  );
});
test('deliberate large geography interior uses preserve orientation', () => {
  const g = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
  };
  assert.deepEqual(h.fromGeoJSON(g, { orientation: 'preserve' }).geometry, g);
});
