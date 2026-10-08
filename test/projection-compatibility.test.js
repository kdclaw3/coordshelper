/** Version-upgrade gates for the pinned projection/parser integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import proj4 from 'proj4';
import * as h from '../index.js';

test('proj4 and isolated WKT parsing resolve one installed parser instance', () => {
  const local = createRequire(import.meta.url);
  const dependency = createRequire(local.resolve('proj4'));
  assert.equal(dependency.resolve('wkt-parser'), local.resolve('wkt-parser'));
});
test('authority-labelled WKT remains isolated; normalized units, axes and datum failures remain usable', () => {
  const wkt =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","3857"]]';
  const saved = proj4.defs('EPSG:3857');
  try {
    proj4.defs('EPSG:3857', '+proj=utm +zone=1 +datum=WGS84');
    assert.equal(
      h.fromEsri({ x: 10, y: 20, spatialReference: { wkt } }).wkt,
      'POINT (10 20)',
    );
  } finally {
    proj4.defs('EPSG:3857', saved);
  }
  assert.throws(
    () =>
      h.fromEsri({
        x: 1,
        y: 2,
        spatialReference: { wkt: wkt.replace('WGS_1984', 'unresolved_datum') },
      }),
    (e) => e instanceof h.SpatialError && e.code === 'CRS' && e.cause !== undefined,
  );
});
