/** Ring diagnostics identify the source ring, including after Esri classification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';

const ccw = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
  [0, 0],
];
const clockwise = [...ccw].reverse();
const hole = [
  [1, 1],
  [2, 1],
  [2, 2],
  [1, 2],
  [1, 1],
];

test('Polygon winding diagnostics and errors identify rings rather than vertices', () => {
  for (const [geometry, path] of [
    [{ type: 'Polygon', coordinates: [clockwise] }, '$.coordinates[0]'],
    [{ type: 'MultiPolygon', coordinates: [[clockwise]] }, '$.coordinates[0][0]'],
    [
      {
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', coordinates: [clockwise] }],
      },
      '$.geometries[0].coordinates[0]',
    ],
  ]) {
    const result = h.fromGeoJSON(geometry);
    assert.equal(result.diagnostics.find((d) => d.code === 'REWOUND').path, path);
    assert.throws(
      () => h.fromGeoJSON(geometry, { repair: 'none' }),
      (e) => e.code === 'WINDING' && e.path === path,
    );
  }
  const collapsed = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ],
    ],
  };
  assert.throws(
    () => h.fromGeoJSON(collapsed, { spatialType: 'geometry' }),
    (e) => e.code === 'COLLAPSED' && e.path === '$.coordinates[0]',
  );
});

test('Esri rewinding retains source ring indices after shell/hole sorting', () => {
  const other = clockwise.map(([x, y]) => [x + 10, y]);
  const input = { rings: [hole, clockwise, other] };
  const result = h.fromEsri(input);
  assert.equal(result.type, 'MultiPolygon');
  assert.deepEqual(
    result.diagnostics
      .filter((d) => d.code === 'REWOUND')
      .map((d) => d.path)
      .sort(),
    ['$.rings[0]', '$.rings[1]', '$.rings[2]'],
  );
  assert.throws(
    () => h.fromEsri(input, { repair: 'none' }),
    (e) => e.code === 'WINDING' && e.path === '$.rings[1]',
  );
  const rows = h.fromFeatureSet(
    {
      spatialReference: { wkid: 4326 },
      features: [{ geometry: { x: 0, y: 0 } }, { geometry: input }],
    },
    { repair: 'none' },
  );
  assert.equal(rows[1].error.code, 'WINDING');
  assert.equal(rows[1].error.path, '$.features[1].rings[1]');
});

test('Esri single-ring collapsed area identifies the source ring', () => {
  assert.throws(
    () =>
      h.fromEsri(
        {
          rings: [
            [
              [0, 0],
              [1, 0],
              [2, 0],
              [0, 0],
            ],
          ],
        },
        { spatialType: 'geometry' },
      ),
    (e) => e.code === 'COLLAPSED' && e.path === '$.rings[0]',
  );
});

test('Esri ring provenance survives an earlier ring expanding during topology repair', () => {
  const crossing = [
    [0, 0],
    [2, 2],
    [0, 2],
    [2, 0],
    [0, 0],
  ];
  const other = clockwise.map(([x, y]) => [x + 10, y]);
  const result = h.fromEsri({ rings: [crossing, other] }, { repair: 'topology' });
  assert.equal(
    result.diagnostics.find((d) => d.code === 'ESRI_RING_REPAIRED').path,
    '$.rings[0]',
  );
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === 'REWOUND').map((d) => d.path),
    ['$.rings[1]'],
  );
});
