/** Unexpected thrown values retain collection paths, causes and completed rows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';

for (const thrown of [null, undefined]) {
  test(`collections wrap thrown ${String(thrown)} from feature getters`, () => {
    for (const boundary of ['geometry', 'identity']) {
      const geoFeature = (id) => ({
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [id, 0] },
      });
      const esriFeature = (id) => ({
        attributes: { OBJECTID: id },
        geometry: { x: id, y: 0 },
      });
      const geo = { type: 'FeatureCollection', features: [1, 2, 3].map(geoFeature) };
      const esri = {
        spatialReference: { wkid: 4326 },
        features: [1, 2, 3].map(esriFeature),
      };
      for (const [feature, key] of [
        [geo.features[1], boundary === 'geometry' ? 'geometry' : 'id'],
        [esri.features[1], boundary === 'geometry' ? 'geometry' : 'attributes'],
      ])
        Object.defineProperty(feature, key, {
          get() {
            throw thrown;
          },
        });
      for (const run of [
        (options) => h.fromGeoJSON(geo, options),
        (options) => h.fromFeatureSet(esri, options),
        (options) => h.fromEsri(esri, options),
      ]) {
        const collected = run({ onError: 'collect' });
        assert.equal(collected.length, 3);
        assert.equal(collected[0].spatial.wkt, 'POINT (1 0)');
        assert.equal(collected[1].spatial, null);
        assert.equal(collected[2].spatial.wkt, 'POINT (3 0)');
        const checkError = (error) => {
          assert.ok(error instanceof h.SpatialError);
          assert.equal(error.code, 'INTERNAL');
          assert.equal(error.path, '$.features[1]');
          assert.ok(Object.hasOwn(error, 'cause'));
          assert.equal(error.cause, thrown);
        };
        checkError(collected[1].error);
        assert.throws(
          () => run({ onError: 'throw' }),
          (error) => {
            checkError(error);
            assert.equal(error.processedFeatures, 1);
            assert.equal(error.partialResults.length, 1);
            assert.equal(error.partialResults[0].spatial.wkt, 'POINT (1 0)');
            assert.equal(Object.keys(error).includes('partialResults'), false);
            return true;
          },
        );
      }
    }
  });
}
