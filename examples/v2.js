import { fromGeoJSON, fromEsri, fromSpatial, sqlBinding } from '../index.js';

// Synthetic local previews. No connections, SQL execution or credentials.
const samples = [
  fromGeoJSON({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ],
  }),
  fromGeoJSON(
    {
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
    { repair: 'topology' },
  ),
  fromEsri({
    paths: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ],
    spatialReference: { wkid: 4326 },
  }),
  fromSpatial({ type: 'FullGlobe' }),
];
for (const value of samples)
  console.log(
    JSON.stringify(
      {
        type: value.type,
        geometry: value.geometry,
        diagnostics: value.diagnostics,
        sql: sqlBinding(value),
      },
      null,
      2,
    ),
  );
