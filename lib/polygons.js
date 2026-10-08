/**
 * @fileoverview Polygon ring roles, winding and explicit local topology repairs.
 * Linear geography topology uses local great-ellipse charts; uncertain boundaries are refused.
 */
import * as clipping from 'polyclip-ts';
import { fail, note, sequence } from './common.js';
import { greatEllipseChart } from './great-ellipse.js';
import {
  budget,
  bounds,
  intersects,
  candidatePairs,
  segments,
  intervalIndex,
} from './topology.js';

function planarArea(ring) {
  // Translate to the first vertex to reduce cancellation at large coordinates.
  const [x, y] = ring[0];
  let area = 0;
  for (let i = 1; i < ring.length; i++)
    area +=
      (ring[i - 1][0] - x) * (ring[i][1] - y) - (ring[i][0] - x) * (ring[i - 1][1] - y);
  return area / 2;
}
function orient(ring, hole, ctx, path, chart) {
  const area = chart ? planarArea(ring.map((p) => chart.project(p))) : planarArea(ring);
  if (!Number.isFinite(area) || area === 0)
    fail('COLLAPSED', 'polygon has zero signed area', path);
  // preserve allows callers to deliberately select a geography interior larger than a hemisphere.
  if (ctx.orientation === 'preserve') {
    if (chart && hole && area > 0)
      fail('WINDING', 'a preserved geography hole must have clockwise winding', path);
    return ring;
  }
  if (area > 0 === !hole) return ring;
  if (ctx.repair === 'none') fail('WINDING', 'incorrect polygon ring winding', path);
  note(
    ctx,
    'REWOUND',
    path,
    hole
      ? 'Oriented interior ring clockwise'
      : 'Oriented exterior ring counterclockwise',
  );
  return preserveRingPath(ring, [...ring].reverse(), ctx);
}
function cross(a, b, c, ctx) {
  const u = [b[0] - a[0], b[1] - a[1]],
    v = [c[0] - a[0], c[1] - a[1]];
  const value = u[0] * v[1] - u[1] * v[0];
  // Central projection adds rounding at the scale of unit Earth directions.
  // This bound is sub-micrometre locally, not a GIS snapping/repair tolerance.
  const error =
    64 *
    Number.EPSILON *
    (Math.abs(u[0] * v[1]) + Math.abs(u[1] * v[0]) + Math.hypot(...u));
  return ctx?.spatialType === 'geography' && Math.abs(value) <= error ? 0 : value;
}
function onSegment(p, a, b, ctx) {
  const epsilon = ctx?.spatialType === 'geography' ? 64 * Number.EPSILON : 0;
  return (
    cross(a, b, p, ctx) === 0 &&
    p[0] >= Math.min(a[0], b[0]) - epsilon &&
    p[0] <= Math.max(a[0], b[0]) + epsilon &&
    p[1] >= Math.min(a[1], b[1]) - epsilon &&
    p[1] <= Math.max(a[1], b[1]) + epsilon
  );
}
function intersection(a, b, c, d, ctx) {
  const abC = cross(a, b, c, ctx),
    abD = cross(a, b, d, ctx),
    cdA = cross(c, d, a, ctx),
    cdB = cross(c, d, b, ctx);
  if (abC * abD < 0 && cdA * cdB < 0) return 'cross';
  if (abC === 0 && abD === 0) {
    const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
    const overlap =
      Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
      Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
    if (overlap > 0) return 'overlap';
  }
  return onSegment(a, c, d, ctx) ||
    onSegment(b, c, d, ctx) ||
    onSegment(c, a, b, ctx) ||
    onSegment(d, a, b, ctx)
    ? 'touch'
    : null;
}
// Internal rings remain immutable. Completed checks are scoped to this conversion only.
function ringInfo(r, ctx, path = '$') {
  let info = ctx?.ringChecks.get(r);
  if (!info) {
    info = {
      path,
      box: bounds(r),
      segments: segments(r),
      area: planarArea(r),
      pairs: new WeakMap(),
      locations: new WeakMap(),
      rayIndex: null,
    };
    ctx?.ringChecks.set(r, info);
  }
  return info;
}
function selfIssue(r, ctx, path) {
  const info = ringInfo(r, ctx, path);
  const sourceInfo = ringInfo(info.source ?? r, ctx, path);
  if (Object.hasOwn(sourceInfo, 'self')) return sourceInfo.self;
  let found = null;
  for (const [a, b] of candidatePairs(info.segments, ctx, info.path)) {
    const distance = Math.abs(a.ordinal - b.ordinal);
    if (distance === 1 || distance === r.length - 2) continue;
    if (intersection(a.a, a.b, b.a, b.b, ctx)) {
      found = 'SELF_INTERSECTION';
      break;
    }
  }
  sourceInfo.self = found;
  return found;
}
function ringRelation(a, b, ctx, path) {
  const leftInfo = ringInfo(a, ctx, path),
    rightInfo = ringInfo(b, ctx, path);
  const leftSource = leftInfo.source ?? a,
    rightSource = rightInfo.source ?? b;
  const leftCache = ringInfo(leftSource, ctx),
    rightCache = ringInfo(rightSource, ctx);
  if (leftCache.pairs.has(rightSource)) return leftCache.pairs.get(rightSource);
  budget(ctx, leftInfo.path, rightInfo.path);
  const relation = { cross: false, touch: false };
  if (intersects(leftInfo.box, rightInfo.box)) {
    for (const [left, right] of candidatePairs(
      [
        ...leftInfo.segments.map((s) => ({ ...s, group: 0 })),
        ...rightInfo.segments.map((s) => ({ ...s, group: 1 })),
      ],
      ctx,
      leftInfo.path,
      true,
      rightInfo.path,
    )) {
      const kind = intersection(left.a, left.b, right.a, right.b, ctx);
      if (kind === 'cross' || kind === 'overlap') {
        relation.cross = true;
        break;
      }
      if (kind === 'touch') relation.touch = true;
    }
  }
  leftCache.pairs.set(rightSource, relation);
  rightCache.pairs.set(leftSource, relation);
  return relation;
}
function ringIntersection(a, b, ctx, path) {
  return ringRelation(a, b, ctx, path).cross;
}
function contains(p, r, ctx, path) {
  const info = ringInfo(r, ctx, path);
  budget(ctx, path ?? info.path, path === info.path ? undefined : info.path);
  const box = info.box;
  if (p[0] < box.xmin || p[0] > box.xmax || p[1] < box.ymin || p[1] > box.ymax)
    return -1;
  let inside = false;
  info.rayIndex ??= intervalIndex(
    info.segments,
    (s) => s.box.ymin,
    (s) => s.box.ymax,
  );
  for (const { a, b } of info.rayIndex(p[1], p[1], ctx, path ?? info.path, info.path)) {
    budget(ctx, path ?? info.path, path === info.path ? undefined : info.path);
    if (onSegment(p, a, b, ctx)) return 0;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}
function* representativePoints(r, touching) {
  for (let i = 0; i < r.length - 1; i++) {
    yield r[i];
    // Touching at vertices can conceal entry/exit; test intervening edge interiors too.
    if (touching) yield [(r[i][0] + r[i + 1][0]) / 2, (r[i][1] + r[i + 1][1]) / 2];
  }
}
function ringLocation(a, b, ctx) {
  const info = ringInfo(a, ctx);
  const sourceInfo = ringInfo(info.source ?? a, ctx);
  const otherSource = ringInfo(b, ctx).source ?? b;
  if (sourceInfo.locations.has(otherSource))
    return sourceInfo.locations.get(otherSource);
  const relation = ringRelation(a, b, ctx);
  const result = { inside: false, outside: false };
  for (const p of representativePoints(a, relation.touch)) {
    const location = contains(p, b, ctx, info.path);
    if (location === 1) result.inside = true;
    if (location === -1) result.outside = true;
    // A simple ring with no boundary contact cannot change sides without crossing.
    if (!relation.touch && location !== 0) break;
    if (result.inside && result.outside) break;
  }
  sourceInfo.locations.set(otherSource, result);
  return result;
}
function insidePolygon(p, poly, ctx, path) {
  const shell = contains(p, poly[0], ctx, path);
  if (shell !== 1) return shell;
  for (const hole of poly.slice(1)) {
    const value = contains(p, hole, ctx, path);
    if (value >= 0) return value === 0 ? 0 : -1;
  }
  return 1;
}
function ringInsidePolygon(r, poly, ctx) {
  const touching = poly.some((other) => ringRelation(r, other, ctx).touch);
  if (!touching)
    return (
      ringLocation(r, poly[0], ctx).inside &&
      !poly.slice(1).some((hole) => ringLocation(r, hole, ctx).inside)
    );
  for (const p of representativePoints(r, touching)) {
    const where = insidePolygon(p, poly, ctx, ringInfo(r, ctx).path);
    if (where === 1) return true;
  }
  return false;
}
function partsOverlap(a, b, ctx) {
  return (
    a.some((r) => b.some((s) => ringIntersection(r, s, ctx))) ||
    ringInsidePolygon(a[0], b, ctx) ||
    ringInsidePolygon(b[0], a, ctx)
  );
}
function issues(polys, ctx, path = '$') {
  const errors = new Set();
  for (const p of polys) {
    p.forEach((r) => {
      const issue = selfIssue(r, ctx, path);
      if (issue) errors.add(issue);
    });
    p.slice(1).forEach((h, i) => {
      if (ringIntersection(p[0], h, ctx) || ringLocation(h, p[0], ctx).outside)
        errors.add('HOLE_OUTSIDE');
      for (const other of p.slice(i + 2))
        if (
          ringIntersection(h, other, ctx) ||
          ringLocation(h, other, ctx).inside ||
          ringLocation(other, h, ctx).inside
        )
          errors.add('OVERLAPPING_HOLES');
    });
  }
  for (let i = 0; i < polys.length; i++)
    for (let j = i + 1; j < polys.length; j++) {
      if (partsOverlap(polys[i], polys[j], ctx)) errors.add('OVERLAPPING_POLYGONS');
    }
  return [...errors];
}
/** Repair only under the selected policy, then orient shells and holes independently. */
function normalizeInChart(polys, type, ctx, path) {
  if (!polys.length) return { type, coordinates: [] };
  polys.forEach((p, i) =>
    p.forEach((r, j) =>
      ringInfo(r, ctx, type === 'Polygon' ? `${path}[${j}]` : `${path}[${i}][${j}]`),
    ),
  );
  // Central projection straightens the actual great elliptic edges, including
  // dateline and polar boundaries. Never certify topology on a flat lon/lat map.
  const { chart, projected } = projectRings(polys, ctx, path);
  if (
    chart &&
    ctx.orientation === 'preserve' &&
    projected.some((p) => planarArea(p[0]) < 0 && (p.length > 1 || polys.length > 1))
  )
    fail(
      'GEOGRAPHY_UNCERTAIN',
      'preserved complementary interiors with holes or multipart members require explicit SQL Server validation',
      path,
    );
  const found = issues(projected, ctx, path);
  let normalized = polys;
  if (found.length) {
    if (ctx.repair !== 'topology')
      fail(
        'TOPOLOGY',
        `invalid polygon topology (${found.join(', ')}); use explicit topology repair`,
        path,
      );
    if (ctx.orientation === 'preserve')
      fail(
        'GLOBAL_REPAIR',
        'topology repair cannot infer a deliberately preserved global interior',
        path,
      );
    if (polys.some((p) => p.some((r) => r.some((v) => v.length !== 2))))
      fail(
        'REPAIR_DIMENSION',
        'topology repair would discard altitude or measures',
        path,
      );
    let fixed;
    chart?.rememberOriginals(polys.flat(), projected.flat());
    try {
      fixed = clipping.union(projected);
    } catch (cause) {
      fail('TOPOLOGY', 'polygon topology repair failed', path, { cause });
    }
    if (!fixed.length) fail('COLLAPSED', 'topology repair collapsed the polygon', path);
    fixed.forEach((p, i) =>
      p.forEach((r, j) => ringInfo(r, ctx, `${path}.repaired[${i}][${j}]`)),
    );
    if (issues(fixed, ctx, path).length)
      fail(
        'TOPOLOGY',
        'topology repair did not produce a supported simple polygon',
        path,
      );
    normalized = fixed.map((p) => p.map((r) => repairedRing(r, chart, ctx)));
    // Canonicalizing inverse-projected vertices must not introduce invalid topology.
    if (issues(projectRings(normalized, ctx, path).projected, ctx, path).length)
      fail('TOPOLOGY', 'normalized repair output has invalid topology', path);
    note(ctx, 'TOPOLOGY_REPAIRED', path, {
      issues: found,
      rule: chart
        ? 'great-ellipse chart shell union minus holes'
        : 'nonzero shell union minus holes',
      beforeParts: polys.length,
      afterParts: fixed.length,
    });
    if (fixed.length > 1) type = 'MultiPolygon';
  }
  if (normalized.length > 1 && type === 'Polygon') type = 'MultiPolygon';
  normalized = normalized.map((p) =>
    p.map((r, j) => orient(r, j > 0, ctx, ringInfo(r, ctx).path, chart)),
  );
  return { type, coordinates: type === 'Polygon' ? normalized[0] : normalized };
}
/** Keep the source/repaired ring provenance when longitude normalization makes a copy. */
function preserveRingPath(source, copy, ctx) {
  const info = ringInfo(source, ctx);
  ringInfo(copy, ctx, info.path).source = info.source ?? source;
  return copy;
}
/** Repaired coordinates are already in the target CRS; never reproject them. */
function repairedRing(r, chart, ctx) {
  const path = ringInfo(r, ctx).path;
  const coordinates = sequence(
    r.map((p) => (chart ? chart.unproject(p) : p)),
    ctx,
    path,
    { ring: true, extended: true, projected: true },
  );
  // This is new geometry, so only provenance (not the pre-repair checks) is retained.
  ringInfo(coordinates, ctx, path);
  return coordinates;
}
/** Esri classification and final normalization reuse the same chart and ring checks. */
function projectRings(polys, ctx, path) {
  if (ctx.spatialType !== 'geography') return { chart: null, projected: polys };
  ctx.ellipseCharts ??= new WeakMap();
  const rings = polys.flat();
  const records = ctx.ellipseCharts.get(rings[0]) ?? [];
  let record = records.find(
    (v) => v.rings.length === rings.length && rings.every((r) => v.rings.includes(r)),
  );
  if (!record) {
    record = {
      rings,
      chart: greatEllipseChart(rings, path, ctx),
      projected: new WeakMap(),
    };
    for (const r of rings) {
      const entries = ctx.ellipseCharts.get(r) ?? [];
      entries.push(record);
      ctx.ellipseCharts.set(r, entries);
    }
  }
  const { chart } = record;
  const projected = polys.map((p) =>
    p.map((r) => {
      const cached = record.projected.get(r);
      if (cached) return cached;
      const projected = preserveRingPath(
        r,
        r.map((p) => chart.project(p)),
        ctx,
      );
      record.projected.set(r, projected);
      return projected;
    }),
  );
  return { chart, projected };
}
/** Broad phase uses filled cap extents. Only nearby parts require a shared chart. */
function nearbyRings(rings, ctx, path) {
  ctx.ellipsePairs ??= new WeakMap();
  const records = ctx.ellipsePairs.get(rings[0]) ?? [];
  const cached = records.find(
    (v) => v.rings.length === rings.length && rings.every((r) => v.rings.includes(r)),
  );
  if (cached) return cached.pairs;
  const caps = rings.map((r) => ({ r, ...projectRings([[r]], ctx, path).chart.cap }));
  const axes = [0, 1, 2].sort((a, b) => {
    const width = (axis) =>
      caps.reduce((n, v) => Math.max(n, v.ranges[axis][1]), -Infinity) -
      caps.reduce((n, v) => Math.min(n, v.ranges[axis][0]), Infinity);
    return width(b) - width(a);
  });
  const [x, y, z] = axes;
  const items = caps.map((cap) => ({
    ...cap,
    box: {
      xmin: cap.ranges[x][0],
      xmax: cap.ranges[x][1],
      ymin: cap.ranges[y][0],
      ymax: cap.ranges[y][1],
    },
  }));
  const pairs = [];
  for (const [a, b] of candidatePairs(items, ctx, ringInfo(rings[0], ctx).path)) {
    if (a.ranges[z][0] > b.ranges[z][1] || b.ranges[z][0] > a.ranges[z][1]) continue;
    const cosine = a.centre.reduce((n, v, i) => n + v * b.centre[i], 0);
    const [ax, ay, az] = a.centre,
      [bx, by, bz] = b.centre;
    const separation = Math.atan2(
      Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx),
      cosine,
    );
    if (separation > a.radius + b.radius + 64 * Number.EPSILON) continue;
    pairs.push([a.r, b.r]);
  }
  const record = { rings, pairs };
  for (const r of rings) {
    const entries = ctx.ellipsePairs.get(r) ?? [];
    entries.push(record);
    ctx.ellipsePairs.set(r, entries);
  }
  return pairs;
}
/** Distant polygons are independent; only genuinely overlapping groups are unioned. */
function normalizePolygons(polys, type, ctx, path) {
  if (ctx.spatialType !== 'geography' || polys.length < 2)
    return normalizeInChart(polys, type, ctx, path);
  polys.forEach((p, i) => p.forEach((r, j) => ringInfo(r, ctx, `${path}[${i}][${j}]`)));
  if (
    ctx.orientation === 'preserve' &&
    polys.some((p) => {
      const { projected } = projectRings([p], ctx, path);
      return planarArea(projected[0][0]) < 0;
    })
  )
    fail(
      'GEOGRAPHY_UNCERTAIN',
      'preserved complementary multipart interiors require explicit SQL Server validation',
      path,
    );
  const normalized = polys.flatMap((p) => {
    const result = normalizeInChart([p], 'Polygon', ctx, path);
    return result.type === 'Polygon' ? [result.coordinates] : result.coordinates;
  });
  const shells = normalized.map((p) => p[0]);
  const indices = new Map(shells.map((r, i) => [r, i]));
  const parents = normalized.map((_, i) => i);
  const root = (i) => {
    while (parents[i] !== i) i = parents[i];
    return i;
  };
  for (const [a, b] of nearbyRings(shells, ctx, path)) {
    const i = indices.get(a),
      j = indices.get(b);
    const { projected } = projectRings([normalized[i], normalized[j]], ctx, path);
    if (!partsOverlap(projected[0], projected[1], ctx)) continue;
    if (ctx.repair !== 'topology')
      fail(
        'TOPOLOGY',
        'invalid polygon topology (OVERLAPPING_POLYGONS); use explicit topology repair',
        path,
      );
    parents[root(j)] = root(i);
  }
  const groups = new Map();
  normalized.forEach((p, i) => {
    const key = root(i);
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  });
  const coordinates = [...groups.values()].flatMap((group) => {
    if (group.length === 1) return group;
    return normalizeInChart(group, 'MultiPolygon', ctx, path).coordinates;
  });
  return { type: 'MultiPolygon', coordinates };
}
/** Esri's ungrouped rings use pairwise containment, not a feature-wide horizon. */
function classifyGeographyRings(rings, ctx, path) {
  const local = rings.map((r) => projectRings([[r]], ctx, path).projected[0][0]);
  if (ctx.repair === 'topology' && local.some((r) => selfIssue(r, ctx))) {
    const fixed = rings.flatMap((r, i) => {
      if (!selfIssue(local[i], ctx)) return [r];
      const result = normalizeInChart([[r]], 'Polygon', ctx, `${path}[${i}]`);
      const polygons =
        result.type === 'Polygon' ? [result.coordinates] : result.coordinates;
      note(ctx, 'ESRI_RING_REPAIRED', `${path}[${i}]`, {
        rule: 'great-ellipse chart ring interior',
        beforeRings: 1,
        afterRings: polygons.reduce((n, p) => n + p.length, 0),
      });
      return polygons.flat();
    });
    return classifyRings(fixed, ctx, path);
  }
  if (
    ctx.repair === 'topology' &&
    local.every((r) => planarArea(r) < 0 && !selfIssue(r, ctx))
  )
    return rings.map((r) => [r]);
  local.forEach((r) => {
    if (selfIssue(r, ctx))
      fail(
        'ESRI_RING',
        'self-intersecting Esri rings have ambiguous shell/hole roles',
        ringInfo(r, ctx).path,
      );
  });
  const containers = new Map(rings.map((r) => [r, new Set()]));
  for (const [a, b] of nearbyRings(rings, ctx, path)) {
    const {
      projected: [[left, right]],
    } = projectRings([[a, b]], ctx, path);
    if (ringIntersection(left, right, ctx))
      fail(
        'ESRI_RING',
        'crossing or overlapping Esri rings have ambiguous roles',
        path,
      );
    if (ringLocation(left, right, ctx).inside) containers.get(a).add(b);
    if (ringLocation(right, left, ctx).inside) containers.get(b).add(a);
  }
  // Projected areas from different charts are not comparable. The nearest parent
  // has the most enclosing ancestors in this non-crossing containment hierarchy.
  const parents = new Map(
    rings.map((r) => [
      r,
      [...containers.get(r)].sort(
        (a, b) => containers.get(b).size - containers.get(a).size,
      )[0],
    ]),
  );
  const result = [],
    shells = new Map();
  for (const r of rings)
    if (containers.get(r).size % 2 === 0) {
      shells.set(r, result.length);
      result.push([r]);
    }
  for (const r of rings)
    if (containers.get(r).size % 2 === 1) {
      const parent = shells.get(parents.get(r));
      if (parent === undefined)
        fail('ESRI_RING', 'ambiguous ring containment', ringInfo(r, ctx).path);
      result[parent].push(r);
    }
  return result;
}
/** Classify Esri rings by containment depth; reject ambiguous crossing ring roles. */
function classifyRings(rings, ctx, path) {
  if (!rings.length) return [];
  rings.forEach((r, i) => ringInfo(r, ctx, `${path}[${i}]`));
  if (ctx.spatialType === 'geography') return classifyGeographyRings(rings, ctx, path);
  const { chart, projected } = projectRings([rings], ctx, path);
  const planarRings = projected[0];
  // With explicit repair, consistently clockwise Esri rings declare shells.
  // Their overlap can be unioned without guessing mixed shell/hole roles.
  if (
    ctx.repair === 'topology' &&
    planarRings.every((r) => ringInfo(r, ctx).area < 0 && !selfIssue(r, ctx))
  )
    return rings.map((r) => [r]);
  // Explicit repair first simplifies each ring independently. Other rings are still
  // checked for crossings, so repair never guesses between overlapping shell/hole roles.
  if (ctx.repair === 'topology' && planarRings.some((r) => selfIssue(r, ctx))) {
    if (ctx.orientation === 'preserve')
      fail(
        'GLOBAL_REPAIR',
        'topology repair cannot infer a deliberately preserved global interior',
        path,
      );
    if (rings.some((r) => r.some((v) => v.length !== 2)))
      fail(
        'REPAIR_DIMENSION',
        'topology repair would discard altitude or measures',
        path,
      );
    const fixed = [];
    for (let i = 0; i < planarRings.length; i++) {
      const ring = planarRings[i];
      if (!selfIssue(ring, ctx)) {
        fixed.push(rings[i]);
        continue;
      }
      let polygons;
      try {
        polygons = clipping.union([[ring]]);
      } catch (cause) {
        fail('TOPOLOGY', 'Esri ring topology repair failed', `${path}[${i}]`, {
          cause,
        });
      }
      if (!polygons.length)
        fail('COLLAPSED', 'Esri ring repair collapsed its area', `${path}[${i}]`);
      polygons.forEach((p, j) =>
        p.forEach((r, k) => ringInfo(r, ctx, `${path}[${i}].repaired[${j}][${k}]`)),
      );
      if (issues(polygons, ctx, `${path}[${i}]`).length)
        fail(
          'TOPOLOGY',
          'Esri ring repair did not produce simple rings',
          `${path}[${i}]`,
        );
      for (const poly of polygons)
        for (const r of poly) fixed.push(repairedRing(r, chart, ctx));
      note(ctx, 'ESRI_RING_REPAIRED', `${path}[${i}]`, {
        rule: 'nonzero ring interior',
        beforeRings: 1,
        afterRings: polygons.reduce((n, p) => n + p.length, 0),
      });
    }
    return classifyRings(fixed, ctx, path);
  }
  planarRings.forEach((r, i) => {
    if (selfIssue(r, ctx))
      fail(
        'ESRI_RING',
        'self-intersecting Esri rings have ambiguous shell/hole roles',
        `${path}[${i}]`,
      );
    for (let j = 0; j < i; j++)
      if (ringIntersection(r, planarRings[j], ctx))
        fail(
          'ESRI_RING',
          'crossing or overlapping Esri rings have ambiguous roles',
          path,
        );
  });
  const parents = planarRings.map((r, i) => {
    const containers = planarRings
      .map((p, j) => ({
        j,
        area: Math.abs(ringInfo(p, ctx).area),
        inside: j !== i && ringLocation(r, p, ctx).inside,
      }))
      .filter((p) => p.inside)
      .sort((a, b) => a.area - b.area);
    return containers[0]?.j ?? -1;
  });
  const depth = (i) => {
    let n = 0,
      seen = new Set();
    while (parents[i] !== -1) {
      if (seen.has(i)) fail('ESRI_RING', 'ambiguous ring containment', path);
      seen.add(i);
      n++;
      i = parents[i];
    }
    return n;
  };
  const result = [],
    shells = new Map();
  rings.forEach((r, i) => {
    if (depth(i) % 2 === 0) {
      shells.set(i, result.length);
      result.push([r]);
    }
  });
  rings.forEach((r, i) => {
    if (depth(i) % 2 === 1) result[shells.get(parents[i])].push(r);
  });
  return result;
}
export { planarArea, normalizePolygons, classifyRings, contains };
