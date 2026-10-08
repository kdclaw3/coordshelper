import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromSpatial,
  fromEsri,
  fromGeoJSON,
  fromFeatureSet,
  SpatialError,
} from '../index.js';
import { context } from '../lib/common.js';
import { normalizePolygons, classifyRings } from '../lib/polygons.js';
import { candidatePairs, bounds } from '../lib/topology.js';
import { square } from './fixtures.js';

const overlappingRing = [
  [0, 0],
  [2, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];
const circle = (size, radius = 1) => {
  const ring = Array.from({ length: size }, (_, i) => [
    radius * Math.cos((i * 2 * Math.PI) / size),
    radius * Math.sin((i * 2 * Math.PI) / size),
  ]);
  ring.push(ring[0]);
  return ring;
};
const options = { spatialType: 'geometry', repair: 'topology' };

test('FOLLOWUP-03: repaired straight curved rings fail with indexed SpatialError', () => {
  for (const convert of [
    () =>
      fromSpatial(
        {
          type: 'CurvePolygon',
          rings: [{ type: 'LineString', coordinates: overlappingRing }],
        },
        options,
      ),
    () => fromEsri({ curveRings: [overlappingRing] }, options),
  ])
    assert.throws(
      convert,
      (e) =>
        e instanceof SpatialError &&
        e.code === 'CURVE_REPAIR' &&
        e.path.includes('rings[0]'),
    );
});
test('FOLLOWUP-04: unexpected collection failures retain cause in both modes', () => {
  const original = new TypeError('synthetic getter failure');
  const feature = {
    get geometry() {
      throw original;
    },
  };
  const result = fromFeatureSet({ features: [feature] });
  assert.equal(result[0].error.code, 'INTERNAL');
  assert.equal(result[0].error.cause, original);
  assert.equal(result[0].error.path, '$.features[0]');
  assert.throws(
    () => fromFeatureSet({ features: [feature] }, { onError: 'throw' }),
    (e) => e.cause === original,
  );
});
test('FOLLOWUP-05: vertical lines and tall rings fit the default budget', () => {
  const line = Array.from({ length: 3000 }, (_, i) => [0, i / 3000]);
  assert.equal(
    fromGeoJSON({ type: 'LineString', coordinates: line }).type,
    'LineString',
  );
  const ring = circle(3000).map(([x, y]) => [x / 100, y]);
  assert.equal(fromGeoJSON({ type: 'Polygon', coordinates: [ring] }).type, 'Polygon');
});
test('FOLLOWUP-06: large holes and Esri nesting fit the default budget', () => {
  const rings = [circle(2000), circle(500, 0.5)];
  assert.equal(fromGeoJSON({ type: 'Polygon', coordinates: rings }).type, 'Polygon');
  assert.equal(fromEsri({ rings }).type, 'Polygon');
});
test('FOLLOWUP-07: cross-group join does not recheck within-group segment pairs', () => {
  const ctx = context({ maxTopologyChecks: 10 });
  const items = Array.from({ length: 100 }, () => ({
    group: 0,
    box: bounds([
      [0, 0],
      [1, 1],
    ]),
  }));
  items.push({
    group: 1,
    box: bounds([
      [2, 0],
      [3, 1],
    ]),
  });
  assert.equal([...candidatePairs(items, ctx, '$.rings', true)].length, 0);
  assert.ok(ctx.topologyChecks <= 10);
});
test('FOLLOWUP-07/11: repeated ring validation and Esri normalization reuse completed work', () => {
  const rings = [circle(150), circle(50, 0.5)];
  const ctx = context({ spatialType: 'geometry' });
  const polys = classifyRings(rings, ctx, '$.rings');
  const before = ctx.topologyChecks;
  normalizePolygons(polys, 'Polygon', ctx, '$.rings');
  const after = ctx.topologyChecks;
  normalizePolygons(polys, 'Polygon', ctx, '$.rings');
  assert.equal(ctx.topologyChecks, after);
  assert.equal(after, before);
});
test('FOLLOWUP-09: empty multipoint members have indexed diagnostics', () => {
  const r = fromEsri({ points: [[], [0, 0], [null, null]] });
  assert.equal(r.wkt, 'MULTIPOINT (0 0)');
  assert.deepEqual(
    r.diagnostics.map((d) => d.path),
    ['$.points[0]', '$.points[2]'],
  );
  assert.ok(r.diagnostics.every((d) => d.code === 'EMPTY_POINT_OMITTED'));
  assert.equal(fromEsri({ points: [[]] }).wkt, 'MULTIPOINT EMPTY');
  assert.throws(() => fromEsri({ points: [[0, 'NaN']] }), SpatialError);
});
test('FOLLOWUP-10: verified Esri codes below 100000 keep their authority', () => {
  const definition = '+proj=longlat +datum=WGS84 +no_defs';
  for (const wkid of [37001, 53004, 54030]) {
    const result = fromEsri(
      { x: 1, y: 2, spatialReference: { wkid } },
      { projectionDefinitions: { [`ESRI:${wkid}`]: definition } },
    );
    assert.deepEqual(result.geometry.coordinates, [1, 2]);
  }
  assert.throws(
    () => fromEsri({ x: 1, y: 2, spatialReference: { wkid: 12345 } }),
    (e) => e.code === 'CRS' && /authority/.test(e.message),
  );
});
test('FOLLOWUP-12: ring and containment budget errors retain input paths', () => {
  assert.throws(
    () => fromEsri({ rings: [circle(20)] }, { maxTopologyChecks: 1 }),
    (e) => e.code === 'LIMIT' && e.path.includes('rings[0]'),
  );
  assert.throws(
    () =>
      fromGeoJSON(
        { type: 'Polygon', coordinates: [circle(100), circle(20, 0.5)] },
        { maxTopologyChecks: 100 },
      ),
    (e) => e.code === 'LIMIT' && e.path.startsWith('$.coordinates['),
  );
});

test('interval candidate index agrees with exhaustive box intersection under rotations', () => {
  // Deterministic synthetic rectangles, including ties, point boxes and overlapping extents.
  const boxes = Array.from({ length: 100 }, (_, i) => {
    const x = (i * 17) % 31,
      y = (i * 23) % 37;
    return {
      group: i % 2,
      box: bounds([
        [x, y],
        [x + (i % 5), y + (i % 7)],
      ]),
    };
  });
  for (const rotated of [false, true])
    for (const crossOnly of [false, true]) {
      const items = boxes.map(({ group, box }) => ({
        group,
        box: rotated
          ? { xmin: box.ymin, xmax: box.ymax, ymin: box.xmin, ymax: box.xmax }
          : box,
      }));
      const expected = [];
      for (let i = 0; i < items.length; i++)
        for (let j = 0; j < i; j++) {
          const a = items[i],
            b = items[j];
          if (
            (!crossOnly || a.group !== b.group) &&
            a.box.xmin <= b.box.xmax &&
            b.box.xmin <= a.box.xmax &&
            a.box.ymin <= b.box.ymax &&
            b.box.ymin <= a.box.ymax
          )
            expected.push(`${j}:${i}`);
        }
      const actual = [...candidatePairs(items, context({}), '$.boxes', crossOnly)].map(
        ([a, b]) => [a.index, b.index].sort((x, y) => x - y).join(':'),
      );
      assert.deepEqual(actual.sort(), expected.sort());
    }
});
test('containment preserves touching, nested-hole and island decisions', () => {
  const shell = square(0, 0, 4);
  const touchingHole = [
    [0, 2],
    [1, 1],
    [2, 2],
    [1, 3],
    [0, 2],
  ];
  assert.equal(
    fromGeoJSON({ type: 'Polygon', coordinates: [shell, touchingHole] }).type,
    'Polygon',
  );
  const outsideTouch = [
    [0, 2],
    [-1, 1],
    [-2, 2],
    [-1, 3],
    [0, 2],
  ];
  assert.throws(
    () => fromGeoJSON({ type: 'Polygon', coordinates: [shell, outsideTouch] }),
    (e) => e.code === 'TOPOLOGY',
  );
  const hole = square(1, 1, 2),
    island = square(1.5, 1.5, 0.5);
  assert.equal(
    fromGeoJSON({ type: 'MultiPolygon', coordinates: [[shell, hole], [island]] }).type,
    'MultiPolygon',
  );
  assert.throws(
    () => fromGeoJSON({ type: 'Polygon', coordinates: [shell, hole, island] }),
    (e) => e.code === 'TOPOLOGY',
  );
});
test('spatial caches are per conversion and failed checks never become success', () => {
  const rings = [circle(30), circle(15, 0.5)];
  const first = fromGeoJSON({ type: 'Polygon', coordinates: rings });
  const again = fromGeoJSON({ type: 'Polygon', coordinates: rings });
  assert.deepEqual(first, again);
  assert.throws(
    () =>
      fromGeoJSON({ type: 'Polygon', coordinates: rings }, { maxTopologyChecks: 1 }),
    (e) => e.code === 'LIMIT',
  );
  rings[1][5] = [4, 4];
  assert.throws(
    () => fromGeoJSON({ type: 'Polygon', coordinates: rings }),
    (e) => e.code === 'TOPOLOGY',
  );
});
test('Esri disjoint shell normalization reuses directed containment checks', () => {
  for (const spatialType of ['geometry', 'geography']) {
    const rings = [square(), square(3, 3), square(6, 6)];
    const ctx = context({ spatialType });
    const polygons = classifyRings(rings, ctx, '$.rings');
    const before = ctx.topologyChecks;
    assert.equal(
      normalizePolygons(polygons, 'MultiPolygon', ctx, '$.rings').type,
      'MultiPolygon',
    );
    assert.equal(ctx.topologyChecks, before);
  }
});
test('authority conflicts require explicit resolution and preserve native unknown SRIDs', () => {
  const g = { x: 1, y: 2, spatialReference: { wkid: 54030 } };
  const definition = '+proj=longlat +datum=WGS84 +no_defs';
  const projectionDefinitions = { 'ESRI:54030': definition, 'EPSG:54030': definition };
  assert.throws(
    () => fromEsri(g, { projectionDefinitions }),
    (e) => e.code === 'CRS',
  );
  assert.equal(
    fromEsri(g, { projectionDefinitions, wkidAuthorities: { 54030: 'ESRI' } }).type,
    'Point',
  );
  assert.equal(
    fromEsri(
      { x: 1, y: 2, spatialReference: { wkid: 12345 } },
      { spatialType: 'geometry', project: false },
    ).srid,
    12345,
  );
  assert.throws(
    () => fromEsri(g, { wkidAuthorities: [] }),
    (e) => e.code === 'CRS',
  );
});
test('projection callback errors preserve their cause after feature path decoration', () => {
  const original = new Error('converter sentinel');
  const result = fromFeatureSet(
    { features: [{ geometry: { x: 1, y: 2 } }] },
    {
      converter: () => {
        throw original;
      },
    },
  );
  assert.equal(result[0].error.code, 'CRS');
  assert.equal(result[0].error.cause, original);
  assert.equal(result[0].error.path, '$.features[0].coordinates');
});

test('dense axis-aligned edges in overlapping part boxes remain supported', () => {
  const densify = (vertices) => {
    const result = [];
    vertices.forEach((a, i) => {
      const b = vertices[(i + 1) % vertices.length];
      for (let j = 0; j < 1000; j++)
        result.push([
          a[0] + ((b[0] - a[0]) * j) / 1000,
          a[1] + ((b[1] - a[1]) * j) / 1000,
        ]);
    });
    result.push(result[0]);
    return result;
  };
  const coordinates = [
    [
      densify([
        [0, 0],
        [4, 0],
        [0, 4],
      ]),
    ],
    [
      densify([
        [4, 4],
        [1, 4],
        [4, 1],
      ]),
    ],
  ];
  const result = fromGeoJSON({ type: 'MultiPolygon', coordinates });
  assert.equal(result.type, 'MultiPolygon');
  assert.equal(result.geometry.coordinates[0][0].length, coordinates[0][0].length);
  assert.equal(result.geometry.coordinates[1][0].length, coordinates[1][0].length);
});
