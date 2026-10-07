/** @fileoverview Bounded line overlap checks and explicit traversal-preserving repairs. */
import geographicLib from 'geographiclib-geodesic';
import { fail, note } from './common.js';
import { bounds, candidatePairs } from './topology.js';
const geodesic = geographicLib.Geodesic.WGS84;
const inverse = (a, b) => geodesic.Inverse(a[1], a[0], b[1], b[0]);

function lineSegments(parts, ctx) {
  return parts.flatMap((points, group) =>
    points.slice(1).map((b, ordinal) => {
      const a = points[ordinal];
      const box = bounds([a, b]);
      const direction = ctx.spatialType === 'geography' ? inverse(a, b) : null;
      if (direction) {
        // Conservative latitude envelope; longitude is monotone on a non-polar geodesic.
        const padding = ((direction.s12 / 6000000) * 180) / Math.PI + 1e-10;
        box.ymin = Math.max(-90, box.ymin - padding);
        box.ymax = Math.min(90, box.ymax + padding);
        if (Math.abs(a[0] - b[0]) >= 180 || box.ymin === -90 || box.ymax === 90) {
          box.xmin = -180;
          box.xmax = 180;
        } else {
          box.xmin -= 1e-10;
          box.xmax += 1e-10;
        }
      }
      return {
        a,
        b,
        group,
        ordinal,
        box,
        length: direction?.s12,
        azimuth: direction?.azi1,
      };
    }),
  );
}

function geodesicOverlap(ab, cd) {
  const acResult = inverse(ab.a, cd.a),
    adResult = inverse(ab.a, cd.b);
  const ac = acResult.s12,
    ad = adResult.s12;
  const epsilon = Math.max(1e-7, Math.max(ab.length, cd.length) * 1e-14);
  const aligned = (direction) => {
    if (direction.s12 <= epsilon) return true;
    const angle = Math.abs(((((direction.azi1 - ab.azimuth) % 360) + 540) % 360) - 180);
    return angle < 1e-10 || Math.abs(angle - 180) < 1e-10;
  };
  // Reject non-collinear candidates before the remaining inverse calculations.
  if (!aligned(acResult) || !aligned(adResult)) return false;
  const bc = inverse(ab.b, cd.a).s12,
    bd = inverse(ab.b, cd.b).s12;
  const close = (a, b) => Math.abs(a - b) <= epsilon;
  const interior = (a, b, length) => a > epsilon && b > epsilon && close(a + b, length);
  const collinear = (a, b, length) =>
    close(a + b, length) || close(Math.abs(a - b), length);
  const identical = (close(ac, 0) && close(bd, 0)) || (close(ad, 0) && close(bc, 0));
  return (
    ab.length > epsilon &&
    cd.length > epsilon &&
    (identical ||
      (interior(ac, bc, ab.length) && collinear(ad, bd, ab.length)) ||
      (interior(ad, bd, ab.length) && collinear(ac, bc, ab.length)) ||
      (interior(ac, ad, cd.length) && collinear(bc, bd, cd.length)) ||
      (interior(bc, bd, cd.length) && collinear(ac, ad, cd.length)))
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
  for (const [a, b] of candidatePairs(lineSegments(parts, ctx), ctx, path)) {
    if (
      !(ctx.spatialType === 'geography' ? geodesicOverlap(a, b) : planarOverlap(a, b))
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
