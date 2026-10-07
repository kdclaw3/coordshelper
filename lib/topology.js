/** @fileoverview Bounded broad-phase filtering shared by topology checks. */
import { fail } from './common.js';

export function budget(ctx, path = '$') {
  if (ctx && ++ctx.topologyChecks > ctx.maxTopologyChecks)
    fail(
      'LIMIT',
      'topology comparison limit exceeded; increase maxTopologyChecks explicitly',
      path,
    );
}
export function bounds(points) {
  let xmin = Infinity,
    ymin = Infinity,
    xmax = -Infinity,
    ymax = -Infinity;
  for (const [x, y] of points) {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  return { xmin, ymin, xmax, ymax };
}
export const intersects = (a, b) =>
  a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;

/** Sweep candidates in X; only potentially intersecting boxes consume pair budget. */
export function* candidatePairs(items, ctx, path = '$') {
  const sorted = items
    .map((item, i) => ({ ...item, index: i }))
    .sort((a, b) => a.box.xmin - b.box.xmin);
  let active = [];
  for (const item of sorted) {
    active = active.filter((other) => other.box.xmax >= item.box.xmin);
    for (const other of active) {
      // Count broad-phase work too, so adversarial vertically stacked input remains bounded.
      budget(ctx, path);
      if (intersects(item.box, other.box)) yield [item, other];
    }
    active.push(item);
  }
}
export function segments(points, group = 0) {
  return points.slice(1).map((b, i) => ({
    a: points[i],
    b,
    group,
    ordinal: i,
    box: bounds([points[i], b]),
  }));
}
