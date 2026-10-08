/** Contract regressions recorded before the consolidated v2 corrections. */
import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import * as h from '../index.js';
import { candidatePairs, bounds } from '../lib/topology.js';
import { context } from '../lib/common.js';
import { spawnSync } from 'node:child_process';

const planar = { spatialType: 'geometry' };
const circle = (n, radius, cx = 0) => {
  const r = Array.from({ length: n }, (_, i) => [
    cx + radius * Math.cos((i * 2 * Math.PI) / n),
    radius * Math.sin((i * 2 * Math.PI) / n),
  ]);
  r.push(r[0]);
  return r;
};
const wkt2 =
  'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]],CS[ellipsoidal,2],AXIS["longitude",east],AXIS["latitude",north],ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",4326]]';

test('SQL numeric serialization avoids overlong decimals without rounding coordinates', () => {
  for (const number of [6.123233995736766e-17, 1e-100, Number.MIN_VALUE, 1e100]) {
    const result = h.fromGeoJSON({ type: 'Point', coordinates: [number, 0] }, planar);
    assert.equal(result.wkt, `POINT (${String(number)} 0)`);
    assert.equal(result.geometry.coordinates[0], number);
  }
  assert.equal(
    h.fromGeoJSON({ type: 'Point', coordinates: [1e-8, 0] }).wkt,
    'POINT (0.00000001 0)',
  );
});

test('CORRECTION-F: shared projection survives null and malformed leading features', () => {
  for (const first of [null, { geometry: null }, { geometry: { x: null } }]) {
    const results = h.fromFeatureSet(
      {
        features: [
          first,
          {
            geometry: { x: 1113194.9079327357, y: 0, spatialReference: { wkid: 3857 } },
          },
          { geometry: { x: 1113194.9079327357, y: 0 } },
        ],
        geometryType: 'esriGeometryPoint',
      },
      { ...planar, targetCrs: 'EPSG:4326' },
    );
    assert.equal(results[1].spatial.wkt, 'POINT (10 0)');
    assert.equal(results[2].spatial.wkt, 'POINT (10 0)');
  }
});
test('CORRECTION-H: WKT2-only definitions are read and projected', () => {
  assert.equal(
    h.fromEsri({ x: 10, y: 20, spatialReference: { wkt2 } }).wkt,
    'POINT (10 20)',
  );
  assert.throws(
    () => h.fromEsri({ x: 10, y: 20, spatialReference: { wkt2: 'broken' } }),
    (e) => e.code === 'CRS',
  );
});
test('CORRECTION-D: ambient projection registration cannot change authority resolution', () => {
  const input = { x: 1, y: 1, spatialReference: { wkid: 77701 } };
  assert.throws(
    () => h.fromEsri(input),
    (e) => e.code === 'CRS',
  );
  proj4.defs('EPSG:77701', '+proj=longlat +datum=WGS84 +no_defs');
  assert.throws(
    () => h.fromEsri(input),
    (e) => e.code === 'CRS',
  );
  assert.equal(
    h.fromEsri(input, {
      projectionDefinitions: { 'ESRI:77701': '+proj=longlat +datum=WGS84 +no_defs' },
    }).wkt,
    'POINT (1 1)',
  );
});
test('CORRECTION-D: built-in projection ignores an overwritten ambient definition', () => {
  const old = proj4.defs('EPSG:3857');
  try {
    proj4.defs('EPSG:3857', '+proj=longlat +datum=WGS84 +no_defs');
    assert.equal(
      h.fromEsri({ x: 1113194.9079327357, y: 0, spatialReference: { wkid: 3857 } }).wkt,
      'POINT (10 0)',
    );
  } finally {
    proj4.defs('EPSG:3857', old);
  }
});
test('CORRECTION-B: disjoint many-part lines fit the default work budget', () => {
  const coordinates = Array.from({ length: 300 }, (_, p) =>
    Array.from({ length: 51 }, (_, i) => [i * 20, p / 100]),
  );
  for (const rotated of [false, true]) {
    const input = rotated
      ? coordinates.map((r) => r.map(([x, y]) => [y, x]))
      : coordinates;
    const result = h.fromGeoJSON(
      { type: 'MultiLineString', coordinates: input },
      planar,
    );
    assert.equal(result.geometry.coordinates.length, 300);
    assert.ok(result.validation.topologyChecks < 1000000);
  }
});
test('CORRECTION-B: index matches exhaustive intersections across many groups', () => {
  const items = Array.from({ length: 240 }, (_, i) => ({
    group: i % 30,
    box: bounds([
      [i % 17, i % 13],
      [(i % 17) + (i % 4), (i % 13) + (i % 5)],
    ]),
  }));
  for (const crossOnly of [false, true]) {
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
      ([a, b]) => [a.index, b.index].sort((a, b) => a - b).join(':'),
    );
    assert.deepEqual(actual.sort(), expected.sort());
  }
});
test('CORRECTION-C: large touching hole fits the default budget without changing topology', () => {
  const result = h.fromGeoJSON(
    { type: 'Polygon', coordinates: [circle(2000, 2), circle(500, 0.5, 1.5)] },
    planar,
  );
  assert.equal(result.geometry.coordinates.length, 2);
  assert.ok(result.validation.topologyChecks < 1000000);
});
test('CORRECTION-validation: sparse coordinates and geometry members are rejected', () => {
  for (const input of [
    { type: 'Point', coordinates: new Array(2) },
    { type: 'MultiPoint', coordinates: new Array(1) },
    { type: 'GeometryCollection', geometries: new Array(1) },
  ])
    assert.throws(
      () => h.fromGeoJSON(input),
      (e) => e instanceof h.SpatialError && e.path.includes('[0]'),
    );
  assert.throws(
    () => h.fromFeatureSet({ features: new Array(1) }),
    (e) => e instanceof h.SpatialError && e.path === '$.features[0]',
  );
});
test('CORRECTION-limits: empty components count toward a finite component budget', () => {
  const input = {
    type: 'GeometryCollection',
    geometries: Array.from({ length: 100 }, () => ({ type: 'Point', coordinates: [] })),
  };
  assert.throws(
    () => h.fromGeoJSON(input, { maxComponents: 10 }),
    (e) => e.code === 'LIMIT' && e.path.includes('geometries'),
  );
});
test('CORRECTION-errors: projection setup retains its cause', () => {
  assert.throws(
    () =>
      h.fromGeoJSON(
        { type: 'Point', coordinates: [0, 0] },
        { sourceCrs: '+proj=not_a_projection' },
      ),
    (e) => e.code === 'CRS' && e.cause !== undefined,
  );
});
test('CORRECTION-iterator: lazy FeatureSet results match the eager API and stop early', () => {
  let seen = 0;
  const input = {
    spatialReference: { wkid: 4326 },
    features: [
      { geometry: { x: 1, y: 2 } },
      {
        get geometry() {
          seen++;
          return { x: 3, y: 4 };
        },
      },
    ],
  };
  const iterator = h.iterateFeatureSet(input);
  assert.equal(iterator.next().value.spatial.wkt, 'POINT (1 2)');
  iterator.return();
  assert.equal(seen, 0);
  const regular = {
    spatialReference: { wkid: 4326 },
    features: [{ geometry: { x: 1, y: 2 } }, { geometry: { x: 'bad', y: 4 } }],
  };
  const summarize = (r) =>
    r.map((v) => ({ wkt: v.spatial?.wkt, code: v.error?.code, path: v.error?.path }));
  assert.deepEqual(
    summarize([...h.iterateFeatureSet(regular)]),
    summarize(h.fromFeatureSet(regular)),
  );
});
test('CORRECTION-batch: aggregate position and WKT byte limits stop collection processing', () => {
  const input = {
    type: 'FeatureCollection',
    features: Array.from({ length: 3 }, () => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
    })),
  };
  assert.throws(
    () => h.fromGeoJSON(input, { maxTotalPositions: 2 }),
    (e) => e.code === 'LIMIT' && e.path === '$.features[2]',
  );
  assert.throws(
    () => h.fromGeoJSON(input, { maxTotalWktBytes: 1 }),
    (e) => e.code === 'LIMIT',
  );
});
test('CORRECTION-B: many disjoint Esri curve rings fit the default budget', () => {
  const curveRings = Array.from({ length: 250 }, (_, part) => {
    const corners = [
      [part * 3, 0],
      [part * 3 + 1, 0],
      [part * 3 + 1, 1],
      [part * 3, 1],
    ];
    const ring = [];
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % 4];
      for (let j = 0; j < 12; j++)
        ring.push([a[0] + ((b[0] - a[0]) * j) / 12, a[1] + ((b[1] - a[1]) * j) / 12]);
    });
    ring.push(ring[0]);
    return ring;
  });
  const result = h.fromEsri({ curveRings }, planar);
  assert.equal(result.geometry.geometries.length, 250);
  assert.ok(result.validation.topologyChecks < 1000000);
});
test('CORRECTION-validation: deeply nested Esri coordinates fail with LIMIT, not stack overflow', () => {
  let paths = [
    [0, 0],
    [1, 1],
  ];
  for (let i = 0; i < 100; i++) paths = [paths];
  assert.throws(
    () => h.fromEsri({ paths }),
    (e) => e instanceof h.SpatialError && e.code === 'LIMIT',
  );
});
test('CRS forms: equivalent WKT/WKT2, conflicts, overrides and unsupported references', () => {
  const wkt =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  assert.equal(
    h.fromEsri({ x: 10, y: 20, spatialReference: { wkt, wkt2, wkid: 4326 } }).wkt,
    'POINT (10 20)',
  );
  assert.throws(
    () => h.fromEsri({ x: 10, y: 20, spatialReference: { wkt2, wkid: 3857 } }),
    (e) => e.code === 'CRS',
  );
  assert.throws(
    () =>
      h.fromEsri({
        x: 10,
        y: 20,
        spatialReference: { wkt: '+proj=merc +datum=WGS84', wkt2 },
      }),
    (e) => e.code === 'CRS',
  );
  assert.equal(
    h.fromEsri(
      { x: 1, y: 2, spatialReference: { wkt2: 'broken' } },
      { sourceCrs: 'EPSG:4326' },
    ).wkt,
    'POINT (1 2)',
  );
  assert.throws(
    () =>
      h.fromEsri({
        x: 1,
        y: 2,
        spatialReference: {
          wkt2: wkt2.replace('DATUM[', 'DYNAMIC[FRAMEEPOCH[2020]],DATUM['),
        },
      }),
    (e) => e.code === 'CRS',
  );
  const latFirst = wkt2.replace(
    'AXIS["longitude",east],AXIS["latitude",north]',
    'AXIS["latitude",north],AXIS["longitude",east]',
  );
  // Esri/GeoJSON positions remain XY; descriptive WKT axis order does not swap arrays.
  assert.equal(
    h.fromEsri({ x: 10, y: 20, spatialReference: { wkt2: latFirst } }).wkt,
    'POINT (10 20)',
  );
});
test('FeatureSet inherited projection respects conflicts and an explicit caller source', () => {
  const input = {
    features: [
      { geometry: null },
      { geometry: { x: 10, y: 20, spatialReference: { wkid: 4326 } } },
      { geometry: { x: 0, y: 0, spatialReference: { wkid: 3857 } } },
    ],
  };
  const r = h.fromFeatureSet(input);
  assert.equal(r[2].error.code, 'CRS');
  assert.equal(r[2].error.path, '$.features[2].spatialReference');
  assert.equal(
    h.fromFeatureSet(input, { sourceCrs: 'EPSG:4326' })[2].spatial.wkt,
    'POINT (0 0)',
  );
  assert.throws(
    () => h.fromFeatureSet(input, { onError: 'throw' }),
    (e) => e.code === 'CRS',
  );
  const unknown = h.fromFeatureSet(
    { features: [{ geometry: { x: 1, y: 2 } }] },
    { ...planar, targetCrs: 'EPSG:4326' },
  );
  assert.equal(unknown[0].error.code, 'CRS');
});
test('touching parts and boundary transitions preserve containment decisions', () => {
  const densify = (vertices, n) => {
    const r = [];
    vertices.forEach((a, i) => {
      const b = vertices[(i + 1) % vertices.length];
      for (let j = 0; j < n; j++)
        r.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
    });
    r.push(r[0]);
    return r;
  };
  const r = h.fromGeoJSON(
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          densify(
            [
              [-1, 3],
              [2, 2],
              [3, -1],
            ],
            700,
          ),
        ],
        [
          densify(
            [
              [2, 2],
              [5, 2],
              [2, 5],
            ],
            170,
          ),
        ],
      ],
    },
    planar,
  );
  assert.equal(r.type, 'MultiPolygon');
  assert.ok(r.validation.topologyChecks < 1000000);
  assert.throws(
    () =>
      h.fromGeoJSON(
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 4],
              [0, 2],
              [0, 0],
            ],
            [
              [-1, 1],
              [0, 2],
              [1, 1],
              [1, 3],
              [0, 4],
              [-1, 3],
              [-1, 1],
            ],
          ],
        },
        planar,
      ),
    (e) => e.code === 'TOPOLOGY',
  );
});
test('collection limits are terminal in collect mode and iterators preserve processed counts', () => {
  const input = {
    type: 'FeatureCollection',
    features: Array.from({ length: 3 }, (_, id) => ({
      type: 'Feature',
      id,
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    })),
  };
  const iterator = h.iterateGeoJSON(input, { maxTotalPositions: 4 });
  assert.equal(iterator.next().value.id, 0);
  assert.equal(iterator.next().value.id, 1);
  assert.throws(
    () => iterator.next(),
    (e) =>
      e.scope === 'collection' &&
      e.processedFeatures === 2 &&
      e.path === '$.features[2]',
  );
  const workInput = {
    ...input,
    features: input.features.map((f) => ({
      ...f,
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
    })),
  };
  assert.throws(
    () => h.fromGeoJSON(workInput, { maxTotalTopologyChecks: 1 }),
    (e) => e.scope === 'collection',
  );
  for (const name of [
    'maxComponents',
    'maxTotalPositions',
    'maxTotalTopologyChecks',
    'maxTotalWktBytes',
  ])
    assert.throws(
      () => h.fromGeoJSON(input, { [name]: 0 }),
      (e) => e.code === 'LIMIT',
    );
  assert.deepEqual(
    [...h.iterateGeoJSON({ type: 'FeatureCollection', features: [] })],
    [],
  );
});
test('dependency repair failures preserve their causes in both polygon paths', () => {
  const script = `import { mock } from 'node:test'; import assert from 'node:assert/strict';
    const sentinel=new Error('clipping sentinel');
    mock.module('polyclip-ts',{namedExports:{union(){throw sentinel;},difference(){throw sentinel;}}});
    const h=await import('./index.js');const r=[[0,0],[2,2],[0,2],[2,0],[0,0]];
    for(const invoke of [()=>h.fromGeoJSON({type:'Polygon',coordinates:[r]},{repair:'topology'}),()=>h.fromEsri({rings:[r]},{repair:'topology'})])
      assert.throws(invoke,e=>e instanceof h.SpatialError && e.code==='TOPOLOGY' && e.cause===sentinel);`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
test('WKT2 projected controls honor metres, feet and registry-independent definitions', () => {
  const degree = 'ANGLEUNIT["degree",0.0174532925199433]';
  const utm = `PROJCRS["WGS 84 / UTM zone 17N",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0,${degree}]],CONVERSION["UTM zone 17N",METHOD["Transverse Mercator"],PARAMETER["Latitude of natural origin",0,${degree}],PARAMETER["Longitude of natural origin",-81,${degree}],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["Easting",east],AXIS["Northing",north],LENGTHUNIT["metre",1],ID["EPSG",32617]]`;
  const point = h.fromEsri({ x: 500000, y: 0, spatialReference: { wkt2: utm } })
    .geometry.coordinates;
  assert.ok(Math.abs(point[0] + 81) < 1e-10 && Math.abs(point[1]) < 1e-10);
  const feet = utm.replace(
    ',LENGTHUNIT["metre",1],ID["EPSG",32617]',
    ',LENGTHUNIT["foot",0.3048]',
  );
  const converted = h.fromEsri({
    x: 500000 / 0.3048,
    y: 0,
    spatialReference: { wkt2: feet },
  }).geometry.coordinates;
  assert.ok(Math.abs(converted[0] + 81) < 1e-10);
  const rad = wkt2
    .replace('ANGLEUNIT["degree",0.0174532925199433]', 'ANGLEUNIT["radian",1]')
    .replace(',ID["EPSG",4326]', '');
  const angular = h.fromEsri({ x: Math.PI / 6, y: 0, spatialReference: { wkt2: rad } })
    .geometry.coordinates;
  assert.ok(Math.abs(angular[0] - 30) < 1e-12);
  assert.throws(
    () =>
      h.fromEsri({
        x: 1,
        y: 2,
        spatialReference: {
          wkt2: wkt2.replace('World Geodetic System 1984', 'Unverified custom datum'),
        },
      }),
    (e) => e.code === 'CRS',
  );
});
test('unknown WKT1 datum and unsafe integer limits are rejected', () => {
  const definition =
    'GEOGCS["Custom",DATUM["Unverified custom datum",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  assert.throws(
    () => h.fromEsri({ x: 1, y: 2, spatialReference: { wkt: definition } }),
    (e) => e.code === 'CRS',
  );
  for (const option of ['maxPositions', 'maxDepth', 'maxTopologyChecks'])
    assert.throws(
      () =>
        h.fromGeoJSON(
          { type: 'Point', coordinates: [0, 0] },
          { [option]: Number.MAX_SAFE_INTEGER + 1 },
        ),
      (e) => e.code === 'LIMIT',
    );
});
test('local projection objects cannot redirect through their authority labels', () => {
  const definition = { projName: 'longlat', datumCode: 'WGS84', title: 'EPSG:3857' };
  const r = h.fromEsri(
    { x: 10, y: 20 },
    { sourceCrs: 'CUSTOM', projectionDefinitions: { CUSTOM: definition } },
  );
  assert.equal(r.wkt, 'POINT (10 20)');
  assert.equal(definition.title, 'EPSG:3857');
});
test('caller definitions cannot relabel a projected CRS as the WGS84 target', () => {
  for (const alias of ['EPSG:4326', 'WGS84'])
    assert.throws(
      () =>
        h.fromGeoJSON(
          { type: 'Point', coordinates: [10, 20] },
          {
            sourceCrs: alias,
            projectionDefinitions: { [alias]: '+proj=merc +datum=WGS84' },
          },
        ),
      (e) => e.code === 'CRS',
    );
});
