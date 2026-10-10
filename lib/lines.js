/** @fileoverview Bounded line overlap checks and explicit traversal or footprint repairs. */
import { fail, note, equal, sequence, component } from './common.js';
import { bounds, candidatePairs, budget } from './topology.js';
import { greatEllipseSegments, greatEllipseOverlap } from './great-ellipse.js';

function lineSegments(parts, ctx, path, edgePath) {
  if (ctx.spatialType === 'geography')
    return greatEllipseSegments(parts, path, edgePath);
  return parts.flatMap((points, group) =>
    points.slice(1).map((b, ordinal) => {
      const a = points[ordinal];
      const box = bounds([a, b]);
      return {
        a,
        b,
        group,
        ordinal,
        path: edgePath(group, ordinal),
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

function overlaps(a, b, ctx) {
  return ctx.spatialType === 'geography'
    ? greatEllipseOverlap(a, b)
    : planarOverlap(a, b);
}

/** Retain each exact undirected edge once; do not snap, split partial edges or discard branches. */
function deduplicateLines(parts, type, ctx, path) {
  const nodes = new Map(),
    edges = new Map();
  let inputSegments = 0,
    removedTraversals = 0;
  function node(point) {
    const key = JSON.stringify(point.slice(0, 2));
    if (!nodes.has(key))
      nodes.set(key, { id: nodes.size, point, edges: [], conflict: false });
    const found = nodes.get(key);
    if (!equal(found.point, point)) found.conflict = true;
    return found;
  }
  parts.forEach((points, group) => {
    for (let i = 1; i < points.length; i++) {
      const sourcePath =
        type === 'LineString' ? `${path}[${i - 1}]` : `${path}[${group}][${i - 1}]`;
      budget(ctx, sourcePath);
      inputSegments++;
      const a = node(points[i - 1]),
        b = node(points[i]);
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (edges.has(key)) {
        removedTraversals++;
        continue;
      }
      const edge = { a, b, path: sourcePath, visited: false };
      edges.set(key, edge);
      a.edges.push(edge);
      b.edges.push(edge);
    }
  });
  if (removedTraversals && [...nodes.values()].some((n) => n.conflict))
    fail(
      'REPAIR_DIMENSION',
      'line deduplication cannot merge conflicting altitude or measure values',
      path,
    );
  // Validate only distinct edges. Thousands of copies must not create quadratic comparison work.
  const uniqueEdges = [...edges.values()];
  const uniqueParts = uniqueEdges.map((edge) => [edge.a.point, edge.b.point]);
  const sourcePath = (group) => uniqueEdges[group].path;
  for (const [a, b] of candidatePairs(
    lineSegments(uniqueParts, ctx, path, sourcePath),
    ctx,
    path,
  ))
    if (overlaps(a, b, ctx))
      fail(
        'LINE_OVERLAP',
        'line deduplication supports exact repeated edges only; partial overlaps require explicit source correction',
        path,
      );
  if (!removedTraversals)
    return { type, coordinates: type === 'LineString' ? parts[0] : parts };

  const paths = [];
  function walk(start, edge) {
    const points = [start.point];
    let current = start;
    while (edge && !edge.visited) {
      edge.visited = true;
      current = edge.a === current ? edge.b : edge.a;
      points.push(current.point);
      // Junctions end a path; continuing through one could hide a distinct branch.
      if (current.edges.length !== 2) break;
      edge = current.edges.find((value) => !value.visited);
    }
    paths.push(points);
  }
  for (const current of nodes.values()) {
    if (current.edges.length === 2) continue;
    for (const edge of current.edges) if (!edge.visited) walk(current, edge);
  }
  // Components with degree two everywhere are closed loops, not removable spurs.
  for (const edge of edges.values()) if (!edge.visited) walk(edge.a, edge);
  for (const points of parts) if (!points.length) paths.push([]);
  const afterType = paths.length === 1 ? 'LineString' : 'MultiLineString';
  if (afterType === 'MultiLineString')
    component(
      ctx,
      path,
      Math.max(0, paths.length - (type === 'MultiLineString' ? parts.length : 0)),
    );
  // Charge generated positions and validate output without applying the source projection twice.
  const coordinates = paths.map((points, i) =>
    sequence(points, ctx, afterType === 'LineString' ? path : `${path}[${i}]`, {
      extended: true,
      projected: true,
    }),
  );
  note(ctx, 'LINE_OVERLAP_DEDUPLICATED', path, {
    rule: 'retain each exact undirected segment once and reconnect continuous paths',
    beforeType: type,
    afterType,
    inputSegments,
    uniqueSegments: edges.size,
    removedTraversals,
    components: paths.length,
  });
  return {
    type: afterType,
    coordinates: afterType === 'LineString' ? coordinates[0] : coordinates,
  };
}

/** Split affected original segments; retain complete unaffected runs and every Z/M vertex. */
export function normalizeLines(parts, type, ctx, path) {
  if (ctx.lineOverlap === 'deduplicate')
    return deduplicateLines(parts, type, ctx, path);
  const affected = new Set();
  const sourcePath = (group, ordinal) =>
    type === 'LineString' ? `${path}[${ordinal}]` : `${path}[${group}][${ordinal}]`;
  for (const [a, b] of candidatePairs(
    lineSegments(parts, ctx, path, sourcePath),
    ctx,
    path,
  )) {
    if (!overlaps(a, b, ctx)) continue;
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
