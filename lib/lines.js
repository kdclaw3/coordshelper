/** @fileoverview Bounded line overlap checks and explicit traversal-preserving repairs. */
import { fail, note } from './common.js';
import { bounds, candidatePairs } from './topology.js';
import { greatEllipseSegments, greatEllipseOverlap } from './great-ellipse.js';

function lineSegments(parts, ctx, path) {
  if (ctx.spatialType === 'geography') return greatEllipseSegments(parts, path);
  return parts.flatMap((points, group) =>
    points.slice(1).map((b, ordinal) => {
      const a = points[ordinal];
      const box = bounds([a, b]);
      return {
        a,
        b,
        group,
        ordinal,
        box,
      };
    }),
  );
}

function planarOverlap({ a, b }, { a: c, b: d }) {
  const cross = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (cross(c) !== 0 || cross(d) !== 0) return false;
  const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
  return (
    Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) >
    Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))
  );
}

/** Split affected original segments; retain complete unaffected runs and every Z/M vertex. */
export function normalizeLines(parts, type, ctx, path) {
  const affected = new Set();
  for (const [a, b] of candidatePairs(lineSegments(parts, ctx, path), ctx, path)) {
    if (
      !(ctx.spatialType === 'geography'
        ? greatEllipseOverlap(a, b)
        : planarOverlap(a, b))
    )
      continue;
    if (ctx.repair !== 'topology')
      fail(
        'LINE_OVERLAP',
        `overlapping ${ctx.spatialType} line segments; explicit topology repair can preserve traversal`,
        path,
      );
    affected.add(`${a.group}:${a.ordinal}`);
    affected.add(`${b.group}:${b.ordinal}`);
  }
  if (!affected.size)
    return { type, coordinates: type === 'LineString' ? parts[0] : parts };
  const geometries = [];
  const append = (points) => {
    if (points.length) geometries.push({ type: 'LineString', coordinates: points });
  };
  parts.forEach((points, group) => {
    if (!points.length) {
      geometries.push({ type: 'LineString', coordinates: [] });
      return;
    }
    let run = [];
    for (let i = 0; i < points.length - 1; i++) {
      if (affected.has(`${group}:${i}`)) {
        append(run);
        run = [];
        append([points[i], points[i + 1]]);
      } else {
        if (!run.length) run.push(points[i]);
        run.push(points[i + 1]);
      }
    }
    append(run);
  });
  note(ctx, 'LINE_OVERLAP_REPAIRED', path, {
    rule: 'isolate overlapping segments and retain unaffected directed runs',
    beforeType: type,
    afterType: 'GeometryCollection',
    components: geometries.length,
  });
  return { type: 'GeometryCollection', geometries };
}
