import test from 'node:test';
import assert from 'node:assert/strict';
import { fromEsri } from '../index.js';
import { esriCircle } from './fixtures.js';

test('curved containment uses the arcs rather than the control-point polygon', () => {
  // This hole fits inside the actual circle but outside the diamond of control points.
  const r = fromEsri({ curveRings: [esriCircle(0.65, 0.65, 0.03), esriCircle()] });
  assert.equal(r.type, 'CurvePolygon');
  assert.equal(r.geometry.rings.length, 2);
});
test('curved islands and disjoint shells survive shuffled ring order', () => {
  const r = fromEsri({
    curveRings: [
      esriCircle(0, 0, 0.1),
      esriCircle(4, 0, 0.5),
      esriCircle(),
      esriCircle(0, 0, 0.5),
    ],
  });
  assert.equal(r.type, 'GeometryCollection');
  assert.equal(r.geometry.geometries.length, 3);
  assert.ok(r.geometry.geometries.some((g) => g.rings.length === 2));
});
test('curved contacts, unsupported global extents and strict wrong winding reject explicitly', () => {
  for (const rings of [
    [esriCircle(), esriCircle(1)],
    [esriCircle(), esriCircle(2)],
    [esriCircle(), esriCircle()],
  ])
    assert.throws(
      () => fromEsri({ curveRings: rings }),
      (e) => e.code === 'CURVE_TOPOLOGY',
    );
  assert.throws(
    () => fromEsri({ curveRings: [esriCircle(179.9)] }),
    (e) => e.code === 'LONGITUDE',
  );
  assert.throws(
    () => fromEsri({ curveRings: [esriCircle(0, 85)] }),
    (e) => e.code === 'CURVE_GLOBAL',
  );
  assert.throws(
    () => fromEsri({ curveRings: [esriCircle()] }, { repair: 'none' }),
    (e) => e.code === 'WINDING',
  );
});
test('arc reversal preserves every original altitude and measure', () => {
  const ring = esriCircle().map((item) =>
    Array.isArray(item) ? [...item, 5, 7] : { c: item.c.map((p) => [...p, 5, 7]) },
  );
  const r = fromEsri({ curveRings: [ring], hasZ: true, hasM: true });
  const coordinates = r.geometry.rings[0].segments.flatMap((s) => s.coordinates);
  assert.ok(coordinates.every((p) => p[2] === 5 && p[3] === 7));
});
