/** Synthetic worldwide multipart and repair controls, without customer data. */
import { square, globals } from './fixtures.js';

export const worldwideParts = {
  type: 'MultiPolygon',
  coordinates: [
    [square(-150, 40)],
    [square(-30, -20)],
    [square(90, 20)],
    [square(150, -40)],
  ],
};
export const worldwideHoles = {
  type: 'MultiPolygon',
  coordinates: worldwideParts.coordinates.map(([r]) => {
    const [x, y] = r[0];
    return [square(x, y, 2), square(x + 0.5, y + 0.5, 0.5).toReversed()];
  }),
};
export const polarCap = globals[1].geometry;
export const polarBowtie = {
  type: 'Polygon',
  coordinates: [
    [
      [-135, 80],
      [45, 80],
      [-45, 80],
      [135, 80],
      [-135, 80],
    ],
  ],
};
export const datelineBowtie = {
  type: 'Polygon',
  coordinates: [
    [
      [179, -1],
      [-179, 1],
      [179, 1],
      [-179, -1],
      [179, -1],
    ],
  ],
};
export const containingParts = {
  type: 'MultiPolygon',
  coordinates: [[square(-5, -5, 10)], [square(-1, -1, 2)]],
};
export const polarContainingParts = {
  type: 'MultiPolygon',
  coordinates: [
    polarCap.coordinates,
    [
      [
        [0, 89],
        [120, 89],
        [-120, 89],
        [0, 89],
      ],
    ],
  ],
};
