/**
 * @fileoverview Analytic local circular-ring classification for Esri inputs.
 * Output keeps the original arcs. Only planar circle math is used to identify local ring
 * roles/direction; global/polar geography curves and ambiguous contacts are rejected.
 */
import { fail, note, equalXY } from './common.js';
import { budget, bounds, candidatePairs } from './topology.js';
const TAU = 2 * Math.PI;
const angle = (value) => ((value % TAU) + TAU) % TAU;
const xy = (p, q) => [p[0] - q[0], p[1] - q[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const tolerance = (...values) =>
  Math.max(1e-12, ...values.map((v) => Math.abs(v) * 1e-12));
const at = (p, t) => [p.cx + p.r * Math.cos(t), p.cy + p.r * Math.sin(t)];
const onArc = (p, t, strict = false) => {
  const distance = p.sweep > 0 ? angle(t - p.start) : angle(p.start - t);
  return strict
    ? distance > 1e-10 && distance < Math.abs(p.sweep) - 1e-10
    : distance <= Math.abs(p.sweep) + 1e-10 || Math.abs(distance - TAU) < 1e-10;
};
function line(a, b) {
  return { a, b, box: bounds([a, b]) };
}
function arc(a, m, b, path) {
  const u = xy(m, a),
    v = xy(b, a),
    determinant = 2 * cross(u, v);
  if (determinant === 0) return [line(a, m), line(m, b)];
  const uu = u[0] ** 2 + u[1] ** 2,
    vv = v[0] ** 2 + v[1] ** 2;
  const cx = a[0] + (uu * v[1] - vv * u[1]) / determinant;
  const cy = a[1] + (u[0] * vv - v[0] * uu) / determinant;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  if (![cx, cy, r].every(Number.isFinite) || !r)
    fail('CURVE', 'unstable circular arc', path);
  const start = Math.atan2(a[1] - cy, a[0] - cx);
  const end = Math.atan2(b[1] - cy, b[0] - cx);
  const mid = Math.atan2(m[1] - cy, m[0] - cx);
  const forward = angle(end - start);
  const p = {
    a,
    b,
    cx,
    cy,
    r,
    start,
    sweep: angle(mid - start) < forward ? forward : forward - TAU,
  };
  const points = [a, b];
  for (const t of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2])
    if (onArc(p, t)) points.push(at(p, t));
  p.box = bounds(points);
  return [p];
}
function primitives(ring, path) {
  if (ring.type === 'CompoundCurve')
    return ring.segments.flatMap((s, i) => primitives(s, `${path}.segments[${i}]`));
  const c = ring.coordinates;
  if (ring.type === 'LineString') return c.slice(1).map((b, i) => line(c[i], b));
  const result = [];
  for (let i = 0; i < c.length - 2; i += 2)
    result.push(...arc(c[i], c[i + 1], c[i + 2], path));
  return result;
}
function onLine(p, l) {
  const v = xy(l.b, l.a),
    w = xy(p, l.a),
    eps = tolerance(...v, ...w);
  return (
    Math.abs(cross(v, w)) <= eps * Math.max(1, Math.hypot(...v)) &&
    p[0] >= l.box.xmin - eps &&
    p[0] <= l.box.xmax + eps &&
    p[1] >= l.box.ymin - eps &&
    p[1] <= l.box.ymax + eps
  );
}
function onPrimitive(p, item) {
  return item.r === undefined
    ? onLine(p, item)
    : Math.abs(Math.hypot(p[0] - item.cx, p[1] - item.cy) - item.r) <=
        tolerance(item.r) && onArc(item, Math.atan2(p[1] - item.cy, p[0] - item.cx));
}
function contacts(a, b) {
  if (a.r === undefined && b.r === undefined) {
    const u = xy(a.b, a.a),
      v = xy(b.b, b.a),
      w = xy(b.a, a.a),
      d = cross(u, v);
    if (d === 0) {
      const points = [a.a, a.b, b.a, b.b].filter((p) => onLine(p, a) && onLine(p, b));
      return {
        points,
        overlap: points.some((p) => points.some((q) => !equalXY(p, q))),
      };
    }
    const t = cross(w, v) / d,
      s = cross(w, u) / d;
    return {
      points:
        t >= 0 && t <= 1 && s >= 0 && s <= 1
          ? [[a.a[0] + t * u[0], a.a[1] + t * u[1]]]
          : [],
    };
  }
  if (a.r === undefined || b.r === undefined) {
    const l = a.r === undefined ? a : b,
      c = a.r === undefined ? b : a;
    const v = xy(l.b, l.a),
      w = [l.a[0] - c.cx, l.a[1] - c.cy];
    const A = v[0] ** 2 + v[1] ** 2,
      B = 2 * (v[0] * w[0] + v[1] * w[1]),
      C = w[0] ** 2 + w[1] ** 2 - c.r ** 2;
    const D = B ** 2 - 4 * A * C;
    if (D < -tolerance(B ** 2, 4 * A * C)) return { points: [] };
    const roots = [
      (-B + Math.sqrt(Math.max(0, D))) / (2 * A),
      (-B - Math.sqrt(Math.max(0, D))) / (2 * A),
    ];
    return {
      points: roots
        .filter((t) => t >= -1e-12 && t <= 1 + 1e-12)
        .map((t) => [l.a[0] + t * v[0], l.a[1] + t * v[1]])
        .filter((p) => onPrimitive(p, c)),
    };
  }
  const dx = b.cx - a.cx,
    dy = b.cy - a.cy,
    distance = Math.hypot(dx, dy),
    eps = tolerance(a.r, b.r);
  if (distance <= eps && Math.abs(a.r - b.r) <= eps) {
    const overlap =
      onArc(b, a.start + a.sweep / 2, true) ||
      onArc(a, b.start + b.sweep / 2, true) ||
      [a.a, a.b].some((p) => onArc(b, Math.atan2(p[1] - b.cy, p[0] - b.cx), true));
    return {
      points: [a.a, a.b, b.a, b.b].filter(
        (p) => onPrimitive(p, a) && onPrimitive(p, b),
      ),
      overlap,
    };
  }
  if (
    distance > a.r + b.r + eps ||
    distance < Math.abs(a.r - b.r) - eps ||
    distance === 0
  )
    return { points: [] };
  const along = (a.r ** 2 - b.r ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, a.r ** 2 - along ** 2));
  const x = a.cx + (along * dx) / distance,
    y = a.cy + (along * dy) / distance;
  return {
    points: [
      [x - (height * dy) / distance, y + (height * dx) / distance],
      [x + (height * dy) / distance, y - (height * dx) / distance],
    ].filter((p) => onPrimitive(p, a) && onPrimitive(p, b)),
  };
}
/** Horizontal-ray crossings split arcs at Y extrema, avoiding tangent double counts. */
function contains(point, items, ctx) {
  let crossings = 0;
  for (const item of items) {
    budget(ctx);
    if (onPrimitive(point, item)) return 0;
    if (item.r === undefined) {
      const [x, y] = point,
        a = item.a,
        b = item.b;
      if (
        a[1] > y !== b[1] > y &&
        x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
      )
        crossings++;
      continue;
    }
    const fractions = [0, 1];
    for (const t of [Math.PI / 2, (3 * Math.PI) / 2])
      if (onArc(item, t, true))
        fractions.push(
          (item.sweep > 0 ? angle(t - item.start) : angle(item.start - t)) /
            Math.abs(item.sweep),
        );
    fractions.sort((a, b) => a - b);
    const sine = (point[1] - item.cy) / item.r;
    if (Math.abs(sine) > 1) continue;
    for (let i = 1; i < fractions.length; i++) {
      const start = item.start + fractions[i - 1] * item.sweep,
        end = item.start + fractions[i] * item.sweep;
      const startY = fractions[i - 1] === 0 ? item.a[1] : at(item, start)[1];
      const endY = fractions[i] === 1 ? item.b[1] : at(item, end)[1];
      const eps = tolerance(item.r);
      if (startY > point[1] + eps === endY > point[1] + eps) continue;
      const section = { ...item, start, sweep: end - start };
      const t = [Math.asin(sine), Math.PI - Math.asin(sine)].find((value) =>
        onArc(section, value),
      );
      if (t !== undefined && at(item, t)[0] > point[0]) crossings++;
    }
  }
  return crossings % 2 ? 1 : -1;
}
function signedArea(items) {
  const origin = items[0].a;
  return items.reduce((sum, p) => {
    const a = xy(p.a, origin),
      b = xy(p.b, origin);
    return (
      sum +
      (p.r === undefined
        ? cross(a, b)
        : (p.cx - origin[0]) * (b[1] - a[1]) -
          (p.cy - origin[1]) * (b[0] - a[0]) +
          p.r ** 2 * p.sweep) /
        2
    );
  }, 0);
}
function reverse(ring) {
  return ring.type === 'CompoundCurve'
    ? { type: ring.type, segments: [...ring.segments].reverse().map(reverse) }
    : { type: ring.type, coordinates: [...ring.coordinates].reverse() };
}

/** Sort shells/holes without flattening output arcs; reject ambiguous curved topology. */
export function normalizeCurveRings(rings, ctx, path) {
  if (ctx.orientation === 'preserve')
    fail(
      'CURVE_WINDING',
      'Esri curved rings require normalized winding; use fromSpatial for explicit interiors',
      path,
    );
  const items = rings.map((r, i) => primitives(r, `${path}[${i}]`));
  const flat = items.flatMap((parts, group) =>
    parts.map((p, ordinal) => ({ ...p, group, ordinal })),
  );
  if (ctx.spatialType === 'geography') {
    const box = bounds(
      flat.flatMap((p) => [
        [p.box.xmin, p.box.ymin],
        [p.box.xmax, p.box.ymax],
      ]),
    );
    if (
      box.xmax - box.xmin > 10 ||
      box.ymax - box.ymin > 10 ||
      box.ymin < -80 ||
      box.ymax > 80
    )
      fail(
        'CURVE_GLOBAL',
        'Esri curved geography classification is limited to local non-polar extents (10 degrees); use explicit spatial input',
        path,
      );
  }
  for (const [a, b] of candidatePairs(flat, ctx, path)) {
    const hit = contacts(a, b);
    if (!hit.points.length && !hit.overlap) continue;
    const adjacent =
      a.group === b.group &&
      (Math.abs(a.ordinal - b.ordinal) === 1 ||
        Math.abs(a.ordinal - b.ordinal) === items[a.group].length - 1);
    const sharedEndpoint = (p) =>
      [a.a, a.b].some((q) => Math.hypot(...xy(p, q)) <= tolerance(...p, ...q)) &&
      [b.a, b.b].some((q) => Math.hypot(...xy(p, q)) <= tolerance(...p, ...q));
    if (hit.overlap || !adjacent || hit.points.some((p) => !sharedEndpoint(p)))
      fail(
        'CURVE_TOPOLOGY',
        'crossing, touching or overlapping curved rings require explicit unambiguous input',
        path,
      );
  }
  const areas = items.map(signedArea);
  if (areas.some((a) => !Number.isFinite(a) || a === 0))
    fail('COLLAPSED', 'curved ring has zero or unstable signed area', path);
  const parents = items.map((parts, i) => {
    const containers = items
      .map((other, j) => ({
        j,
        inside: j !== i && contains(parts[0].a, other, ctx) === 1,
      }))
      .filter((v) => v.inside)
      .sort((a, b) => Math.abs(areas[a.j]) - Math.abs(areas[b.j]));
    return containers[0]?.j ?? -1;
  });
  const depth = (i) => {
    let n = 0;
    const seen = new Set();
    while (parents[i] !== -1) {
      if (seen.has(i) || n >= ctx.maxDepth)
        fail('CURVE_TOPOLOGY', 'ambiguous or excessive curved nesting', path);
      seen.add(i);
      i = parents[i];
      n++;
    }
    return n;
  };
  const oriented = rings.map((r, i) => {
    const hole = depth(i) % 2 === 1;
    if (areas[i] > 0 === !hole) return r;
    if (ctx.repair === 'none')
      fail('WINDING', 'incorrect curved ring winding', `${path}[${i}]`);
    note(
      ctx,
      'REWOUND',
      `${path}[${i}]`,
      hole
        ? 'Reversed curved hole clockwise'
        : 'Reversed curved shell counterclockwise',
    );
    return reverse(r);
  });
  const polygons = new Map();
  oriented.forEach((r, i) => {
    if (depth(i) % 2 === 0) polygons.set(i, { type: 'CurvePolygon', rings: [r] });
  });
  oriented.forEach((r, i) => {
    if (depth(i) % 2 === 1) polygons.get(parents[i]).rings.push(r);
  });
  note(
    ctx,
    'SQL_VALIDATION_REQUIRED',
    path,
    'Local analytic ring roles are normalized; verify curved interiors and topology in the target SQL engine',
  );
  const geometries = [...polygons.values()];
  return geometries.length === 1
    ? geometries[0]
    : { type: 'GeometryCollection', geometries };
}
