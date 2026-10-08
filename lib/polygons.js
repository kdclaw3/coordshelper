/**
 * @fileoverview Polygon ring roles, winding and explicit local topology repairs.
 * Geography winding uses ellipsoidal area; planar clipping is refused for global topology.
 */
import * as clipping from 'polyclip-ts';
import geographicLib from 'geographiclib-geodesic';
import { fail, note, equalXY } from './common.js';
import {
  budget,
  bounds,
  intersects,
  candidatePairs,
  segments,
  intervalIndex,
} from './topology.js';

const { Geodesic, PolygonArea } = geographicLib;

function unwrap(ring, reference = ring[0]?.[0] ?? 0, ctx) {
  const cached = ctx?.unwrapped.get(ring);
  if (cached?.has(reference)) return cached.get(reference);
  let last = reference;
  const result = ring.map((p) => {
    let x = p[0];
    while (x - last > 180) x -= 360;
    while (x - last < -180) x += 360;
    last = x;
    return [x, ...p.slice(1)];
  });
  const unchanged = result.every((p, i) => p[0] === ring[i][0]);
  const value = unchanged ? ring : result;
  if (ctx) {
    const references = cached ?? new Map();
    references.set(reference, value);
    ctx.unwrapped.set(ring, references);
    if (ctx.ringChecks.has(ring) && value !== ring)
      ringInfo(value, ctx, ctx.ringChecks.get(ring).path);
  }
  return value;
}
function planarArea(ring) {
  // Translate to the first vertex to reduce cancellation at large coordinates.
  const [x, y] = ring[0];
  let area = 0;
  for (let i = 1; i < ring.length; i++)
    area +=
      (ring[i - 1][0] - x) * (ring[i][1] - y) - (ring[i][0] - x) * (ring[i - 1][1] - y);
  return area / 2;
}
/** Use the target's area model so dateline/polar winding is not decided on a flat map. */
function signedArea(ring, ctx) {
  if (ctx.spatialType === 'geometry') return planarArea(ring);
  const p = new PolygonArea.PolygonArea(Geodesic.WGS84, false);
  ring.slice(0, -1).forEach(([lon, lat]) => p.AddPoint(lat, lon));
  return p.Compute(false, true).area;
}
function orient(ring, hole, ctx, path) {
  const area = signedArea(ring, ctx);
  if (!Number.isFinite(area) || area === 0)
    fail('COLLAPSED', 'polygon has zero signed area', path);
  // preserve allows callers to deliberately select a geography interior larger than a hemisphere.
  if (ctx.orientation === 'preserve') return ring;
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
  return [...ring].reverse();
}
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(p, a, b) {
  return (
    cross(a, b, p) === 0 &&
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}
function intersection(a, b, c, d) {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return 'cross';
  if (abC === 0 && abD === 0) {
    const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
    const overlap =
      Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
      Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
    if (overlap > 0) return 'overlap';
  }
  return onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b)
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
  if (Object.hasOwn(info, 'self')) return info.self;
  let found = null;
  for (const [a, b] of candidatePairs(info.segments, ctx, info.path)) {
    const distance = Math.abs(a.ordinal - b.ordinal);
    if (distance === 1 || distance === r.length - 2) continue;
    if (intersection(a.a, a.b, b.a, b.b)) {
      found = 'SELF_INTERSECTION';
      break;
    }
  }
  info.self = found;
  return found;
}
function ringRelation(a, b, ctx, path) {
  const leftInfo = ringInfo(a, ctx, path),
    rightInfo = ringInfo(b, ctx, path);
  if (leftInfo.pairs.has(b)) return leftInfo.pairs.get(b);
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
      const kind = intersection(left.a, left.b, right.a, right.b);
      if (kind === 'cross' || kind === 'overlap') {
        relation.cross = true;
        break;
      }
      if (kind === 'touch') relation.touch = true;
    }
  }
  leftInfo.pairs.set(b, relation);
  rightInfo.pairs.set(a, relation);
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
    if (onSegment(p, a, b)) return 0;
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
  if (info.locations.has(b)) return info.locations.get(b);
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
  info.locations.set(b, result);
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
      if (
        polys[i].some((a) => polys[j].some((b) => ringIntersection(a, b, ctx))) ||
        ringInsidePolygon(polys[i][0], polys[j], ctx) ||
        ringInsidePolygon(polys[j][0], polys[i], ctx)
      )
        errors.add('OVERLAPPING_POLYGONS');
    }
  return [...errors];
}
/** Repair only under the selected policy, then orient shells and holes independently. */
function normalizePolygons(polys, type, ctx, path) {
  if (!polys.length) return { type, coordinates: [] };
  polys.forEach((p, i) =>
    p.forEach((r, j) =>
      ringInfo(r, ctx, type === 'Polygon' ? `${path}[${j}]` : `${path}[${i}][${j}]`),
    ),
  );
  const projected = polys.map((p) =>
    p.map((r) =>
      ctx.spatialType === 'geography' ? unwrap(r, polys[0][0][0][0], ctx) : r,
    ),
  );
  const global =
    ctx.spatialType === 'geography' &&
    projected.some((p) => p.some((r) => !equalXY(r[0], r.at(-1))));
  if (global && ctx.repair === 'topology')
    fail(
      'GLOBAL_REPAIR',
      'planar topology repair cannot safely repair a polar/global polygon',
      path,
    );
  const found = global ? [] : issues(projected, ctx, path);
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
    normalized = fixed.map((p) =>
      p.map((r) =>
        preserveRingPath(
          r,
          r.map(([x, y]) => [
            ctx.spatialType === 'geography'
              ? ((((x + 180) % 360) + 360) % 360) - 180
              : x,
            y,
          ]),
          ctx,
        ),
      ),
    );
    note(ctx, 'TOPOLOGY_REPAIRED', path, {
      issues: found,
      rule: 'nonzero shell union minus holes',
      beforeParts: polys.length,
      afterParts: fixed.length,
    });
    if (fixed.length > 1) type = 'MultiPolygon';
  }
  if (global)
    note(
      ctx,
      'SQL_VALIDATION_REQUIRED',
      path,
      'Global polygon topology must be checked with the target geography engine',
    );
  if (normalized.length > 1 && type === 'Polygon') type = 'MultiPolygon';
  normalized = normalized.map((p) =>
    p.map((r, j) => orient(r, j > 0, ctx, ringInfo(r, ctx).path)),
  );
  return { type, coordinates: type === 'Polygon' ? normalized[0] : normalized };
}
/** Keep the source/repaired ring provenance when longitude normalization makes a copy. */
function preserveRingPath(source, copy, ctx) {
  ringInfo(copy, ctx, ringInfo(source, ctx).path);
  return copy;
}
/** Classify Esri rings by containment depth; reject ambiguous crossing ring roles. */
function classifyRings(rings, ctx, path) {
  if (!rings.length) return [];
  rings.forEach((r, i) => ringInfo(r, ctx, `${path}[${i}]`));
  const unwrapped = rings.map((r) =>
    ctx.spatialType === 'geography' ? unwrap(r, rings[0][0][0], ctx) : r,
  );
  if (unwrapped.some((r) => !equalXY(r[0], r.at(-1))))
    fail(
      'ESRI_GLOBAL',
      'polar Esri ring roles require explicit GeoJSON shell/hole classification',
      path,
    );
  // With explicit repair, consistently clockwise Esri rings declare shells.
  // Their overlap can be unioned without guessing mixed shell/hole roles.
  if (
    ctx.repair === 'topology' &&
    unwrapped.every((r) => ringInfo(r, ctx).area < 0 && !selfIssue(r, ctx))
  )
    return rings.map((r) => [r]);
  // Explicit repair first simplifies each ring independently. Other rings are still
  // checked for crossings, so repair never guesses between overlapping shell/hole roles.
  if (ctx.repair === 'topology' && unwrapped.some((r) => selfIssue(r, ctx))) {
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
    for (let i = 0; i < unwrapped.length; i++) {
      const ring = unwrapped[i];
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
        for (const r of poly)
          fixed.push(
            preserveRingPath(
              r,
              r.map(([x, y]) => [
                ctx.spatialType === 'geography'
                  ? ((((x + 180) % 360) + 360) % 360) - 180
                  : x,
                y,
              ]),
              ctx,
            ),
          );
      note(ctx, 'ESRI_RING_REPAIRED', `${path}[${i}]`, {
        rule: 'nonzero ring interior',
        beforeRings: 1,
        afterRings: polygons.reduce((n, p) => n + p.length, 0),
      });
    }
    return classifyRings(fixed, ctx, path);
  }
  unwrapped.forEach((r, i) => {
    if (selfIssue(r, ctx))
      fail(
        'ESRI_RING',
        'self-intersecting Esri rings have ambiguous shell/hole roles',
        `${path}[${i}]`,
      );
    for (let j = 0; j < i; j++)
      if (ringIntersection(r, unwrapped[j], ctx))
        fail(
          'ESRI_RING',
          'crossing or overlapping Esri rings have ambiguous roles',
          path,
        );
  });
  const parents = unwrapped.map((r, i) => {
    const containers = unwrapped
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
export { unwrap, planarArea, signedArea, normalizePolygons, classifyRings, contains };
