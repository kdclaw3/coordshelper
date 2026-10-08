/**
 * @fileoverview Pure conversion adapters and SQL Server WKT/parameter generation.
 * The pipeline validates, projects and normalizes before serialization; it performs no I/O.
 */
import {
  context,
  fail,
  note,
  array,
  position,
  sequence,
  equalXY,
  equal,
  SpatialError,
  component,
  limit,
  collectionBudget,
  chargeCollection,
} from './common.js';
import { normalizePolygons, classifyRings } from './polygons.js';
import { normalizeLines } from './lines.js';
import { normalizeCurveRings } from './curves.js';
import { knownAuthority, aliasWkid, sameProjection } from './projections.js';

/**
 * @typedef {object} SpatialResult
 * @property {string} type Normalized geometry type; repair can change it.
 * @property {'geography'|'geometry'} spatialType SQL Server target.
 * @property {number} srid Target reference system identifier.
 * @property {string} wkt Parameter-ready SQL Server spatial text.
 * @property {object} geometry Normalized coordinates or explicit spatial representation.
 * @property {Array<object>} diagnostics Corrections and validation limits.
 * @property {object} validation Local checks; sqlServerValidated remains false.
 */

/**
 * @typedef {object} ConversionOptions
 * @property {'geography'|'geometry'} [spatialType='geography'] Target coordinate model.
 * @property {number} [srid] Defaults to 4326 for geography, 0 for geometry.
 * @property {'none'|'safe'|'topology'} [repair='safe'] Topology repair is explicitly selected.
 * @property {'normalize'|'preserve'} [orientation='normalize'] Preserve intentional large interiors.
 * @property {string} [sourceCrs] Explicit source projection; Esri can supply spatialReference.
 * @property {string} [targetCrs] Required when projecting to planar geometry.
 */

// SQL-only curves and FullGlobe use fromSpatial; they are not additional GeoJSON types.
const GEO_TYPES = Object.freeze([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);
const SQL_TYPES = Object.freeze([
  ...GEO_TYPES,
  'CircularString',
  'CompoundCurve',
  'CurvePolygon',
  'FullGlobe',
]);

function geo(g, ctx, path = '$', depth = 0, extended = false) {
  if (depth > ctx.maxDepth) fail('LIMIT', 'geometry nesting limit exceeded', path);
  if (!g || typeof g !== 'object' || Array.isArray(g))
    fail('SHAPE', 'expected a geometry object', path);
  if (g.crs && !ctx.sourceCrs)
    fail('CRS', 'legacy GeoJSON crs requires an explicit sourceCrs', `${path}.crs`);
  const { type } = g;
  if (!GEO_TYPES.includes(type))
    fail('TYPE', `unsupported GeoJSON geometry type ${String(type)}`, path);
  component(ctx, path);
  if (type === 'GeometryCollection')
    return {
      type,
      geometries: array(g.geometries, `${path}.geometries`).map((v, i) =>
        geo(v, ctx, `${path}.geometries[${i}]`, depth + 1, extended),
      ),
    };
  const c = array(g.coordinates, `${path}.coordinates`),
    p = `${path}.coordinates`;
  if (!c.length) return { type, coordinates: [] };
  switch (type) {
    case 'Point':
      return { type, coordinates: position(c, ctx, p, extended) };
    case 'MultiPoint':
      component(ctx, p, c.length);
      return {
        type,
        coordinates: c.map((v, i) => position(v, ctx, `${p}[${i}]`, extended)),
      };
    case 'LineString':
      return normalizeLines([sequence(c, ctx, p, { extended })], type, ctx, p);
    case 'MultiLineString':
      component(ctx, p, c.length);
      return normalizeLines(
        c.map((v, i) => sequence(v, ctx, `${p}[${i}]`, { extended })),
        type,
        ctx,
        p,
      );
    case 'Polygon': {
      component(ctx, p, c.length);
      const rings = c.map((r, i) =>
        sequence(r, ctx, `${p}[${i}]`, { ring: true, extended }),
      );
      if (rings.some((r) => !r.length))
        fail('EMPTY_COMPONENT', 'empty ring inside nonempty polygon', p);
      return normalizePolygons([rings], type, ctx, p);
    }
    case 'MultiPolygon': {
      component(ctx, p, c.length);
      const polys = c.map((poly, i) =>
        array(poly, `${p}[${i}]`).map((r, j) => {
          component(ctx, `${p}[${i}][${j}]`);
          return sequence(r, ctx, `${p}[${i}][${j}]`, { ring: true, extended });
        }),
      );
      if (polys.some((poly) => !poly.length || poly.some((r) => !r.length)))
        fail('EMPTY_COMPONENT', 'empty component inside nonempty multipolygon', p);
      return normalizePolygons(polys, type, ctx, p);
    }
  }
}
function decimal(n) {
  const text = String(n);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponent] = text.toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? '-' : '';
  const [whole, fraction = ''] = mantissa.replace('-', '').split('.');
  const digits = whole + fraction,
    point = whole.length + Number(exponent);
  const expanded =
    sign +
    (point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point));
  // SQL Server's WKT reader rejects overlong fixed-point literals. Scientific
  // notation preserves the original double; truncating decimals would move vertices.
  return expanded.replace(/[-.]/g, '').length > 28 ? text : expanded;
}
const pos = (p) => p.map((n) => (n === null ? 'NULL' : decimal(n))).join(' ');
const line = (p) => `(${p.map(pos).join(',')})`;
const polygon = (p) => `(${p.map(line).join(',')})`;
function wkt(g, bodyOnly = false) {
  const t = g.type.toUpperCase(),
    c = g.coordinates;
  if (g.type === 'FullGlobe') return 'FULLGLOBE';
  if (g.type === 'GeometryCollection')
    return g.geometries.length
      ? `${t} (${g.geometries.map((v) => wkt(v)).join(',')})`
      : `${t} EMPTY`;
  if (g.type === 'CompoundCurve')
    return g.segments.length
      ? `${t} (${g.segments.map((v) => wkt(v, v.type === 'LineString')).join(',')})`
      : `${t} EMPTY`;
  if (g.type === 'CurvePolygon')
    return g.rings.length
      ? `${t} (${g.rings.map((v) => wkt(v, v.type === 'LineString')).join(',')})`
      : `${t} EMPTY`;
  if (!c.length) return `${t} EMPTY`;
  let body;
  switch (g.type) {
    case 'Point':
      body = `(${pos(c)})`;
      break;
    case 'MultiPoint':
    case 'LineString':
    case 'CircularString':
      body = line(c);
      break;
    case 'MultiLineString':
      body = `(${c.map((v) => (v.length ? line(v) : 'EMPTY')).join(',')})`;
      break;
    case 'Polygon':
      body = polygon(c);
      break;
    case 'MultiPolygon':
      body = `(${c.map(polygon).join(',')})`;
      break;
  }
  return bodyOnly ? body : `${t} ${body}`;
}
function result(g, ctx) {
  return {
    type: g.type,
    spatialType: ctx.spatialType,
    srid: ctx.srid,
    wkt: wkt(g),
    geometry: g,
    diagnostics: ctx.diagnostics,
    validation: {
      structural: true,
      sqlServerValidated: false,
      topologyChecks: ctx.topologyChecks,
    },
  };
}
/**
 * Convert GeoJSON without changing the input. Collections retain separate feature identities.
 * Safe repairs fix closure, duplicates and winding; topology repair can change shape/type.
 * @param {object|null} input Geometry, Feature or FeatureCollection.
 * @param {ConversionOptions} [options] Target, projection and repair settings.
 * @returns {SpatialResult|Array<object>|null} Conversion, feature results, or absent geometry.
 * @throws {SpatialError} Invalid input or a correction that cannot be performed safely.
 */
function fromGeoJSON(input, options = {}) {
  validateOptions(options);
  if (input?.crs && !options.sourceCrs)
    fail('CRS', 'legacy GeoJSON crs requires an explicit sourceCrs', '$.crs');
  if (input?.type === 'FeatureCollection') {
    return collectResults(iterateGeoJSON(input, options));
  }
  if (input?.type === 'Feature') {
    if (!Object.hasOwn(input, 'geometry')) fail('SHAPE', 'Feature is missing geometry');
    input = input.geometry;
  }
  if (input === null) return null;
  if (input?.crs && !options.sourceCrs)
    fail('CRS', 'legacy GeoJSON crs requires an explicit sourceCrs');
  const ctx = context(options);
  return result(geo(input, ctx), ctx);
}
function spatial(g, ctx, path = '$', depth = 0) {
  if (depth > ctx.maxDepth) fail('LIMIT', 'geometry nesting limit exceeded', path);
  if (!g || !SQL_TYPES.includes(g.type))
    fail('TYPE', 'unsupported SQL spatial type', path);
  if (!GEO_TYPES.includes(g.type) || g.type === 'GeometryCollection')
    component(ctx, path);
  if (g.type === 'FullGlobe') {
    if (ctx.spatialType !== 'geography')
      fail('TYPE', 'FullGlobe is geography-only', path);
    if (depth > 0)
      fail('TYPE', 'FullGlobe cannot be a member of GeometryCollection', path);
    return { type: 'FullGlobe' };
  }
  if (g.type === 'GeometryCollection')
    return {
      type: g.type,
      geometries: array(g.geometries, `${path}.geometries`).map((v, i) =>
        spatial(v, ctx, `${path}.geometries[${i}]`, depth + 1),
      ),
    };
  if (GEO_TYPES.includes(g.type)) return geo(g, ctx, path, depth, true);
  if (ctx.transform)
    fail(
      'CURVE_CRS',
      'reprojection cannot preserve circular arcs exactly; supply target coordinates',
      path,
    );
  if (g.type === 'CircularString') {
    const points = array(g.coordinates, `${path}.coordinates`);
    if (!points.length) return { type: g.type, coordinates: [] };
    if (points.length < 3 || points.length % 2 === 0)
      fail('CURVE', 'CircularString needs an odd count of at least three points', path);
    const c = sequence(points, ctx, `${path}.coordinates`, {
      extended: true,
      curve: true,
    });
    for (let i = 0; i < c.length - 2; i += 2)
      if (equalXY(c[i], c[i + 2]))
        fail('CURVE', 'an arc cannot have identical start/end points', path);
    note(
      ctx,
      'SQL_VALIDATION_REQUIRED',
      path,
      'Curved topology must be checked with the target SQL engine',
    );
    return { type: g.type, coordinates: c };
  }
  if (g.type === 'CompoundCurve') {
    const segments = array(g.segments, `${path}.segments`).map((s, i) => {
      if (!['LineString', 'CircularString'].includes(s?.type))
        fail(
          'CURVE',
          'CompoundCurve supports LineString and CircularString segments',
          path,
        );
      const v = spatial(s, ctx, `${path}.segments[${i}]`, depth + 1);
      if (v.type !== s.type)
        fail(
          'CURVE_REPAIR',
          'repair changes a CompoundCurve segment type; supply non-overlapping sections',
          `${path}.segments[${i}]`,
        );
      if (!v.coordinates.length)
        fail('CURVE', 'empty segment inside nonempty CompoundCurve', path);
      return v;
    });
    for (let i = 1; i < segments.length; i++)
      if (!equal(segments[i - 1].coordinates.at(-1), segments[i].coordinates[0]))
        fail('CURVE', 'CompoundCurve segments must be continuous', path);
    return { type: g.type, segments };
  }
  const rings = array(g.rings, `${path}.rings`).map((r, i) => {
    if (!['LineString', 'CircularString', 'CompoundCurve'].includes(r?.type))
      fail('CURVE', 'unsupported CurvePolygon ring type', path);
    const v = spatial(r, ctx, `${path}.rings[${i}]`, depth + 1);
    if (v.type !== r.type)
      fail(
        'CURVE_REPAIR',
        'repair changes a CurvePolygon ring type; supply non-overlapping rings',
        `${path}.rings[${i}]`,
      );
    const points =
      v.type === 'CompoundCurve'
        ? v.segments.flatMap((s, j) => (j ? s.coordinates.slice(1) : s.coordinates))
        : v.coordinates;
    if (points.length < 4 || !equal(points[0], points.at(-1)))
      fail(
        'CURVE',
        'CurvePolygon rings must be closed and contain at least four positions',
        path,
      );
    // Arc control points are not a safe substitute for curved ring area. Keep explicit orientation.
    return v;
  });
  if (rings.length)
    note(
      ctx,
      'SQL_VALIDATION_REQUIRED',
      path,
      'CurvePolygon orientation and topology are preserved for SQL validation',
    );
  return { type: g.type, rings };
}
/**
 * Convert explicit SQL spatial shapes, including curves and FullGlobe.
 * Curved ring orientation is preserved; the caller must validate curved topology in SQL.
 * @param {object} input Spatial object with coordinates, segments or rings.
 * @param {ConversionOptions} [options] Target and validation settings.
 * @returns {SpatialResult} Parameter-ready conversion with diagnostics.
 * @throws {SpatialError} Unsupported shape, dimensions, projection or curve structure.
 */
function fromSpatial(input, options = {}) {
  const ctx = context(options);
  return result(spatial(input, ctx), ctx);
}
function esriCrs(sr, options = {}) {
  if (!sr) return undefined;
  if (typeof sr !== 'object' || Array.isArray(sr))
    fail('CRS', 'invalid Esri spatialReference');
  for (const key of ['wkt', 'wkt2'])
    if (sr[key] !== undefined && (typeof sr[key] !== 'string' || !sr[key].trim()))
      fail('CRS', `invalid ${key}`, '$.spatialReference');
  const text = sr.wkt2 ?? sr.wkt;
  if (sr.wkt2 && sr.wkt && !sameProjection(sr.wkt2, sr.wkt, options))
    fail('CRS', 'wkt and wkt2 definitions conflict', '$.spatialReference');
  const wkid = sr.latestWkid ?? sr.wkid;
  if (text) {
    const authority = Number.isInteger(wkid)
      ? knownAuthority(aliasWkid(wkid))
      : undefined;
    // Compare resolvable numeric metadata; unfamiliar WKIDs do not invalidate a full definition.
    if (
      authority === 'EPSG' &&
      !sameProjection(text, `${authority}:${aliasWkid(wkid)}`, options)
    )
      fail('CRS', 'text and WKID definitions conflict', '$.spatialReference');
    return text;
  }
  if (!Number.isInteger(wkid)) fail('CRS', 'invalid Esri spatialReference');
  if (aliasWkid(wkid) !== wkid) return `EPSG:${aliasWkid(wkid)}`;
  const supplied = ['EPSG', 'ESRI'].filter((authority) =>
    Object.hasOwn(options.projectionDefinitions ?? {}, `${authority}:${wkid}`),
  );
  const explicit = options.wkidAuthorities?.[wkid];
  if (explicit !== undefined && !['EPSG', 'ESRI'].includes(explicit))
    fail('CRS', 'WKID authority must be EPSG or ESRI', '$.spatialReference');
  if (!explicit && supplied.length > 1)
    fail(
      'CRS',
      'ambiguous WKID authority; supply sourceCrs or wkidAuthorities',
      '$.spatialReference',
    );
  if (explicit || supplied.length) return `${explicit ?? supplied[0]}:${wkid}`;
  const authority = knownAuthority(wkid);
  if (authority) return `${authority}:${wkid}`;
  // Native planar coordinates and caller converters do not require an inferred authority.
  if (
    options.converter ||
    (options.spatialType === 'geometry' && options.project === false)
  )
    return undefined;
  fail(
    'CRS',
    'unknown WKID authority; supply sourceCrs, projectionDefinitions or wkidAuthorities',
    '$.spatialReference',
  );
}
function curvePath(path, ctx, p) {
  array(path, p);
  if (!path.length) fail('CURVE', 'empty curve path', p);
  const dimensions = (v) => {
    array(v, p);
    return esriDimensions([v], ctx)[0];
  };
  let cursor = dimensions(path[0]),
    linear = [cursor],
    segments = [];
  const flush = () => {
    if (linear.length > 1) segments.push({ type: 'LineString', coordinates: linear });
  };
  for (let i = 1; i < path.length; i++) {
    const item = path[i];
    if (Array.isArray(item)) {
      cursor = dimensions(item);
      linear.push(cursor);
      continue;
    }
    if (!item || !Array.isArray(item.c) || item.c.length !== 2)
      fail(
        'CURVE',
        'only Esri circular c arcs are supported; elliptic and Bezier arcs need an explicit approximation policy',
        `${p}[${i}]`,
      );
    flush();
    const [end, interior] = item.c.map(dimensions);
    segments.push({
      type: 'CircularString',
      coordinates: [cursor, interior, end],
    });
    cursor = end;
    linear = [cursor];
  }
  flush();
  if (!segments.length) fail('COLLAPSED', 'curve path has no segments', p);
  return segments.length === 1 ? segments[0] : { type: 'CompoundCurve', segments };
}
/**
 * Convert ArcGIS geometry, feature or FeatureSet; retain all parts and Z/M values.
 * Spatial references supply projection unless explicitly overridden. Ambiguous rings fail.
 * @param {object} input Esri geometry or service response.
 * @param {ConversionOptions} [options] May include service geometry/dimension metadata.
 * @returns {SpatialResult|Array<object>|null} Conversion, feature results, or absent geometry.
 * @throws {SpatialError} Invalid data or unsupported/unsafe geometry correction.
 */
function fromEsri(input, options = {}) {
  validateOptions(options);
  if (input && Object.hasOwn(input, 'features')) return fromFeatureSet(input, options);
  const isFeature =
    input && (Object.hasOwn(input, 'geometry') || Object.hasOwn(input, 'attributes'));
  const g = isFeature ? input.geometry : input;
  if (g === null || (isFeature && g === undefined)) return null;
  if (!g || typeof g !== 'object') fail('SHAPE', 'expected an Esri geometry');
  const declared = g.spatialReference,
    shared = options.spatialReference;
  if (
    !options.sourceCrs &&
    declared &&
    shared &&
    !sameReference(declared, shared, options)
  )
    fail('CRS', 'feature and shared spatialReference conflict', '$.spatialReference');
  for (const key of ['hasZ', 'hasM']) {
    if (g[key] !== undefined && options[key] !== undefined && g[key] !== options[key])
      fail('DIMENSION', `feature and shared ${key} conflict`, `$.${key}`);
  }
  const sourceCrs =
    options.sourceCrs ??
    esriCrs(g.spatialReference ?? options.spatialReference, options);
  const ctx = context({
    ...options,
    srid:
      options.srid ??
      (options.spatialType === 'geometry' && options.project === false
        ? ((g.spatialReference ?? options.spatialReference)?.latestWkid ??
          (g.spatialReference ?? options.spatialReference)?.wkid)
        : undefined),
    sourceCrs,
    hasZ: options.hasZ ?? g.hasZ,
    hasM: options.hasM ?? g.hasM,
  });
  const type = options.geometryType ?? g.type;
  const actualType = Object.hasOwn(g, 'x')
    ? 'esriGeometryPoint'
    : g.points
      ? 'esriGeometryMultipoint'
      : g.paths || g.curvePaths
        ? 'esriGeometryPolyline'
        : g.rings || g.curveRings
          ? 'esriGeometryPolygon'
          : Object.hasOwn(g, 'xmin')
            ? 'esriGeometryEnvelope'
            : undefined;
  if (type && actualType && type !== actualType)
    fail('TYPE', 'geometryType conflicts with feature geometry', '$.geometryType');
  let normalized;
  if (g.x === null) {
    component(ctx, '$');
    return result({ type: 'Point', coordinates: [] }, ctx);
  }
  if (g.xmin === null) {
    component(ctx, '$');
    return result({ type: 'Polygon', coordinates: [] }, ctx);
  }
  if (g.curvePaths || g.curveRings) {
    // Identity CRS is safe for circular arcs; other reprojections are not.
    if (!options.converter && sourceCrs && ['EPSG:4326', 'WGS84'].includes(sourceCrs)) {
      ctx.sourceCrs = undefined;
      ctx.transform = undefined;
    }
    const paths = g.curvePaths ?? g.curveRings;
    const curves = array(paths, '$.curves').map((p, i) =>
      curvePath(p, ctx, `$.curves[${i}]`),
    );
    if (!curves.length)
      normalized = {
        type: g.curveRings ? 'CurvePolygon' : 'CompoundCurve',
        [g.curveRings ? 'rings' : 'segments']: [],
      };
    else if (g.curveRings) {
      const verified = spatial({ type: 'CurvePolygon', rings: curves }, ctx);
      normalized = normalizeCurveRings(verified.rings, ctx, '$.curveRings');
    } else
      normalized =
        curves.length === 1
          ? spatial(curves[0], ctx)
          : spatial({ type: 'GeometryCollection', geometries: curves }, ctx);
  } else if (Object.hasOwn(g, 'x') || type === 'esriGeometryPoint') {
    if (
      (ctx.hasZ === false && Object.hasOwn(g, 'z')) ||
      (ctx.hasM === false && Object.hasOwn(g, 'm'))
    )
      fail('DIMENSION', 'point properties conflict with Esri dimension flags');
    if (ctx.hasZ === true && !Object.hasOwn(g, 'z'))
      fail('DIMENSION', 'hasZ requires an elevation coordinate');
    const c = [g.x, g.y];
    if (Object.hasOwn(g, 'z')) c.push(g.z);
    if (Object.hasOwn(g, 'm') || ctx.hasM === true) {
      if (c.length === 2) c.push(null);
      c.push(Object.hasOwn(g, 'm') ? g.m : null);
    }
    normalized = geo({ type: 'Point', coordinates: c }, ctx, '$', 0, true);
  } else if (g.points || type === 'esriGeometryMultipoint') {
    const points = array(g.points, '$.points').filter((p, i) => {
      const empty = Array.isArray(p) && (p.length === 0 || p[0] === null);
      if (empty)
        note(
          ctx,
          'EMPTY_POINT_OMITTED',
          `$.points[${i}]`,
          'Omitted an empty Esri multipoint member',
        );
      return !empty;
    });
    normalized = geo(
      {
        type: 'MultiPoint',
        coordinates: esriDimensions(points, ctx),
      },
      ctx,
      '$',
      0,
      true,
    );
  } else if (g.paths || type === 'esriGeometryPolyline') {
    const paths = esriDimensions(g.paths, ctx);
    normalized = geo(
      paths.length <= 1
        ? { type: 'LineString', coordinates: paths[0] ?? [] }
        : { type: 'MultiLineString', coordinates: paths },
      ctx,
      '$',
      0,
      true,
    );
  } else if (g.rings || type === 'esriGeometryPolygon') {
    component(ctx, '$.rings', 1 + array(g.rings, '$.rings').length);
    const rings = array(esriDimensions(g.rings, ctx), '$.rings').map((r, i) =>
      sequence(r, ctx, `$.rings[${i}]`, { ring: true, extended: true }),
    );
    if (!rings.length) return result({ type: 'Polygon', coordinates: [] }, ctx);
    if (rings.some((r) => !r.length))
      fail('EMPTY_COMPONENT', 'empty ring inside Esri polygon');
    const polys = rings.length === 1 ? [rings] : classifyRings(rings, ctx, '$.rings');
    normalized = normalizePolygons(
      polys,
      polys.length > 1 ? 'MultiPolygon' : 'Polygon',
      ctx,
      '$.rings',
    );
  } else if (['xmin', 'ymin', 'xmax', 'ymax'].every((k) => Object.hasOwn(g, k))) {
    if (g.xmin >= g.xmax || g.ymin >= g.ymax)
      fail('ENVELOPE', 'envelope minimum must be smaller than maximum');
    normalized = geo(
      {
        type: 'Polygon',
        coordinates: [
          [
            [g.xmin, g.ymin],
            [g.xmax, g.ymin],
            [g.xmax, g.ymax],
            [g.xmin, g.ymax],
            [g.xmin, g.ymin],
          ],
        ],
      },
      ctx,
    );
  } else fail('TYPE', 'unrecognized Esri geometry');
  return result(normalized, ctx);
}
function esriDimensions(values, ctx) {
  array(values, '$.coordinates');
  const transform = (v, path, depth = 0) => {
    if (depth > ctx.maxDepth)
      fail('LIMIT', 'Esri coordinate nesting limit exceeded', path);
    array(v, path);
    if (!v.length) return [];
    if (Array.isArray(v[0]))
      return v.map((p, i) => transform(p, `${path}[${i}]`, depth + 1));
    if (ctx.hasZ === true && v.length < 3)
      fail('DIMENSION', 'hasZ requires an elevation coordinate', path);
    if (ctx.hasM === true) {
      const max = ctx.hasZ === true ? 4 : 3;
      if (v.length < 2 || v.length > max)
        fail('DIMENSION', 'coordinates conflict with Esri dimension flags', path);
      return ctx.hasZ === true
        ? [v[0], v[1], v[2], v[3] ?? null]
        : [v[0], v[1], null, v[2] ?? null];
    }
    if (
      (ctx.hasZ === false && ctx.hasM === false && v.length > 2) ||
      (ctx.hasM === false && v.length > 3)
    )
      fail('DIMENSION', 'coordinates conflict with Esri dimension flags', path);
    return v;
  };
  return transform(values, '$.coordinates');
}

/** Shared collection policy; single-feature converters still throw their own SpatialError. */
function collectResults(iterator) {
  const completed = [];
  try {
    for (const result of iterator) completed.push(result);
    return completed;
  } catch (error) {
    if (error instanceof SpatialError)
      // Recovery data is explicit, and is not automatically serialized with errors.
      Object.defineProperty(error, 'partialResults', { value: completed });
    throw error;
  }
}
function* featureResults(features, options, identify, convert) {
  validateOptions(options);
  for (const [name, fallback] of Object.entries({
    maxComponents: 10000,
    maxPositions: 100000,
    maxDepth: 32,
    maxTopologyChecks: 1000000,
  }))
    limit(options[name], fallback, name);
  array(features, '$.features');
  const onError = options.onError ?? 'collect';
  if (!['collect', 'throw'].includes(onError))
    fail('OPTIONS', 'onError must be collect or throw');
  const maxFeatures = limit(options.maxFeatures, 100000, 'maxFeatures');
  if (
    !Number.isInteger(maxFeatures) ||
    maxFeatures < 1 ||
    features.length > maxFeatures
  )
    fail('LIMIT', 'feature collection limit exceeded', '$.features');
  const totals = {
    index: 0,
    positions: 0,
    topologyChecks: 0,
    wktBytes: 0,
    limits: {
      positions: limit(options.maxTotalPositions, 1000000, 'maxTotalPositions'),
      topologyChecks: limit(
        options.maxTotalTopologyChecks,
        10000000,
        'maxTotalTopologyChecks',
      ),
      wktBytes: limit(options.maxTotalWktBytes, 64 * 1024 * 1024, 'maxTotalWktBytes'),
    },
  };
  const activeOptions = { ...options, [collectionBudget]: totals };
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    totals.index = i;
    let id;
    try {
      id = identify(f);
      const converted = convert(f, i, activeOptions);
      // Generated WKT contains only ASCII syntax and numbers, so length equals UTF-8 bytes.
      chargeCollection(totals, 'wktBytes', converted?.wkt.length ?? 0);
      yield { id, spatial: converted, error: null };
    } catch (e) {
      if (e?.scope === 'collection') throw e;
      const error =
        e instanceof SpatialError
          ? new SpatialError(e.code, e.detail, `$.features[${i}]${e.path.slice(1)}`, {
              cause: e.cause ?? e,
            })
          : new SpatialError(
              'INTERNAL',
              'unexpected feature conversion failure',
              `$.features[${i}]`,
              { cause: e },
            );
      if (onError === 'throw') {
        error.processedFeatures = i;
        throw error;
      }
      yield { id, spatial: null, error };
    }
  }
}
/** Pull-based GeoJSON collection conversion; no unused converted results are retained. */
function* iterateGeoJSON(input, options = {}) {
  validateOptions(options);
  if (input?.type !== 'FeatureCollection')
    fail('TYPE', 'expected a GeoJSON FeatureCollection');
  if (input.crs && !options.sourceCrs)
    fail('CRS', 'legacy GeoJSON crs requires an explicit sourceCrs', '$.crs');
  yield* featureResults(
    input.features,
    options,
    (f) => f?.id,
    (f, i, settings) => {
      if (f?.type !== 'Feature')
        fail('TYPE', 'FeatureCollection members must be Features');
      return fromGeoJSON(f, settings);
    },
  );
}
function sameReference(a, b, options) {
  const left = esriCrs(a, options),
    right = esriCrs(b, options);
  return left && right
    ? sameProjection(left, right, options)
    : (a.latestWkid ?? a.wkid) === (b.latestWkid ?? b.wkid);
}
function attribute(attributes, name) {
  if (typeof name !== 'string') return undefined;
  const names = Object.keys(attributes ?? {}).filter(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  if (names.length > 1) fail('IDENTITY', 'ambiguous case-insensitive identifier field');
  return names.length ? attributes[names[0]] : undefined;
}
/** Optional FeatureSet wrapper around individual-feature conversion. No I/O or persistence. */
function fromFeatureSet(input, options = {}) {
  return collectResults(iterateFeatureSet(input, options));
}
/** Resolve inherited metadata before consuming dependent features, including null-leading sets. */
function* iterateFeatureSet(input, options = {}) {
  validateOptions(options);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('SHAPE', 'expected an Esri FeatureSet');
  const shared = { ...options };
  for (const key of ['geometryType', 'spatialReference', 'hasZ', 'hasM'])
    shared[key] ??= input[key];
  array(input.features, '$.features');
  if (!shared.sourceCrs && !shared.spatialReference) {
    for (const feature of input.features) {
      try {
        const g = feature?.geometry;
        if (g && g.x !== null && g.xmin !== null && g.spatialReference) {
          shared.spatialReference = g.spatialReference;
          break;
        }
      } catch {
        /* A malformed member is reported at its own indexed conversion below. */
      }
    }
  }
  yield* featureResults(
    input.features,
    options,
    (f) =>
      attribute(f?.attributes, input.globalIdFieldName ?? 'GlobalID') ??
      attribute(f?.attributes, input.objectIdFieldName ?? 'OBJECTID'),
    (f, i, settings) => {
      if (!f || typeof f !== 'object' || Array.isArray(f))
        fail('SHAPE', 'expected an Esri feature');
      const active = { ...settings, ...shared };
      if (
        active.targetCrs &&
        active.project !== false &&
        !active.sourceCrs &&
        !active.spatialReference &&
        !active.converter &&
        f.geometry
      )
        fail('CRS', 'projection target requires a source reference');
      return fromEsri(f, active);
    },
  );
}
/**
 * Select the GeoJSON/Esri adapter, or use an explicitly requested spatial format.
 * @param {object|null} input Source geometry or feature collection.
 * @param {ConversionOptions & {format?: string}} [options] Optional format override.
 * @returns {SpatialResult|Array<object>|null} The selected adapter's result.
 * @throws {SpatialError} Unsupported format or invalid source data.
 */
function toSqlSpatial(input, options = {}) {
  validateOptions(options);
  if (options.format === 'spatial') return fromSpatial(input, options);
  if (options.format === 'esri') return fromEsri(input, options);
  if (options.format && options.format !== 'geojson')
    fail('FORMAT', 'unsupported input format');
  if (options.format === 'geojson') return fromGeoJSON(input, options);
  const g = input?.geometry ?? input;
  if (
    input?.geometryType ||
    (input?.features && input?.type !== 'FeatureCollection') ||
    input?.attributes ||
    (g &&
      (String(g.type).startsWith('esriGeometry') ||
        ['x', 'paths', 'rings', 'points', 'curvePaths', 'curveRings', 'xmin'].some(
          (k) => Object.hasOwn(g, k),
        )))
  )
    return fromEsri(input, options);
  return fromGeoJSON(input, options);
}
/**
 * Describe a bound constructor call; never execute SQL or append MakeValid.
 * @param {SpatialResult} value One conversion result, not a feature collection.
 * @param {object} [options] Optional wktParameter and sridParameter names.
 * @returns {object} Expression and typed parameters for the caller's SQL driver.
 * @throws {SpatialError} Invalid conversion result or parameter names.
 */
function sqlBinding(value, options = {}) {
  validateOptions(options);
  const { wktParameter = 'wkt', sridParameter = 'srid' } = options;
  if (
    !value ||
    Array.isArray(value) ||
    !['geography', 'geometry'].includes(value.spatialType) ||
    typeof value.wkt !== 'string' ||
    !Number.isInteger(value.srid) ||
    value.srid < 0 ||
    value.srid > 2147483647
  )
    fail('BINDING', 'expected one spatial conversion result');
  for (const name of [wktParameter, sridParameter])
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      fail('BINDING', 'invalid SQL parameter name');
  if (wktParameter === sridParameter)
    fail('BINDING', 'SQL parameter names must be distinct');
  return {
    expression: `${value.spatialType}::STGeomFromText(@${wktParameter}, @${sridParameter})`,
    parameters: {
      [wktParameter]: { type: 'NVarChar(MAX)', value: value.wkt },
      [sridParameter]: { type: 'Int', value: value.srid },
    },
  };
}
function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    fail('OPTIONS', 'expected conversion options');
}
export {
  GEO_TYPES,
  SQL_TYPES,
  fromGeoJSON,
  fromEsri,
  fromFeatureSet,
  iterateGeoJSON,
  iterateFeatureSet,
  fromSpatial,
  toSqlSpatial,
  sqlBinding,
  wkt,
};
