/** Behavioral regressions for eager recovery, datum policy and CRS conflict detection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { sameProjection } from '../lib/projections.js';

const point = (id) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [id, 0] },
});
const geo = { type: 'FeatureCollection', features: [point(1), point(2), point(3)] };
const esri = {
  objectIdFieldName: 'ID',
  features: [1, 2, 3].map((id) => ({
    attributes: { ID: id },
    geometry: { x: id, y: 0 },
  })),
};
const nad83 =
  'GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

test('eager collections preserve completed results on aggregate exhaustion', () => {
  for (const run of [
    (opts) => h.fromGeoJSON(geo, opts),
    (opts) => h.fromFeatureSet(esri, opts),
    (opts) => h.fromEsri(esri, opts),
  ])
    for (const onError of ['collect', 'throw'])
      assert.throws(
        () => run({ maxTotalPositions: 2, onError }),
        (error) => {
          assert.equal(error.scope, 'collection');
          assert.equal(error.processedFeatures, 2);
          assert.equal(error.path, '$.features[2]');
          assert.deepEqual(
            error.partialResults.map((r) => r.id),
            [1, 2],
          );
          assert.deepEqual(
            error.partialResults.map((r) => r.spatial.wkt),
            ['POINT (1 0)', 'POINT (2 0)'],
          );
          assert.equal(Object.keys(error).includes('partialResults'), false);
          return true;
        },
      );
});
test('eager recovery includes failed and null results, but not the unfinished feature', () => {
  const input = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'bad',
        geometry: { type: 'Point', coordinates: ['bad', 0] },
      },
      { type: 'Feature', id: 'null', geometry: null },
      point(1),
      point(2),
    ],
  };
  assert.throws(
    () => h.fromGeoJSON(input, { maxTotalPositions: 2 }),
    (error) => {
      assert.deepEqual(
        error.partialResults.map((r) => r.id),
        ['bad', 'null', 1],
      );
      assert.equal(error.partialResults[0].error.code, 'COORDINATE');
      assert.equal(error.partialResults[1].spatial, null);
      assert.equal(error.processedFeatures, 3);
      return true;
    },
  );
});
test('eager output-limit errors retain completed results; iterator retains only caller-held results', () => {
  assert.throws(
    () => h.fromGeoJSON(geo, { maxTotalWktBytes: 22 }),
    (error) => {
      assert.equal(error.partialResults.length, 2);
      return true;
    },
  );
  const iterator = h.iterateGeoJSON(geo, { maxTotalPositions: 2 }),
    completed = [];
  completed.push(iterator.next().value, iterator.next().value);
  assert.throws(
    () => iterator.next(),
    (e) => e.scope === 'collection' && e.partialResults === undefined,
  );
  assert.equal(completed.length, 2);
});
test('NAD83 zero-shift to WGS84 needs opt-in and is diagnosed for code, WKT and PROJ', () => {
  for (const source of ['EPSG:4269', nad83, '+proj=longlat +datum=NAD83']) {
    const input = { type: 'Point', coordinates: [-83, 43] };
    assert.throws(
      () => h.fromGeoJSON(input, { sourceCrs: source }),
      (e) => e.code === 'CRS' && /allowNad83ZeroShift/.test(e.message),
    );
    const accepted = h.fromGeoJSON(input, {
      sourceCrs: source,
      allowNad83ZeroShift: true,
    });
    assert.ok(Math.abs(accepted.geometry.coordinates[0] + 83) < 1e-10);
    assert.equal(
      accepted.diagnostics.filter((d) => d.code === 'NAD83_ZERO_SHIFT').length,
      1,
    );
  }
});
test('datum opt-in does not authorize unresolved realizations; native and caller transforms are unaffected', () => {
  for (const name of ['NAD83_HARN', 'NAD83_2011'])
    assert.throws(
      () =>
        h.fromEsri(
          {
            x: -83,
            y: 43,
            spatialReference: { wkt: nad83.replace('North_American_Datum_1983', name) },
          },
          { allowNad83ZeroShift: true },
        ),
      (e) => e.code === 'CRS',
    );
  const native = h.fromEsri(
    { x: -83, y: 43, spatialReference: { wkid: 4269 } },
    { spatialType: 'geometry', project: false },
  );
  assert.equal(native.wkt, 'POINT (-83 43)');
  assert.equal(native.diagnostics.length, 0);
  const custom = h.fromGeoJSON(
    { type: 'Point', coordinates: [-83, 43] },
    { sourceCrs: 'EPSG:4269', converter: (xy) => xy },
  );
  assert.equal(custom.diagnostics.length, 0);
  assert.throws(
    () =>
      h.fromGeoJSON(
        { type: 'Point', coordinates: [0, 0] },
        { allowNad83ZeroShift: 'yes' },
      ),
    (e) => e.code === 'OPTIONS',
  );
});
test('verified nonzero NAD83 Helmert definitions and same-datum projection need no approximation opt-in', () => {
  const input = { type: 'Point', coordinates: [-83, 43] };
  const verified = h.fromGeoJSON(input, {
    sourceCrs: '+proj=longlat +datum=NAD83 +towgs84=1,2,3',
  });
  assert.equal(
    verified.diagnostics.some((d) => d.code === 'NAD83_ZERO_SHIFT'),
    false,
  );
  assert.ok(Math.abs(verified.geometry.coordinates[0] + 83) > 1e-8);
  const planar = h.fromGeoJSON(input, {
    spatialType: 'geometry',
    sourceCrs: 'EPSG:4269',
    targetCrs: '+proj=utm +zone=17 +datum=NAD83',
  });
  assert.equal(
    planar.diagnostics.some((d) => d.code === 'NAD83_ZERO_SHIFT'),
    false,
  );
});
test('CRS conflict comparison includes projection-specific parameters and axis declarations', () => {
  const geos = '+proj=geos +h=35785831 +lon_0=0 +datum=WGS84';
  const omerc =
    '+proj=omerc +lat_0=4 +lonc=115 +alpha=53 +gamma=10 +k=0.99984 +datum=WGS84';
  for (const [a, b] of [
    [geos, geos.replace('35785831', '40000000')],
    [geos, geos + ' +sweep=x'],
    [omerc, omerc.replace('gamma=10', 'gamma=20')],
    ['+proj=longlat +datum=WGS84 +axis=enu', '+proj=longlat +datum=WGS84 +axis=neu'],
  ]) {
    assert.equal(sameProjection(a, b, {}), false);
    assert.throws(
      () => h.fromEsri({ x: 1, y: 2, spatialReference: { wkt: a, wkt2: b } }),
      (e) => e.code === 'CRS',
    );
  }
  assert.equal(
    sameProjection(geos, geos.replace('+lon_0=0 ', '') + ' +sweep=y', {}),
    true,
  );
});
test('unrecognized scalar projection parameters cannot silently disappear from conflict checks', () => {
  const definitions = {
    A: { projName: 'longlat', datumCode: 'WGS84', customParameter: 1 },
    B: { projName: 'longlat', datumCode: 'WGS84', customParameter: 2 },
  };
  assert.equal(sameProjection('A', 'B', { projectionDefinitions: definitions }), false);
  assert.equal(
    sameProjection('A', 'B', {
      projectionDefinitions: {
        A: { projName: 'longlat', datumCode: 'WGS84', customParameter: 0 },
        B: { projName: 'longlat', datumCode: 'WGS84' },
      },
    }),
    false,
  );
});
