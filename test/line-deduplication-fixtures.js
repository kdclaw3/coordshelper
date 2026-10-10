// Synthetic conversion defects; customer source data stays in private workspace backtests.
export const retrace = {
  type: 'LineString',
  coordinates: [
    [0, 0],
    [1, 0],
    [0, 0],
    [1, 0],
    [2, 1],
  ],
};
export const cleanRetrace = {
  type: 'LineString',
  coordinates: [
    [0, 0],
    [1, 0],
    [2, 1],
  ],
};
export const branch = {
  type: 'LineString',
  coordinates: [
    [-1, 0],
    [0, 0],
    [0, 1],
    [0, 0],
    [1, 0],
  ],
};
export const cleanBranch = {
  type: 'MultiLineString',
  coordinates: [
    [
      [-1, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [0, 1],
    ],
    [
      [0, 0],
      [1, 0],
    ],
  ],
};
export const loop = {
  type: 'LineString',
  coordinates: [
    [0, 0],
    [1, 0],
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ],
};
export const cleanLoop = {
  type: 'LineString',
  coordinates: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ],
};
export const duplicates = {
  type: 'MultiLineString',
  coordinates: [
    [
      [0, 0],
      [1, 0],
    ],
    [
      [1, 0],
      [0, 0],
    ],
    [
      [3, 0],
      [4, 1],
    ],
  ],
};
export const cleanDuplicates = {
  type: 'MultiLineString',
  coordinates: [
    [
      [0, 0],
      [1, 0],
    ],
    [
      [3, 0],
      [4, 1],
    ],
  ],
};
export const deduplicationCases = [
  ['retrace', retrace, cleanRetrace],
  ['branch', branch, cleanBranch],
  ['loop', loop, cleanLoop],
  ['multipart duplicates', duplicates, cleanDuplicates],
];
