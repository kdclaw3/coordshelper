/**
 * @fileoverview Coordinate validation, projection and conservative structural repairs.
 * A per-conversion context collects diagnostics and enforces processing limits.
 */
import proj4 from 'proj4';

/** Conversion failure with a stable error code and the offending input path. */
class SpatialError extends Error {
  constructor(code, message, path = '$') {
    super(`${path}: ${message}`);
    this.name = 'SpatialError';
    this.code = code;
    this.path = path;
    this.detail = message;
  }
}
const fail = (code, message, path) => {
  throw new SpatialError(code, message, path);
};
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
  if (
    !Number.isInteger(maxPositions) ||
    maxPositions < 1 ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 1 ||
    !Number.isInteger(maxTopologyChecks) ||
    maxTopologyChecks < 1
  )
    fail('LIMIT', 'invalid processing limit');
  if (options.orientation && !['normalize', 'preserve'].includes(options.orientation))
    fail('WINDING', 'orientation must be normalize or preserve');
  const project = options.project ?? true;
  if (typeof project !== 'boolean') fail('CRS', 'project must be boolean');
  if (options.converter && typeof options.converter !== 'function')
    fail('CRS', 'converter must be a coordinate conversion function');
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
  let converter;
  const identity =
    ['EPSG:4326', 'WGS84'].includes(options.sourceCrs) &&
    (!options.targetCrs || ['EPSG:4326', 'WGS84'].includes(options.targetCrs));
  if (project && (options.converter || (options.sourceCrs && !identity))) {
    if (options.converter) converter = options.converter;
    else {
      const definitions = options.projectionDefinitions ?? {};
      try {
        // Resolve definitions locally; do not change proj4's global registry.
        converter = proj4(
          definitions[options.sourceCrs] ?? options.sourceCrs,
          definitions[options.targetCrs] ?? options.targetCrs ?? 'EPSG:4326',
        ).forward;
      } catch {
        fail('CRS', 'unknown projection; supply projectionDefinitions or converter');
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
    project,
    transform: converter,
    selfChecks: new Map(),
    topologyChecks: 0,
    count: 0,
    diagnostics: [],
  };
}
function note(ctx, code, path, detail) {
  ctx.diagnostics.push({ code, path, detail });
}
function array(value, path) {
  if (!Array.isArray(value)) fail('SHAPE', 'expected an array', path);
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
      if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(Number.isFinite))
        throw Error('nonfinite');
      result = [...xy, ...result.slice(2)];
    } catch {
      fail('CRS', 'coordinate transformation failed', path);
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
};
