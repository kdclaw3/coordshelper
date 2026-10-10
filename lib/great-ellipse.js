/**
 * @fileoverview Exact central projection for SQL Server's WGS84 great elliptic edges.
 * A plane through the ellipsoid centre becomes a straight line in this chart.
 * The chart is used only for topology; output coordinates stay in the target CRS.
 */
import { fail } from './common.js';
import { budget } from './topology.js';

const radians = Math.PI / 180;
const flattening = 1 / 298.257223563;
const polarScale = (1 - flattening) ** 2;
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => {
  const length = Math.hypot(...v);
  return v.map((n) => n / length);
};

/** Radial ECEF direction, including geodetic/geocentric latitude conversion. */
export function direction([longitude, latitude]) {
  const lon = longitude * radians;
  const lat = latitude * radians;
  if (Math.abs(latitude) === 90) return [0, 0, Math.sign(latitude)];
  return unit([
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    polarScale * Math.sin(lat),
  ]);
}

/** Bound the complete curved edge in radial XYZ, not just its endpoint rectangle. */
function arcSegment(a, b, group, ordinal, path) {
  const start = direction(a),
    end = direction(b);
  // Subtracting two global XYZ products loses the normal of a centimetre-scale
  // edge. Rotate to the first longitude and use angle differences instead.
  const lon = a[0] * radians,
    lat = a[1] * radians,
    otherLat = b[1] * radians;
  const delta = (b[0] - a[0]) * radians;
  const sinDelta = Math.sin(delta),
    cosDeltaMinusOne = -2 * Math.sin(delta / 2) ** 2;
  const nx = -polarScale * Math.sin(lat) * Math.cos(otherLat) * sinDelta;
  const ny =
    polarScale *
    (Math.sin((a[1] - b[1]) * radians) +
      Math.sin(lat) * Math.cos(otherLat) * cosDeltaMinusOne);
  const nz = Math.cos(lat) * Math.cos(otherLat) * sinDelta;
  const plane =
    Math.abs(a[1]) === 90 || Math.abs(b[1]) === 90
      ? cross(start, end)
      : [
          nx * Math.cos(lon) - ny * Math.sin(lon),
          nx * Math.sin(lon) + ny * Math.cos(lon),
          nz,
        ];
  const normal = unit(plane);
  const tangent = cross(normal, start);
  const radius = (latitude) =>
    Math.hypot(Math.cos(latitude), polarScale * Math.sin(latitude));
  const scale =
    Math.abs(a[1]) === 90 || Math.abs(b[1]) === 90 ? 1 : radius(lat) * radius(otherLat);
  const length = Math.atan2(Math.hypot(...plane) / scale, dot(start, end));
  if (!normal.every(Number.isFinite) || Math.PI - length < 1e-12)
    fail(
      'GEOGRAPHY_UNCERTAIN',
      'degenerate or nearly antipodal great elliptic edge',
      path,
    );
  const ranges = start.map((value, axis) => {
    const values = [value, end[axis]];
    const extremum = Math.atan2(tangent[axis], value);
    for (let k = -1; k <= 2; k++) {
      const angle = extremum + k * Math.PI;
      if (angle > 0 && angle < length)
        values.push(value * Math.cos(angle) + tangent[axis] * Math.sin(angle));
    }
    return [
      Math.min(...values) - 32 * Number.EPSILON,
      Math.max(...values) + 32 * Number.EPSILON,
    ];
  });
  return { a, b, group, ordinal, path, start, end, normal, tangent, length, ranges };
}

/** Choose the two widest XYZ axes for the existing bounded interval sweep. */
export function greatEllipseSegments(
  parts,
  path,
  edgePath = (group, ordinal) => `${path}[${group}][${ordinal}]`,
) {
  const segments = parts.flatMap((p, group) =>
    p
      .slice(1)
      .map((b, ordinal) =>
        arcSegment(p[ordinal], b, group, ordinal, edgePath(group, ordinal)),
      ),
  );
  const extent = [0, 1, 2]
    .map((axis) => {
      let min = Infinity,
        max = -Infinity;
      for (const segment of segments) {
        min = Math.min(min, segment.ranges[axis][0]);
        max = Math.max(max, segment.ranges[axis][1]);
      }
      return { axis, width: max - min };
    })
    .sort((a, b) => b.width - a.width);
  const [x, y, z] = extent.map((v) => v.axis);
  return segments.map((s) => ({
    ...s,
    box: {
      xmin: s.ranges[x][0],
      xmax: s.ranges[x][1],
      ymin: s.ranges[y][0],
      ymax: s.ranges[y][1],
    },
    remainingAxis: z,
  }));
}

/** Positive-length overlap on the same central plane; crossings are valid for lines. */
export function greatEllipseOverlap(a, b) {
  const axis = a.remainingAxis;
  if (a.ranges[axis][0] > b.ranges[axis][1] || b.ranges[axis][0] > a.ranges[axis][1])
    return false;
  const epsilon = 64 * Number.EPSILON;
  if (
    Math.abs(dot(a.normal, b.start)) > epsilon ||
    Math.abs(dot(a.normal, b.end)) > epsilon
  )
    return false;
  let start = Math.atan2(dot(b.start, a.tangent), dot(b.start, a.start));
  let end = Math.atan2(dot(b.end, a.tangent), dot(b.end, a.start));
  if (end - start > Math.PI) end -= 2 * Math.PI;
  if (start - end > Math.PI) start -= 2 * Math.PI;
  for (const shift of [-2 * Math.PI, 0, 2 * Math.PI])
    if (
      Math.min(a.length, Math.max(start, end) + shift) -
        Math.max(0, Math.min(start, end) + shift) >
      epsilon
    )
      return true;
  return false;
}

/** Refuse a horizon crossing: one chart cannot certify such a global boundary. */
export function greatEllipseChart(rings, path, ctx) {
  const vertices = rings.flatMap((r) =>
    r.slice(0, -1).map((p) => ({
      vector: direction(p),
      path: ctx?.ringChecks.get(r)?.path ?? path,
    })),
  );
  const vectors = vertices.map((v) => v.vector);
  let centre = unit(vectors.reduce((sum, v) => sum.map((n, i) => n + v[i]), [0, 0, 0]));
  // A long unevenly sampled boundary can bias the mean. A bounded separating-plane
  // search improves the chart without relaxing its open-hemisphere requirement.
  for (let iteration = 0; iteration < 32; iteration++) {
    let worst = vectors[0],
      minimum = Infinity;
    for (const { vector: v, path: vertexPath } of vertices) {
      budget(ctx, vertexPath);
      const value = dot(centre, v);
      if (value < minimum) {
        minimum = value;
        worst = v;
      }
    }
    if (minimum > 1e-6) break;
    centre = unit(centre.map((n, i) => n + worst[i]));
  }
  if (!centre.every(Number.isFinite) || vectors.some((v) => dot(centre, v) <= 1e-6))
    fail(
      'GEOGRAPHY_UNCERTAIN',
      'great-ellipse topology requires a boundary inside one open hemisphere; split the shape or validate with SQL Server explicitly',
      path,
    );
  const axis = Math.abs(centre[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const east = unit(cross(axis, centre));
  const north = cross(centre, east);
  let originals;
  // The convex cap bounds the filled interior too, including a polar cap's pole.
  // A boundary-only box would incorrectly prune contained polygons.
  // atan2 retains sub-metre radii that acos(dot) rounds down to zero.
  const radius = vectors.reduce(
    (maximum, v) =>
      Math.max(maximum, Math.atan2(Math.hypot(...cross(centre, v)), dot(centre, v))),
    0,
  );
  const cosine = Math.cos(radius),
    sine = Math.sin(radius);
  const padding = 64 * Number.EPSILON;
  const ranges = centre.map((value) => [
    (-value >= cosine
      ? -1
      : value * cosine - Math.sqrt(Math.max(0, 1 - value ** 2)) * sine) - padding,
    (value >= cosine
      ? 1
      : value * cosine + Math.sqrt(Math.max(0, 1 - value ** 2)) * sine) + padding,
  ]);
  return {
    cap: { centre, radius, ranges },
    project(p) {
      const v = direction(p),
        denominator = dot(v, centre);
      return [dot(v, east) / denominator, dot(v, north) / denominator];
    },
    // Seed only for actual repair, using already projected vertices without extra math.
    rememberOriginals(rings, projected) {
      originals = new Map();
      rings.forEach((ring, i) =>
        ring.forEach((p, j) => {
          const [x, y] = projected[i][j];
          originals.set(`${x}:${y}`, p);
        }),
      );
    },
    unproject([x, y]) {
      const original = originals?.get(`${x}:${y}`);
      if (original) return [...original];
      const v = centre.map((n, i) => n + x * east[i] + y * north[i]);
      return [
        Math.atan2(v[1], v[0]) / radians,
        Math.atan2(v[2] / polarScale, Math.hypot(v[0], v[1])) / radians,
      ];
    },
  };
}
