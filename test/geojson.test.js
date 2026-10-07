import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import {
  shell,
  hole,
  square,
  repairs,
  topologyRepairs,
  allTypes,
  globals,
} from './fixtures.js';
import { signedArea } from '../lib/polygons.js';
import { context } from '../lib/common.js';
for (const g of allTypes)
  test(`RFC geometry: ${g.type}`, () => {
    const r = h.fromGeoJSON(g);
    assert.equal(r.type, g.type);
    assert.equal(r.srid, 4326);
    assert.equal(r.spatialType, 'geography');
    assert.ok(r.wkt.startsWith(g.type.toUpperCase()));
    assert.deepEqual(h.fromGeoJSON(g), r);
    assert.equal(r.validation.sqlServerValidated, false);
  });
for (const type of h.GEO_TYPES)
  test(`explicit SQL empty: ${type}`, () => {
    const g =
      type === 'GeometryCollection'
        ? { type, geometries: [] }
        : { type, coordinates: [] };
    assert.equal(h.fromGeoJSON(g).wkt, `${type.toUpperCase()} EMPTY`);
  });
test('exact position order and altitude', () => {
  assert.equal(
    h.fromGeoJSON({ type: 'Point', coordinates: [-83, 43, 12.25] }).wkt,
    'POINT (-83 43 12.25)',
  );
  assert.equal(
    h.fromGeoJSON({
      type: 'LineString',
      coordinates: [
        [0, 0, 1],
        [1, 1, 2],
      ],
    }).wkt,
    'LINESTRING (0 0 1,1 1 2)',
  );
});
test('metadata has no effect on geometry or SQL', () => {
  const a = { type: 'Point', coordinates: [0, 0] };
  assert.deepEqual(
    h.fromGeoJSON({ ...a, bbox: [0, 0, 0, 0], foreign: { hello: 'world' } }),
    h.fromGeoJSON(a),
  );
});
test('FeatureCollection preserves identities and null geometry', () => {
  const r = h.fromGeoJSON({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: '001',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      },
      { type: 'Feature', id: '002', geometry: null, properties: {} },
    ],
  });
  assert.equal(r.length, 2);
  assert.equal(r[0].id, '001');
  assert.equal(r[1].spatial, null);
  assert.deepEqual(h.fromGeoJSON({ type: 'FeatureCollection', features: [] }), []);
  assert.throws(
    () =>
      h.fromGeoJSON(
        {
          type: 'FeatureCollection',
          features: [{ type: 'Point', coordinates: [0, 0] }],
        },
        { onError: 'throw' },
      ),
    /Features/,
  );
  assert.throws(() => h.fromGeoJSON({ type: 'Feature' }), /missing geometry/);
});
test('nested collections preserve component hierarchy', () => {
  const r = h.fromGeoJSON({
    type: 'GeometryCollection',
    geometries: [{ type: 'GeometryCollection', geometries: allTypes.slice(0, 2) }],
  });
  assert.equal(r.geometry.geometries[0].geometries.length, 2);
});
test('safe repair closes rings and removes exact duplicate vertices', () => {
  assert.ok(
    h.fromGeoJSON(repairs.unclosed).diagnostics.some((d) => d.code === 'CLOSED_RING'),
  );
  const r = h.fromGeoJSON(repairs.consecutiveDuplicate);
  assert.equal(r.geometry.coordinates[0].length, 5);
  assert.ok(r.diagnostics.some((d) => d.code === 'DEDUPLICATED'));
});
test('shell and hole corrected independently', () => {
  const r = h.fromGeoJSON(repairs.wrongWinding);
  assert.ok(signedArea(r.geometry.coordinates[0], context()) > 0);
  assert.ok(signedArea(r.geometry.coordinates[1], context()) < 0);
  assert.equal(r.diagnostics.filter((d) => d.code === 'REWOUND').length, 2);
});
for (const name of topologyRepairs) {
  test(`explicit local topology repair: ${name}`, () => {
    assert.throws(
      () => h.fromGeoJSON(repairs[name]),
      (e) => e.code === 'TOPOLOGY',
    );
    const r = h.fromGeoJSON(repairs[name], { repair: 'topology' });
    assert.ok(['Polygon', 'MultiPolygon'].includes(r.type));
    assert.ok(r.diagnostics.some((d) => d.code === 'TOPOLOGY_REPAIRED'));
    assert.doesNotThrow(() => h.fromGeoJSON(r.geometry));
  });
}
test('bow-tie split retains both lobes', () => {
  const r = h.fromGeoJSON(repairs.bowtie, { repair: 'topology' });
  assert.equal(r.type, 'MultiPolygon');
  assert.equal(r.geometry.coordinates.length, 2);
});
test('island inside a hole is a valid separate polygon', () => {
  assert.equal(h.fromGeoJSON(repairs.island).geometry.coordinates.length, 2);
});
test('topology repair cannot silently discard Z', () => {
  const g = structuredClone(repairs.bowtie);
  g.coordinates[0] = g.coordinates[0].map((v) => [...v, 1]);
  assert.throws(
    () => h.fromGeoJSON(g, { repair: 'topology' }),
    (e) => e.code === 'REPAIR_DIMENSION',
  );
});
for (const g of globals)
  test(`geodesic winding supports ${g.name}`, () => {
    const r = h.fromGeoJSON(g.geometry);
    assert.ok(signedArea(r.geometry.coordinates[0], context()) > 0);
    const reversed = {
      type: 'Polygon',
      coordinates: [[...g.geometry.coordinates[0]].reverse()],
    };
    assert.ok(
      signedArea(h.fromGeoJSON(reversed).geometry.coordinates[0], context()) > 0,
    );
  });
test('strict repair policy rejects fixable malformed input', () => {
  for (const g of [
    repairs.unclosed,
    repairs.consecutiveDuplicate,
    repairs.wrongWinding,
  ])
    assert.throws(() => h.fromGeoJSON(g, { repair: 'none' }));
});
const badPoints = [
  ['string', ['0', 0]],
  ['null', [0, null]],
  ['NaN', [NaN, 0]],
  ['Infinity', [0, Infinity]],
  ['4D', [0, 0, 1, 2]],
  ['short', [0]],
  ['longitude', [181, 0]],
  ['latitude', [0, 91]],
];
for (const [name, coordinates] of badPoints)
  test(`bad position rejected: ${name}`, () =>
    assert.throws(() => h.fromGeoJSON({ type: 'Point', coordinates }), h.SpatialError));
test('malformed shapes and collapsed geometry rejected', () => {
  for (const g of [
    { type: 'NotAGeometry', coordinates: [] },
    { type: 'Point', coordinates: {} },
    { type: 'LineString', coordinates: [[0, 0]] },
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0, 0],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [2, 0],
          [0, 0],
        ],
      ],
    },
    { type: 'Polygon', coordinates: [[]] },
    { type: 'MultiPolygon', coordinates: [[]] },
    { type: 'GeometryCollection', geometries: [null] },
  ])
    assert.throws(() => h.fromGeoJSON(g), h.SpatialError);
});
test('no guessing of mixed dimensions, CRS or antipodal edges', () => {
  assert.throws(
    () =>
      h.fromGeoJSON({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1, 2],
        ],
      }),
    (e) => e.code === 'DIMENSION',
  );
  assert.throws(
    () => h.fromGeoJSON({ type: 'Point', coordinates: [0, 0], crs: {} }),
    (e) => e.code === 'CRS',
  );
  assert.throws(
    () =>
      h.fromGeoJSON({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [180, 0],
        ],
      }),
    (e) => e.code === 'ANTIPODAL',
  );
});
test('limits and options fail explicitly', () => {
  assert.throws(
    () => h.fromGeoJSON(allTypes[1], { maxPositions: 1 }),
    (e) => e.code === 'LIMIT',
  );
  assert.throws(
    () =>
      h.fromGeoJSON(
        {
          type: 'GeometryCollection',
          geometries: [{ type: 'GeometryCollection', geometries: [allTypes[0]] }],
        },
        { maxDepth: 1 },
      ),
    (e) => e.code === 'LIMIT',
  );
  for (const o of [
    { repair: 'guess' },
    { spatialType: 'anything' },
    { srid: -1 },
    { srid: 3857 },
    { maxDepth: 0 },
    { orientation: 'guess' },
  ])
    assert.throws(() => h.fromGeoJSON(allTypes[0], o));
});
test('projection explicit and geometry target remains planar', () => {
  const r = h.fromGeoJSON(
    { type: 'Point', coordinates: [1113194.9079327357, 0] },
    { sourceCrs: 'EPSG:3857' },
  );
  assert.ok(Math.abs(r.geometry.coordinates[0] - 10) < 1e-8);
  const p = h.fromGeoJSON(
    { type: 'Point', coordinates: [1000000, 5000000] },
    { spatialType: 'geometry', srid: 3857 },
  );
  assert.equal(p.wkt, 'POINT (1000000 5000000)');
  assert.throws(
    () => h.fromGeoJSON(allTypes[0], { sourceCrs: 'invalid' }),
    (e) => e.code === 'CRS',
  );
  assert.throws(
    () =>
      h.fromGeoJSON(allTypes[0], {
        spatialType: 'geometry',
        sourceCrs: 'EPSG:4326',
      }),
    (e) => e.code === 'CRS',
  );
});
test('SQL binding is separate and parameter names are checked', () => {
  const r = h.fromGeoJSON(allTypes[0]);
  assert.deepEqual(h.sqlBinding(r), {
    expression: 'geography::STGeomFromText(@wkt, @srid)',
    parameters: {
      wkt: { type: 'NVarChar(MAX)', value: 'POINT (0 0)' },
      srid: { type: 'Int', value: 4326 },
    },
  });
  assert.throws(
    () => h.sqlBinding(r, { wktParameter: 'x); DROP' }),
    (e) => e.code === 'BINDING',
  );
  assert.throws(
    () => h.sqlBinding(r, { wktParameter: 'x', sridParameter: 'x' }),
    (e) => e.code === 'BINDING',
  );
  assert.throws(
    () => h.sqlBinding(null),
    (e) => e.code === 'BINDING',
  );
});
test('deeply frozen input is preserved', () => {
  const g = { type: 'Polygon', coordinates: [square().slice(0, -1)] };
  const freeze = (o) => {
    Object.freeze(o);
    Object.values(o).forEach((v) => {
      if (v && typeof v === 'object') freeze(v);
    });
  };
  freeze(g);
  assert.doesNotThrow(() => h.fromGeoJSON(g));
  assert.equal(g.coordinates[0].length, 4);
});
