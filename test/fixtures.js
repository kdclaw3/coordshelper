const shell = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
  [0, 0],
];
const hole = [
  [1, 1],
  [1, 3],
  [3, 3],
  [3, 1],
  [1, 1],
];
const square = (x = 0, y = 0, size = 1) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];
// Synthetic fixtures derived from categories in RFC 7946 and polygon-clipping/GEOS validation.
// No customer geometries or copied third-party fixture files.
const repairs = {
  unclosed: { type: 'Polygon', coordinates: [square().slice(0, -1)] },
  wrongWinding: {
    type: 'Polygon',
    coordinates: [[...shell].reverse(), [...hole].reverse()],
  },
  consecutiveDuplicate: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ],
  },
  bowtie: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ],
    ],
  },
  spike: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 2],
        [5, 2],
        [4, 2],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ],
  },
  outsideHole: { type: 'Polygon', coordinates: [shell, square(5, 5)] },
  crossingHole: { type: 'Polygon', coordinates: [shell, square(3, 1, 2)] },
  overlappingHoles: {
    type: 'Polygon',
    coordinates: [shell, square(1, 1, 1.5), square(2, 2, 1.5)],
  },
  overlappingPolygons: {
    type: 'MultiPolygon',
    coordinates: [[square(0, 0, 2)], [square(1, 1, 2)]],
  },
  sharedEdge: {
    type: 'MultiPolygon',
    coordinates: [[square(0, 0, 1)], [square(1, 0, 1)]],
  },
  duplicatePolygons: {
    type: 'MultiPolygon',
    coordinates: [[square()], [square()]],
  },
  nestedHoles: {
    type: 'Polygon',
    coordinates: [shell, square(1, 1, 2), square(1.5, 1.5, 0.5)],
  },
  duplicateHoles: { type: 'Polygon', coordinates: [shell, hole, hole] },
  spanningHole: {
    type: 'Polygon',
    coordinates: [
      shell,
      [
        [1, -1],
        [3, -1],
        [3, 5],
        [1, 5],
        [1, -1],
      ],
    ],
  },
  island: {
    type: 'MultiPolygon',
    coordinates: [[shell, hole], [square(1.5, 1.5, 0.5)]],
  },
};
const allTypes = [
  { type: 'Point', coordinates: [0, 0] },
  {
    type: 'MultiPoint',
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
  {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
  {
    type: 'MultiLineString',
    coordinates: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ],
  },
  { type: 'Polygon', coordinates: [shell, hole] },
  { type: 'MultiPolygon', coordinates: [[square()], [square(5, 5)]] },
  {
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [0, 0] },
      {
        type: 'LineString',
        coordinates: [
          [1, 1],
          [2, 2],
        ],
      },
    ],
  },
];
const curve = {
  type: 'CircularString',
  coordinates: [
    [0, 0],
    [1, 1],
    [2, 0],
  ],
};
const compound = {
  type: 'CompoundCurve',
  segments: [
    curve,
    {
      type: 'LineString',
      coordinates: [
        [2, 0],
        [3, 0],
      ],
    },
  ],
};
const curvedPolygon = {
  type: 'CurvePolygon',
  rings: [
    {
      type: 'CircularString',
      coordinates: [
        [2, 1],
        [1, 2],
        [0, 1],
        [1, 0],
        [2, 1],
      ],
    },
  ],
};
const globals = [
  {
    name: 'dateline',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [179, -1],
          [-179, -1],
          [-179, 1],
          [179, 1],
          [179, -1],
        ],
      ],
    },
    inside: [180, 0],
    outside: [0, 0],
  },
  {
    name: 'north-pole',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-135, 80],
          [-45, 80],
          [45, 80],
          [135, 80],
          [-135, 80],
        ],
      ],
    },
    inside: [0, 90],
    outside: [0, 0],
  },
  {
    name: 'south-pole',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [135, -80],
          [45, -80],
          [-45, -80],
          [-135, -80],
          [135, -80],
        ],
      ],
    },
    inside: [0, -90],
    outside: [0, 0],
  },
];
const topologyRepairs = Object.keys(repairs).filter(
  (k) => !['unclosed', 'wrongWinding', 'consecutiveDuplicate', 'island'].includes(k),
);
export {
  shell,
  hole,
  square,
  repairs,
  topologyRepairs,
  allTypes,
  curve,
  compound,
  curvedPolygon,
  globals,
};
// Clockwise Esri shells with real circular arcs; conversion must preserve the intended interior.
export const esriCircle = (x = 0, y = 0, radius = 1) => [
  [x + radius, y],
  {
    c: [
      [x - radius, y],
      [x, y - radius],
    ],
  },
  {
    c: [
      [x + radius, y],
      [x, y + radius],
    ],
  },
];
