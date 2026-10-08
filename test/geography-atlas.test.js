import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import { square } from './fixtures.js';
import { greatEllipseChart, direction } from '../lib/great-ellipse.js';
import {
  worldwideParts,
  worldwideHoles,
  polarCap,
  polarBowtie,
  datelineBowtie,
  containingParts,
  polarContainingParts,
} from './geography-atlas-fixtures.js';

test('valid multipart validation and winding perform zero original-coordinate map writes', (t) => {
  const set = Map.prototype.set;
  let writes = 0;
  t.mock.method(Map.prototype, 'set', function (key, value) {
    if (
      typeof key === 'string' &&
      /^[-+\deE.]+:[-+\deE.]+$/.test(key) &&
      Array.isArray(value) &&
      typeof value[0] === 'number'
    )
      writes++;
    return set.call(this, key, value);
  });
  for (const repair of ['none', 'safe', 'topology'])
    assert.equal(h.fromGeoJSON(worldwideHoles, { repair }).type, 'MultiPolygon');
  assert.equal(
    h.fromEsri({
      rings: worldwideHoles.coordinates.flatMap(([s, hole]) => [s.toReversed(), hole]),
    }).type,
    'MultiPolygon',
  );
  assert.equal(writes, 0);
});
test('chart projection is side-effect free and repair seeding uses existing projected points', (t) => {
  const ring = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [0, -0],
    [-1, 1],
    [-1, -1],
  ];
  const chart = greatEllipseChart([ring], '$');
  const spy = t.mock.method(Map.prototype, 'set');
  const projected = ring.map((p) => chart.project(p));
  assert.equal(spy.mock.callCount(), 0);
  t.mock.method(chart, 'project', () => {
    throw Error('unexpected reprojection');
  });
  chart.rememberOriginals([ring], [projected]);
  projected.forEach((p, i) => assert.deepEqual(chart.unproject(p), ring[i]));
  assert.deepEqual(chart.unproject([-0, 0]), [0, -0]);
});
test('topology repair returns untouched source vertices exactly', () => {
  const ring = [
    [0.123456789012345, 45.12345678901234],
    [2.223456789012345, 47.32345678901234],
    [0.123456789012345, 47.32345678901234],
    [2.223456789012345, 45.12345678901234],
    [0.123456789012345, 45.12345678901234],
  ];
  const result = h.fromGeoJSON(
    { type: 'Polygon', coordinates: [ring] },
    { repair: 'topology' },
  );
  assert.equal(result.type, 'MultiPolygon');
  const output = result.geometry.coordinates.flat(2);
  for (const p of ring)
    assert.ok(output.some((v) => v.every((n, i) => Object.is(n, p[i]))));
});

test('distant multipart polygons use independent geography charts', () => {
  for (const input of [worldwideParts, worldwideHoles]) {
    const original = structuredClone(input);
    for (const repair of ['none', 'safe', 'topology']) {
      const result = h.fromGeoJSON(input, { repair });
      assert.equal(result.type, 'MultiPolygon');
      assert.deepEqual(result.geometry, input);
    }
    assert.deepEqual(input, original);
  }
});
test('Esri ring classification supports distant shells, holes and islands', () => {
  const rings = worldwideHoles.coordinates.flatMap(([shell, hole]) => [
    hole,
    shell.toReversed(),
  ]);
  const result = h.fromEsri({ rings });
  assert.equal(result.type, 'MultiPolygon');
  assert.equal(result.geometry.coordinates.length, 4);
  assert.ok(result.geometry.coordinates.every((p) => p.length === 2));
  const islands = worldwideHoles.coordinates
    .flatMap(([shell, hole]) => {
      const [x, y] = shell[0];
      return [square(x + 0.6, y + 0.6, 0.1).toReversed(), hole, shell.toReversed()];
    })
    .toReversed();
  const nested = h.fromEsri({ rings: islands }).geometry.coordinates;
  assert.equal(nested.length, 8);
  assert.equal(nested.filter((p) => p.length === 2).length, 4);
});
test('filled cap bounds retain sub-metre parts and their interior extrema', () => {
  const ring = square(-83, 43, 0.000001);
  const { cap } = greatEllipseChart([ring], '$');
  for (const p of [...ring, [-82.9999995, 43.0000005]])
    direction(p).forEach((value, axis) => {
      assert.ok(value >= cap.ranges[axis][0] && value <= cap.ranges[axis][1]);
    });
  const small = {
    type: 'MultiPolygon',
    coordinates: [[ring], [square(-82.9999995, 43.0000005, 0.000001)]],
  };
  assert.throws(
    () => h.fromGeoJSON(small),
    (e) => e.code === 'TOPOLOGY',
  );
  assert.doesNotThrow(() => h.fromGeoJSON(small, { repair: 'topology' }));
  for (const x of [-179, -83, 0, 120])
    for (const y of [-80, -43, 0, 43, 80])
      for (const size of [0.0000001, 0.000001, 0.00001]) {
        const parts = {
          type: 'MultiPolygon',
          coordinates: [
            [square(x, y, size)],
            [square(x + size / 2, y + size / 2, size)],
          ],
        };
        assert.throws(
          () => h.fromGeoJSON(parts),
          (e) => e.code === 'TOPOLOGY',
          `${x}/${y}/${size}`,
        );
      }
});
test('repair cleanup does not reapply the source CRS converter', () => {
  const source = structuredClone(datelineBowtie);
  let calls = 0;
  const result = h.fromGeoJSON(source, {
    repair: 'topology',
    converter: (p) => {
      calls++;
      return p;
    },
  });
  assert.equal(calls, source.coordinates[0].length);
  assert.deepEqual(
    result.geometry,
    h.fromGeoJSON(source, { repair: 'topology' }).geometry,
  );
  assert.throws(
    () => h.fromGeoJSON(source, { repair: 'topology', maxPositions: 6 }),
    (e) => e.code === 'LIMIT' && e.path.includes('repaired'),
  );
});
test('filled 3D bounds retain nested, polar and overlapping part checks', () => {
  for (const input of [containingParts, polarContainingParts])
    assert.throws(
      () => h.fromGeoJSON(input),
      (e) => e.code === 'TOPOLOGY',
    );
  const overlap = structuredClone(worldwideParts);
  overlap.coordinates.push([square(-149.5, 40.5)]);
  assert.throws(
    () => h.fromGeoJSON(overlap),
    (e) => e.code === 'TOPOLOGY',
  );
  const repaired = h.fromGeoJSON(overlap, { repair: 'topology' });
  assert.equal(repaired.geometry.coordinates.length, 4);
  assert.doesNotThrow(() => h.fromGeoJSON(repaired.geometry));
});
test('topology repair accepts supported polar caps and repairs polar self-crossings', () => {
  assert.deepEqual(h.fromGeoJSON(polarCap, { repair: 'topology' }).geometry, polarCap);
  assert.throws(
    () => h.fromGeoJSON(polarBowtie),
    (e) => e.code === 'TOPOLOGY',
  );
  const result = h.fromGeoJSON(polarBowtie, { repair: 'topology' });
  assert.equal(result.type, 'MultiPolygon');
  assert.equal(result.geometry.coordinates.length, 2);
  assert.doesNotThrow(() => h.fromGeoJSON(result.geometry));
});
test('repair output uses normal longitude, negative-zero and closure cleanup', () => {
  const result = h.fromGeoJSON(datelineBowtie, { repair: 'topology' });
  const positions = result.geometry.coordinates.flat(2);
  assert.ok(positions.some(([x]) => x === -180));
  for (const [x, y] of positions) {
    assert.ok(Number.isFinite(x) && x >= -180 && x < 180);
    assert.ok(Number.isFinite(y) && y >= -90 && y <= 90);
    assert.equal(Object.is(x, -0) || Object.is(y, -0), false);
  }
  for (const [ring] of result.geometry.coordinates)
    assert.deepEqual(ring[0], ring.at(-1));
});
