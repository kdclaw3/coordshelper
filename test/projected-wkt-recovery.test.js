/** Projected Esri WKT1 regressions and recovery of completed eager conversion rows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { sameProjection } from '../lib/projections.js';
import {
  projectedControls,
  optionsFor,
  statePlane,
  webMercator,
  utm,
} from './projected-wkt-fixtures.js';

const close = (result, expected) =>
  result.geometry.coordinates.forEach((n, i) =>
    assert.ok(
      Math.abs(n - expected[i]) < 1e-9,
      `coordinate ${i}: ${n} vs ${expected[i]}`,
    ),
  );
for (const f of projectedControls) {
  test(`${f.name}: Esri PROJCS conversion matches known control`, () => {
    const result = h.fromEsri(
      { x: f.xy[0], y: f.xy[1], spatialReference: { wkt: f.wkt } },
      optionsFor(f),
    );
    close(result, f.lonlat);
  });
  test(`${f.name}: WKT1, WKT2, PROJ and WKID definitions are equivalent`, () => {
    const options = optionsFor(f);
    assert.equal(sameProjection(f.wkt, f.wkt2, options), true);
    assert.equal(sameProjection(f.wkt, f.proj, options), true);
    assert.equal(sameProjection(f.wkt, `EPSG:${f.wkid}`, options), true);
    for (const wkid of f.aliases)
      for (const text of [{ wkt: f.wkt }, { wkt: f.wkt, wkt2: f.wkt2 }])
        close(
          h.fromEsri(
            { x: f.xy[0], y: f.xy[1], spatialReference: { ...text, wkid } },
            options,
          ),
          f.lonlat,
        );
  });
  test(`${f.name}: equivalent wrapper/member references accept all forms`, () => {
    const references = [
      { wkt: f.wkt },
      { wkt2: f.wkt2 },
      ...f.aliases.map((wkid) => ({ wkid })),
      { wkt: f.wkt, wkt2: f.wkt2, wkid: f.wkid },
    ];
    for (const wrapper of references)
      for (const member of references) {
        const results = h.fromFeatureSet(
          {
            spatialReference: wrapper,
            features: [
              { geometry: { x: f.xy[0], y: f.xy[1], spatialReference: member } },
            ],
          },
          optionsFor(f),
        );
        assert.equal(results[0].error, null);
        close(results[0].spatial, f.lonlat);
      }
  });
}
test('US-foot state plane honors units away from its false origin', () => {
  const xy = [statePlane.xy[0] + 10000, 5000],
    movedMetres = [300000 + 10000 * (1200 / 3937), 5000 * (1200 / 3937)];
  const projected = h.fromEsri(
    { x: xy[0], y: xy[1], spatialReference: { wkt: statePlane.wkt } },
    optionsFor(statePlane),
  );
  const equivalent = h.fromEsri(
    { x: movedMetres[0], y: movedMetres[1] },
    {
      sourceCrs: statePlane.proj.replace('+units=us-ft', '+units=m'),
      allowNad83ZeroShift: true,
    },
  );
  close(projected, equivalent.geometry.coordinates);
  const native = h.fromEsri(
    { x: xy[0], y: xy[1], spatialReference: { wkt: statePlane.wkt } },
    {
      spatialType: 'geometry',
      targetCrs:
        '+proj=tmerc +lat_0=36.6666666666667 +lon_0=-88.3333333333333 +k=0.999975 +x_0=300000 +y_0=0 +datum=NAD83 +units=m',
    },
  );
  close(native, movedMetres);
});
test('NAD83 projected defaults require opt-in, with actionable error and native bypass', () => {
  for (const options of [
    { spatialReference: { wkt: statePlane.wkt } },
    { sourceCrs: statePlane.proj },
    { sourceCrs: 'EPSG:4269' },
  ])
    assert.throws(
      () => h.fromEsri({ x: 0, y: 0 }, options),
      (e) => e.code === 'CRS' && /allowNad83ZeroShift/.test(e.detail),
    );
  assert.equal(
    h.fromEsri(
      { x: 0, y: 0, spatialReference: { wkt: statePlane.wkt } },
      { spatialType: 'geometry', project: false },
    ).wkt,
    'POINT (0 0)',
  );
});
test('real projected parameter and unit differences still reject', () => {
  assert.equal(
    sameProjection(
      statePlane.wkt,
      statePlane.wkt.replace('0.3048006096012192', '1'),
      optionsFor(statePlane),
    ),
    false,
  );
  assert.equal(
    sameProjection(
      utm.wkt,
      utm.wkt.replace('Central_Meridian",-81', 'Central_Meridian",-75'),
      {},
    ),
    false,
  );
  assert.equal(
    sameProjection(
      webMercator.wkt,
      webMercator.wkt.replace('False_Easting",0', 'False_Easting",100'),
      {},
    ),
    false,
  );
  assert.equal(sameProjection(utm.wkt, 'EPSG:32618', {}), false);
  assert.equal(sameProjection(utm.wkt, 'EPSG:32717', {}), false);
  assert.equal(sameProjection(utm.proj, '+proj=merc +datum=WGS84 +units=m', {}), false);
});
test('WKT1 parser metadata does not create conflicts with initialized built-ins', () => {
  const options = {
    projectionDefinitions: {
      labelled: {
        projName: 'utm',
        zone: 17,
        datumCode: 'WGS84',
        units: 'm',
        PROJECTION: 'Transverse_Mercator',
        local: false,
      },
    },
  };
  assert.equal(sameProjection('labelled', 'EPSG:32617', options), true);
});
test('Auxiliary Sphere does not override an incompatible datum or sphere model', () => {
  for (const wkt of [
    webMercator.wkt.replace('D_WGS_1984', 'unresolved_datum'),
    webMercator.wkt.replace('Auxiliary_Sphere_Type",0', 'Auxiliary_Sphere_Type",1'),
  ])
    assert.throws(
      () => h.fromEsri({ x: 0, y: 0, spatialReference: { wkt } }),
      (e) => e.code === 'CRS',
    );
});
test('stream throw errors report progress without retaining previous results', () => {
  const features = [
    { attributes: { OBJECTID: 1 }, geometry: { x: 0, y: 0 } },
    { geometry: { x: 'bad', y: 0 } },
  ];
  const iterator = h.iterateFeatureSet({ features }, { onError: 'throw' });
  assert.equal(iterator.next().value.spatial.wkt, 'POINT (0 0)');
  assert.throws(
    () => iterator.next(),
    (e) =>
      e.code === 'COORDINATE' &&
      e.processedFeatures === 1 &&
      e.partialResults === undefined,
  );
});
test('eager throw-mode feature failures retain completed rows, path and original cause', () => {
  const sentinel = new TypeError('malformed member getter');
  const failing = {
    get geometry() {
      throw sentinel;
    },
  };
  const goodGeo = {
    type: 'Feature',
    id: 1,
    geometry: { type: 'Point', coordinates: [1, 2] },
  };
  const absentGeo = { type: 'Feature', id: 2, geometry: null };
  const geo = {
    type: 'FeatureCollection',
    features: [goodGeo, absentGeo, { type: 'Feature', id: 3 }],
  };
  // Preserve the throwing getter; spreading it would fail before the adapter is called.
  Object.defineProperty(geo.features[2], 'geometry', {
    get() {
      throw sentinel;
    },
  });
  const esri = {
    features: [
      { attributes: { OBJECTID: 1 }, geometry: { x: 1, y: 2 } },
      { attributes: { OBJECTID: 2 }, geometry: null },
      failing,
    ],
  };
  for (const invoke of [
    () => h.fromGeoJSON(geo, { onError: 'throw' }),
    () => h.fromFeatureSet(esri, { onError: 'throw' }),
    () => h.fromEsri(esri, { onError: 'throw' }),
  ])
    assert.throws(invoke, (e) => {
      assert.equal(e.code, 'INTERNAL');
      assert.equal(e.path, '$.features[2]');
      assert.equal(e.cause, sentinel);
      assert.equal(e.processedFeatures, 2);
      assert.equal(e.partialResults.length, 2);
      assert.equal(e.partialResults[0].spatial.wkt, 'POINT (1 2)');
      assert.equal(e.partialResults[1].spatial, null);
      assert.equal(Object.keys(e).includes('partialResults'), false);
      return true;
    });
});
test('throw-mode normal conversion errors retain zero or more finished results', () => {
  for (const earlier of [
    [],
    [{ type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [0, 0] } }],
  ])
    assert.throws(
      () =>
        h.fromGeoJSON(
          {
            type: 'FeatureCollection',
            features: [
              ...earlier,
              {
                type: 'Feature',
                id: 2,
                geometry: { type: 'Point', coordinates: ['bad', 0] },
              },
            ],
          },
          { onError: 'throw' },
        ),
      (e) => {
        assert.equal(e.code, 'COORDINATE');
        assert.equal(e.partialResults.length, earlier.length);
        assert.equal(e.processedFeatures, earlier.length);
        return true;
      },
    );
  const results = h.fromGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: ['bad', 0] } },
    ],
  });
  assert.equal(results[0].error.code, 'COORDINATE');
  assert.equal(results[0].error.partialResults, undefined);
});
