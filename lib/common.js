/**
 * @fileoverview Coordinate validation, projection and conservative structural repairs.
 * A per-conversion context collects diagnostics and enforces processing limits.
 */
import proj4 from 'proj4';
import { parseProjection, sameProjection, usesNad83ZeroShift } from './projections.js';
import { SpatialError, fail } from './errors.js';

// Internal symbol carries one collection budget through otherwise isolated feature contexts.
const collectionBudget = Symbol('collection budget');
function limit(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) fail('LIMIT', `invalid ${name}`);
  return result;
}
function component(ctx, path, count = 1) {
  ctx.components += count;
  if (ctx.components > ctx.maxComponents)
    fail('LIMIT', 'geometry component limit exceeded', path);
}
function chargeCollection(totals, key, count) {
  if (!totals) return;
  totals[key] += count;
  if (totals[key] > totals.limits[key]) {
    const error = new SpatialError(
      'LIMIT',
      `collection ${key} limit exceeded`,
      `$.features[${totals.index}]`,
    );
    error.scope = 'collection';
    error.processedFeatures = totals.index;
    throw error;
  }
}
const equalXY = (a, b) => a[0] === b[0] && a[1] === b[1];
const equal = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
/** Create isolated settings and counters; an SRID label never implies reprojection. */
function context(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    fail('OPTIONS', 'expected conversion options');
  const spatialType = options.spatialType ?? 'geography';
  if (!['geography', 'geometry'].includes(spatialType))
    fail('TARGET', 'unsupported SQL spatial type');
  const srid = options.srid ?? (spatialType === 'geography' ? 4326 : 0);
  if (!Number.isInteger(srid) || srid < 0 || srid > 2147483647)
    fail('SRID', 'SRID must be a nonnegative SQL int');
  // Ellipsoidal orientation calculations use WGS84. Other ellipsoids require their own contract.
  if (spatialType === 'geography' && srid !== 4326)
    fail('SRID', 'geography currently requires WGS84 SRID 4326');
  const repair = options.repair ?? 'safe';
  if (!['none', 'safe', 'topology'].includes(repair))
    fail('REPAIR', 'repair must be none, safe or topology');
  const maxPositions = options.maxPositions ?? 100000;
  const maxDepth = options.maxDepth ?? 32;
  const maxTopologyChecks = options.maxTopologyChecks ?? 1000000;
  const maxComponents = limit(options.maxComponents, 10000, 'maxComponents');
  if (
    !Number.isSafeInteger(maxPositions) ||
    maxPositions < 1 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    !Number.isSafeInteger(maxTopologyChecks) ||
    maxTopologyChecks < 1
  )
    fail('LIMIT', 'invalid processing limit');
  if (options.orientation && !['normalize', 'preserve'].includes(options.orientation))
    fail('WINDING', 'orientation must be normalize or preserve');
  const project = options.project ?? true;
  if (typeof project !== 'boolean') fail('CRS', 'project must be boolean');
  if (options.converter && typeof options.converter !== 'function')
    fail('CRS', 'converter must be a coordinate conversion function');
  if (
    options.allowNad83ZeroShift !== undefined &&
    typeof options.allowNad83ZeroShift !== 'boolean'
  )
    fail('OPTIONS', 'allowNad83ZeroShift must be boolean');
  for (const key of ['hasZ', 'hasM'])
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      fail('DIMENSION', `${key} must be boolean`);
  if (
    options.projectionDefinitions &&
    (typeof options.projectionDefinitions !== 'object' ||
      Array.isArray(options.projectionDefinitions))
  )
    fail('CRS', 'projectionDefinitions must be a definition map');
  if (
    options.wkidAuthorities !== undefined &&
    (!options.wkidAuthorities ||
      typeof options.wkidAuthorities !== 'object' ||
      Array.isArray(options.wkidAuthorities) ||
      Object.entries(options.wkidAuthorities).some(
        ([key, value]) => !/^\d+$/.test(key) || !['EPSG', 'ESRI'].includes(value),
      ))
  )
    fail('CRS', 'wkidAuthorities must map numeric WKIDs to EPSG or ESRI');
  // Reserved WGS84 aliases also name the fixed geography destination. A local
  // definition must not silently relabel projected coordinates as longitude/latitude.
  for (const alias of ['EPSG:4326', 'WGS84'])
    if (
      options.projectionDefinitions &&
      Object.hasOwn(options.projectionDefinitions, alias) &&
      !sameProjection(
        alias,
        '+proj=longlat +ellps=WGS84 +datum=WGS84 +units=degrees',
        options,
      )
    )
      fail('CRS', 'WGS84 aliases cannot be overridden by a different CRS');
  if (
    spatialType === 'geometry' &&
    project &&
    options.sourceCrs &&
    !options.targetCrs &&
    !options.converter
  )
    fail('CRS', 'geometry projection requires an explicit targetCrs');
  if (
    spatialType === 'geography' &&
    options.targetCrs &&
    !['EPSG:4326', 'WGS84'].includes(options.targetCrs)
  )
    fail('CRS', 'geography targetCrs must be WGS84');
  if (
    !project &&
    spatialType === 'geography' &&
    options.sourceCrs &&
    !['EPSG:4326', 'WGS84'].includes(options.sourceCrs)
  )
    fail('CRS', 'native non-WGS84 coordinates require planar geometry or projection');
  let converter,
    nad83ZeroShift = false;
  const identity =
    ['EPSG:4326', 'WGS84'].includes(options.sourceCrs) &&
    (!options.targetCrs || ['EPSG:4326', 'WGS84'].includes(options.targetCrs));
  if (project && (options.converter || (options.sourceCrs && !identity))) {
    if (options.converter) converter = options.converter;
    else {
      try {
        // Pass parsed projections directly, avoiding both authority and definition registry lookups.
        const source = parseProjection(options.sourceCrs, options),
          target = parseProjection(options.targetCrs ?? 'EPSG:4326', options);
        nad83ZeroShift = usesNad83ZeroShift(source, target);
        if (nad83ZeroShift && !options.allowNad83ZeroShift)
          fail(
            'CRS',
            'NAD83 zero-shift approximation requires allowNad83ZeroShift: true or a verified converter',
          );
        const projection = proj4(source, target);
        converter = (xy) => {
          const input =
            source.projName === 'longlat'
              ? xy.map((v) => v * source.angularToDegrees)
              : xy;
          const output = projection.forward(input);
          return target.projName === 'longlat'
            ? output.map((v) => v / target.angularToDegrees)
            : output;
        };
      } catch (cause) {
        if (cause instanceof SpatialError) throw cause;
        fail(
          'CRS',
          'unknown or unsupported projection; supply projectionDefinitions or converter',
          '$',
          { cause },
        );
      }
    }
  }
  return {
    ...options,
    spatialType,
    srid,
    repair,
    maxPositions,
    maxDepth,
    maxTopologyChecks,
    maxComponents,
    components: 0,
    project,
    transform: converter,
    ringChecks: new WeakMap(),
    curveChecks: new WeakMap(),
    unwrapped: new WeakMap(),
    topologyChecks: 0,
    count: 0,
    diagnostics: nad83ZeroShift
      ? [
          {
            code: 'NAD83_ZERO_SHIFT',
            path: '$',
            detail:
              'Caller accepted the approximate zero NAD83/WGS84 datum shift; no realization- or epoch-specific transformation was applied',
          },
        ]
      : [],
  };
}
function note(ctx, code, path, detail) {
  ctx.diagnostics.push({ code, path, detail });
}
function array(value, path) {
  if (!Array.isArray(value)) fail('SHAPE', 'expected an array', path);
  for (let i = 0; i < value.length; i++)
    if (!Object.hasOwn(value, i))
      fail('SHAPE', 'sparse array entries are not supported', `${path}[${i}]`);
  return value;
}
function position(value, ctx, path, extended = false) {
  array(value, path);
  if (value.length < 2 || value.length > (extended ? 4 : 3))
    fail(
      'DIMENSION',
      'expected longitude/latitude with optional altitude; measures require spatial/Esri input',
      path,
    );
  if (++ctx.count > ctx.maxPositions) fail('LIMIT', 'position limit exceeded', path);
  chargeCollection(ctx[collectionBudget], 'positions', 1);
  value.forEach((v, i) => {
    if (
      !(extended && (i === 2 || i === 3) && v === null && value.length === 4) &&
      (typeof v !== 'number' || !Number.isFinite(v))
    )
      fail('COORDINATE', 'coordinates must be finite numbers', `${path}[${i}]`);
  });
  let result = value.map((v) => (Object.is(v, -0) ? 0 : v));
  if (ctx.transform) {
    try {
      const xy = ctx.transform(result.slice(0, 2));
      if (
        !Array.isArray(xy) ||
        xy.length !== 2 ||
        !Number.isFinite(xy[0]) ||
        !Number.isFinite(xy[1])
      )
        throw Error('nonfinite');
      result = [...xy, ...result.slice(2)];
    } catch (cause) {
      throw new SpatialError('CRS', 'coordinate transformation failed', path, {
        cause,
      });
    }
  }
  if (ctx.spatialType === 'geography') {
    if (result[0] < -180 || result[0] > 180)
      fail('LONGITUDE', 'longitude must be between -180 and 180', path);
    if (result[1] < -90 || result[1] > 90)
      fail('LATITUDE', 'latitude must be between -90 and 90', path);
  }
  if (ctx.spatialType === 'geography' && result[0] === 180) {
    result[0] = -180;
    note(
      ctx,
      'CANONICAL_LONGITUDE',
      path,
      'Normalized equivalent antimeridian longitude to -180',
    );
  }
  return result;
}
function edge(a, b, ctx, path) {
  if (ctx.spatialType !== 'geography') return;
  const lon = Math.abs(((((b[0] - a[0]) % 360) + 540) % 360) - 180);
  if (
    Math.abs(a[1] + b[1]) < 1e-12 &&
    (Math.abs(lon - 180) < 1e-12 || (Math.abs(a[1]) === 90 && Math.abs(b[1]) === 90))
  )
    fail('ANTIPODAL', 'antipodal edge has no unique geography path', path);
}
/** Validate a line/ring and repair closure or exact duplicates without losing Z/M. */
function sequence(
  values,
  ctx,
  path,
  { ring = false, extended = false, curve = false } = {},
) {
  let points = array(values, path).map((v, i) =>
    position(v, ctx, `${path}[${i}]`, extended),
  );
  if (!points.length) return points;
  if (points.some((p) => p.length !== points[0].length))
    fail('DIMENSION', 'inconsistent dimensions within a component', path);
  if (!curve) {
    const cleaned = points.filter((p, i) => i === 0 || !equalXY(p, points[i - 1]));
    if (cleaned.length !== points.length) {
      if (ctx.repair === 'none')
        fail('DUPLICATE', 'consecutive duplicate vertices', path);
      // Removing XY duplicates with different altitude/measure would discard information.
      if (
        points.some(
          (p, i) => i > 0 && equalXY(p, points[i - 1]) && !equal(p, points[i - 1]),
        )
      )
        fail(
          'DIMENSION',
          'duplicate XY vertices have different altitude or measure',
          path,
        );
      note(ctx, 'DEDUPLICATED', path, 'Removed consecutive identical vertices');
      points = cleaned;
    }
  }
  if (ring && !equal(points[0], points.at(-1))) {
    if (equalXY(points[0], points.at(-1)))
      fail('CLOSURE', 'ring closure has different altitude or measure', path);
    if (ctx.repair === 'none') fail('UNCLOSED', 'polygon ring is not closed', path);
    points.push([...points[0]]);
    note(ctx, 'CLOSED_RING', path, 'Appended the starting position');
  }
  if (points.length < (ring ? 4 : 2))
    fail('COLLAPSED', 'component has too few distinct positions', path);
  if (ring && new Set(points.slice(0, -1).map((p) => `${p[0]},${p[1]}`)).size < 3)
    fail('COLLAPSED', 'polygon needs three distinct vertices', path);
  points.slice(1).forEach((p, i) => edge(points[i], p, ctx, `${path}[${i}]`));
  return points;
}
export {
  SpatialError,
  fail,
  equalXY,
  equal,
  context,
  note,
  array,
  position,
  sequence,
  edge,
  component,
  limit,
  collectionBudget,
  chargeCollection,
};
