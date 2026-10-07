import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { square, shell, hole } from './fixtures.js';
test('Esri point, multipoint, paths and envelope', () => {
  assert.equal(h.fromEsri({ x: 0, y: 0 }).wkt, 'POINT (0 0)');
  assert.equal(
    h.fromEsri({
      points: [
        [0, 0],
        [1, 1],
      ],
    }).wkt,
    'MULTIPOINT (0 0,1 1)',
  );
  assert.equal(
    h.fromEsri({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    }).type,
    'MultiLineString',
  );
  assert.equal(h.fromEsri({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }).type, 'Polygon');
});
test('Esri shuffled holes, disjoint shells and nested island', () => {
  const r = h.fromEsri({
    rings: [hole, square(8, 8), square(1.5, 1.5, 0.5), shell],
  });
  assert.equal(r.type, 'MultiPolygon');
  assert.equal(r.geometry.coordinates.length, 3);
  const main = r.geometry.coordinates.find((p) => p.length === 2);
  assert.ok(main);
  assert.equal(main[0].length, 5);
  assert.equal(main[1].length, 5);
});
test('Esri shell/hole role does not depend on supplied winding', () => {
  assert.equal(
    h.fromEsri({ rings: [[...shell].reverse(), [...hole].reverse()] }).geometry
      .coordinates.length,
    2,
  );
});
test('Esri FeatureSet uses service metadata and preserves IDs/null features', () => {
  const r = h.fromEsri({
    geometryType: 'esriGeometryPoint',
    spatialReference: { wkid: 102100 },
    features: [
      {
        attributes: { GlobalID: 'abc' },
        geometry: { x: 1113194.9079327357, y: 0 },
      },
      { attributes: { OBJECTID: 2 }, geometry: null },
    ],
  });
  assert.equal(r[0].id, 'abc');
  assert.ok(Math.abs(r[0].spatial.geometry.coordinates[0] - 10) < 1e-8);
  assert.equal(r[1].spatial, null);
});
test('Esri latestWkid and explicit projection override', () => {
  const r = h.fromEsri({
    x: 10,
    y: 0,
    spatialReference: { wkid: 102100, latestWkid: 4326 },
  });
  assert.equal(r.wkt, 'POINT (10 0)');
  assert.equal(
    h.fromEsri(
      { x: 10, y: 0, spatialReference: { wkid: 99999 } },
      { sourceCrs: 'EPSG:4326' },
    ).wkt,
    'POINT (10 0)',
  );
});
test('Esri Z/M point and M-only paths preserve measure as SQL NULL Z', () => {
  assert.equal(h.fromEsri({ x: 0, y: 0, z: 3, m: 4 }).wkt, 'POINT (0 0 3 4)');
  assert.equal(h.fromEsri({ x: 0, y: 0, m: 4 }).wkt, 'POINT (0 0 NULL 4)');
  assert.equal(
    h.fromEsri(
      {
        paths: [
          [
            [0, 0, 4],
            [1, 1, 5],
          ],
        ],
      },
      { hasM: true, hasZ: false },
    ).wkt,
    'LINESTRING (0 0 NULL 4,1 1 NULL 5)',
  );
});
test('Esri circular arcs convert without approximation', () => {
  const r = h.fromEsri({
    curvePaths: [
      [
        [0, 0],
        {
          c: [
            [2, 0],
            [1, 1],
          ],
        },
        [3, 0],
      ],
    ],
  });
  assert.equal(r.wkt, 'COMPOUNDCURVE (CIRCULARSTRING (0 0,1 1,2 0),(2 0,3 0))');
  assert.ok(r.diagnostics.some((d) => d.code === 'SQL_VALIDATION_REQUIRED'));
});
test('Esri multi-curve paths and curve rings', () => {
  assert.equal(
    h.fromEsri({
      curvePaths: [
        [
          [0, 0],
          {
            c: [
              [2, 0],
              [1, 1],
            ],
          },
        ],
        [
          [4, 0],
          {
            c: [
              [6, 0],
              [5, 1],
            ],
          },
        ],
      ],
    }).type,
    'GeometryCollection',
  );
  const r = h.fromEsri({
    curveRings: [
      [
        [2, 1],
        {
          c: [
            [0, 1],
            [1, 2],
          ],
        },
        {
          c: [
            [2, 1],
            [1, 0],
          ],
        },
      ],
    ],
    spatialReference: { wkid: 4326 },
  });
  assert.equal(r.type, 'CurvePolygon');
});
test('Esri invalid and ambiguous shapes fail explicitly', () => {
  for (const g of [
    { x: 0 },
    { rings: [[]] },
    { rings: [shell, square(3, 3, 2)] },
    {
      curvePaths: [
        [
          [0, 0],
          {
            b: [
              [2, 0],
              [1, 1],
              [1, 0],
            ],
          },
        ],
      ],
    },
    { curvePaths: [[[0, 0], { a: [[2, 0], [1, 1], 0, 0, 1] }]] },
    { xmin: 1, ymin: 0, xmax: 0, ymax: 1 },
    { x: 0, y: 0, spatialReference: { wkid: '4326' } },
    {},
  ])
    assert.throws(() => h.fromEsri(g), h.SpatialError);
  assert.throws(
    () =>
      h.fromEsri({
        curvePaths: [
          [
            [0, 0],
            {
              c: [
                [2, 0],
                [1, 1],
              ],
            },
          ],
        ],
        spatialReference: { wkid: 3857 },
      }),
    (e) => e.code === 'CURVE_CRS',
  );
});
test('no mutation or shape loss through auto-detection', () => {
  const g = {
    geometry: {
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
      type: 'esriGeometryPolyline',
    },
  };
  const before = structuredClone(g);
  assert.equal(h.toSqlSpatial(g).type, 'MultiLineString');
  assert.deepEqual(g, before);
});
test('unambiguous single Esri bow-tie shell is repairable locally', () => {
  const g = {
    rings: [
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
    () => h.fromEsri(g),
    (e) => e.code === 'TOPOLOGY',
  );
  assert.equal(h.fromEsri(g, { repair: 'topology' }).geometry.coordinates.length, 2);
});
test('Esri M-only circular path does not silently become altitude', () => {
  const r = h.fromEsri({
    hasM: true,
    hasZ: false,
    curvePaths: [
      [
        [0, 0, 4],
        {
          c: [
            [2, 0, 6],
            [1, 1, 5],
          ],
        },
      ],
    ],
  });
  assert.equal(r.wkt, 'CIRCULARSTRING (0 0 NULL 4,1 1 NULL 5,2 0 NULL 6)');
});
