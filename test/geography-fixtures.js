/** Synthetic SQL geography controls; no customer data. */
export const notch = (clearance = 0.0000002, latitude = 45, longitude = 0) => ({
  type: 'Polygon',
  coordinates: [
    [
      [-0.01, latitude],
      [0.01, latitude],
      [0.01, latitude + 0.01],
      [0.001, latitude + 0.01],
      [0, latitude + clearance],
      [-0.001, latitude + 0.01],
      [-0.01, latitude + 0.01],
      [-0.01, latitude],
    ].map(([x, y]) => [((x + longitude + 540) % 360) - 180, y]),
  ],
});
export const curvedHole = {
  type: 'Polygon',
  coordinates: [
    [
      [-0.01, 45],
      [0.01, 45],
      [0.01, 45.01],
      [-0.01, 45.01],
      [-0.01, 45],
    ],
    [
      [-0.001, 45.0000002],
      [0, 45.002],
      [0.001, 45.0000002],
      [-0.001, 45.0000002],
    ],
  ],
};
export const curvedParts = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-0.01, 44.99],
        [0.01, 44.99],
        [0.01, 45],
        [-0.01, 45],
        [-0.01, 44.99],
      ],
    ],
    [
      [
        [-0.001, 45.0000002],
        [0.001, 45.0000002],
        [0.001, 45.001],
        [-0.001, 45.001],
        [-0.001, 45.0000002],
      ],
    ],
  ],
};
export const greatEllipseOverlap = {
  type: 'MultiLineString',
  coordinates: [
    [
      [-60, 45],
      [60, 45],
    ],
    [
      [0, 63.43494882292201],
      [60, 45],
    ],
  ],
};
export const shortOverlap = {
  type: 'MultiLineString',
  coordinates: [
    [
      [-83, 43],
      [-82.999999, 43.000001],
    ],
    [
      [-82.999999, 43.000001],
      [-83, 43],
    ],
  ],
};
/** Deterministic small-clearance, dateline, latitude and scale probes for SQL differential checks. */
export function geographyControls() {
  const cases = [];
  for (const latitude of [-80, -45, -1, 0, 1, 45, 80])
    for (const longitude of [-83, 0, 179.999])
      for (const clearance of [1e-8, 2e-7, 4.4e-7, 5e-7, 1e-6])
        cases.push({
          name: `notch ${latitude}/${longitude}/${clearance}`,
          geometry: notch(clearance, latitude, longitude),
        });
  for (const latitude of [-80, -45, 0, 45, 80])
    for (const radius of [0.000001, 0.001, 1, 5]) {
      const ring = Array.from({ length: 64 }, (_, i) => [
        -83 + radius * Math.cos((i * Math.PI) / 32),
        latitude + radius * Math.sin((i * Math.PI) / 32),
      ]);
      ring.push([...ring[0]]);
      const hole = ring.map(([x, y]) => [
        -83 + (x + 83) / 2,
        latitude + (y - latitude) / 2,
      ]);
      cases.push({
        name: `shell and hole ${latitude}/${radius}`,
        geometry: { type: 'Polygon', coordinates: [ring, hole] },
      });
    }
  for (const x of [-179, -83, 0, 120])
    for (const y of [-80, -43, 0, 43, 80])
      for (const size of [0.000001, 0.001, 1]) {
        const line = [
          [x, y],
          [x + size, y + size],
        ];
        cases.push({
          name: `duplicate edges ${x}/${y}/${size}`,
          geometry: { type: 'MultiLineString', coordinates: [line, line.toReversed()] },
        });
      }
  return cases;
}
