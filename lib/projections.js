/** @fileoverview Local CRS resolution, independent of proj4's mutable definition registry. */
import proj4 from 'proj4';
import parseWkt from 'wkt-parser';
// Private tree entry point is intentional at pinned wkt-parser 1.5.6. Dependency
// upgrades must pass projection compatibility, packed-consumer and SQL checks.
import parseWktTree from 'wkt-parser/parser.js';
import { SpatialError } from './errors.js';

// Fixed definitions match proj4's documented built-ins; never snapshot ambient registrations.
const WGS84 = '+proj=longlat +ellps=WGS84 +datum=WGS84 +units=degrees';
const MERCATOR =
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs';
const DEFINITIONS = Object.freeze({
  'EPSG:4326': WGS84,
  WGS84,
  'EPSG:4269': '+proj=longlat +ellps=GRS80 +datum=NAD83 +units=degrees',
  'EPSG:3857': MERCATOR,
  'EPSG:3785': MERCATOR,
  GOOGLE: MERCATOR,
  'EPSG:5041':
    '+proj=stere +lat_0=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m',
  'EPSG:5042':
    '+proj=stere +lat_0=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m',
});
const ALIASES = Object.freeze({ 102100: 3857, 102113: 3857, 900913: 3857 });
const AUTHORITIES = Object.freeze({ 54030: 'ESRI' });
// proj4 2.22.0's internal datum convention; unresolved-datum regressions guard it.
const PJD_NODATUM = 5;

export function knownAuthority(wkid) {
  if (Object.hasOwn(AUTHORITIES, wkid)) return AUTHORITIES[wkid];
  return builtinDefinition(`EPSG:${wkid}`) ? 'EPSG' : undefined;
}
export function aliasWkid(wkid) {
  return ALIASES[wkid] ?? wkid;
}
function builtinDefinition(name) {
  if (Object.hasOwn(DEFINITIONS, name)) return DEFINITIONS[name];
  const match = /^EPSG:(326|327)(\d{2})$/.exec(name);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 60)
    return `+proj=utm +zone=${Number(match[2])} ${match[1] === '327' ? '+south ' : ''}+datum=WGS84 +units=m`;
}
export function projectionDefinition(name, options = {}) {
  if (typeof name !== 'string' || !name.trim())
    throw new SpatialError('CRS', 'expected a nonempty CRS definition');
  const local = options.projectionDefinitions;
  const definition =
    local && Object.hasOwn(local, name) ? local[name] : builtinDefinition(name);
  if (definition !== undefined)
    return typeof definition === 'object' && definition !== null
      ? structuredClone(definition)
      : definition;
  // Inline PROJ/WKT definitions are inputs, not names looked up in a shared registry.
  if (
    name.includes('+proj=') ||
    /^(?:GEOGCS|PROJCS|GEOCCS|GEOGCRS|GEODCRS|PROJCRS|BOUNDCRS|COMPOUNDCRS)\s*\[/i.test(
      name,
    )
  )
    return name;
  throw new SpatialError(
    'CRS',
    'unknown projection; supply projectionDefinitions or converter',
  );
}
export function parseProjection(name, options, path = '$.spatialReference') {
  try {
    let definition = projectionDefinition(name, options);
    if (
      typeof definition === 'string' &&
      /\b(?:DYNAMIC|VERTCRS|VERT_CS|COMPOUNDCRS|COMPD_CS)\s*\[/i.test(definition)
    )
      throw Error(
        'dynamic or compound/vertical reference requires an explicit converter',
      );
    const wasWkt = typeof definition === 'string' && !definition.includes('+proj=');
    if (wasWkt) definition = isolatedWkt(definition);
    if (typeof definition === 'object' && definition !== null) {
      delete definition.title;
      delete definition.AUTHORITY;
      delete definition.authority;
    }
    const projection = new proj4.Proj(definition);
    // EPSG pseudo-Mercator deliberately uses a WGS84-sized sphere without a
    // datum transformation; isolatedWkt validates this specific exception.
    const webSphere =
      definition.projName === 'merc' &&
      definition.datumCode === 'none' &&
      definition.sphere === true &&
      definition.a === 6378137 &&
      definition.b === 6378137;
    if (wasWkt && projection.datum?.datum_type === PJD_NODATUM && !webSphere)
      throw Error('unresolved WKT datum transformation');
    projection.angularToDegrees = definition.angularToDegrees ?? 1;
    return projection;
  } catch (cause) {
    throw new SpatialError(
      'CRS',
      'unsupported or invalid projection definition',
      path,
      { cause },
    );
  }
}
/** Detect the unverified zero-shift leg when crossing to/from plain NAD83. */
export function usesNad83ZeroShift(source, target) {
  const isNad83 = (p) => String(p.datumCode).toLowerCase() === 'nad83';
  if (isNad83(source) === isNad83(target)) return false;
  const nad83 = isNad83(source) ? source : target;
  const parameters = nad83.datum_params ?? [];
  return (
    parameters.every((p) => Number(p) === 0) &&
    (!nad83.nadgrids || nad83.nadgrids === '@null')
  );
}
/** Normalize datum/unit metadata without allowing authority labels to redirect parsing. */
function isolatedWkt(text) {
  const definition = parseWkt(text),
    tree = parseWktTree(text);
  if (/^BOUNDCRS$/i.test(tree[0]))
    throw Error('bound transformations require an explicit converter');
  const node = (parent, ...names) =>
    parent?.find((v) => Array.isArray(v) && names.includes(v[0]));
  const geographic = ['GEOGCS', 'GEOGCRS', 'GEODCRS'].includes(tree[0])
    ? tree
    : node(tree, 'GEOGCS', 'BASEGEOGCRS', 'BASEGEODCRS');
  const datum = node(geographic, 'DATUM', 'GEODETICDATUM', 'ENSEMBLE');
  const normalized = String(datum?.[1] ?? '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .replace(/^d(?=wgs|north|nad)/, '');
  if (
    [
      'wgs84',
      'wgs1984',
      'worldgeodeticsystem1984',
      'worldgeodeticsystem1984ensemble',
    ].includes(normalized)
  )
    definition.datumCode = 'WGS84';
  else if (
    ['nad83', 'northamericandatum1983', 'northamerican1983'].includes(normalized)
  )
    definition.datumCode = 'NAD83';
  else if (!definition.datumCode || /^EPSG_/i.test(definition.datumCode))
    throw Error(
      'unresolved WKT datum; supply an explicit converter or verified PROJ definition',
    );
  const unit =
    node(
      tree,
      definition.projName === 'longlat' ? 'ANGLEUNIT' : 'LENGTHUNIT',
      'UNIT',
    ) ??
    node(
      node(tree, 'AXIS'),
      definition.projName === 'longlat' ? 'ANGLEUNIT' : 'LENGTHUNIT',
      'UNIT',
    );
  if (definition.projName === 'longlat') {
    if (!unit || !Number.isFinite(Number(unit[2])) || Number(unit[2]) <= 0)
      throw Error('unresolved angular units');
    definition.angularToDegrees = Number(unit[2]) / (Math.PI / 180);
    if (Math.abs(definition.angularToDegrees - 1) < 1e-12)
      definition.angularToDegrees = 1;
  } else if (unit) {
    if (!Number.isFinite(Number(unit[2])) || Number(unit[2]) <= 0)
      throw Error('invalid linear units');
    definition.to_meter = Number(unit[2]);
  }
  // proj4 special-cases authority labels through global defs even for parsed objects.
  delete definition.title;
  delete definition.AUTHORITY;
  delete definition.authority;
  const method =
    node(node(tree, 'CONVERSION'), 'METHOD')?.[1] ?? node(tree, 'PROJECTION')?.[1];
  if (
    /^(?:Popular Visualisation Pseudo Mercator|Mercator_Auxiliary_Sphere)$/i.test(
      method ?? '',
    )
  ) {
    if (
      definition.datumCode !== 'WGS84' ||
      (definition.Auxiliary_Sphere_Type !== undefined &&
        definition.Auxiliary_Sphere_Type !== 0)
    )
      throw Error('unsupported pseudo-Mercator datum or auxiliary sphere type');
    definition.projName = 'merc';
    definition.a = 6378137;
    definition.b = 6378137;
    definition.rf = 0;
    definition.sphere = true;
    // Match the built-in +nadgrids=@null definition, whose parser selects
    // "none" rather than attaching a grid shift to the spherical ellipsoid.
    definition.datumCode = 'none';
    delete definition.datum_params;
    delete definition.nadgrids;
    delete definition.Auxiliary_Sphere_Type;
  }
  return definition;
}
/** Compare normalized projection parameters, not formatting, labels or authority text. */
export function sameProjection(left, right, options) {
  if (left === right) return true;
  const a = parseProjection(left, options),
    b = parseProjection(right, options);
  const numeric = [
    'a',
    'b',
    'rf',
    'lat0',
    'lat1',
    'lat2',
    'lat_ts',
    'long0',
    'long1',
    'long2',
    'longc',
    'alpha',
    'x0',
    'y0',
    'k0',
    'from_greenwich',
    'angularToDegrees',
  ];
  if (a.projName !== 'longlat') numeric.push('to_meter');
  const close = (x, y) =>
    x === y ||
    (typeof x === 'number' &&
      typeof y === 'number' &&
      Math.abs(x - y) <= Math.max(1, Math.abs(x), Math.abs(y)) * 1e-12);
  // Also compare all scalar parameters, including projection-specific ones, so
  // unfamiliar parameters fail conservatively rather than disappear from equality.
  // Labels, parser aliases and ellipsoid/datum names are resolved elsewhere below.
  const metadata = new Set([
    'names',
    'name',
    'title',
    'srsCode',
    'projStr',
    'PROJECTION',
    'local',
    'projName',
    'dependsOn',
    'units',
    'ellps',
    'type',
    'datumCode',
    'datumName',
    'datum_params',
    'no_defs',
    'standard_parallel_1',
    'standard_parallel_2',
    'false_easting',
    'false_northing',
    'central_meridian',
    'latitude_of_origin',
    'scale_factor',
    'latitude_of_center',
    'longitude_of_center',
    'azimuth',
    'False_Easting',
    'False_Northing',
    'Central_Meridian',
    'Scale_Factor',
    'Latitude_Of_Origin',
    'Standard_Parallel_1',
    'Standard_Parallel_2',
    'latitude_of_natural_origin',
    'longitude_of_natural_origin',
    'scale_factor_at_natural_origin',
  ]);
  // UTM initializes the same transverse-Mercator algorithm and expresses its
  // zone/hemisphere through long0, y0, x0 and k0. Compare those initialized values.
  for (const p of [a, b])
    if (p.projName === 'utm') {
      metadata.add('zone');
      metadata.add('utmSouth');
    }
  if (a.projName === 'longlat') metadata.add('to_meter');
  const scalar = (v) => ['number', 'string', 'boolean'].includes(typeof v);
  const keys = new Set(
    [...Object.keys(a), ...Object.keys(b)].filter(
      (k) => !metadata.has(k) && (scalar(a[k]) || scalar(b[k])),
    ),
  );
  const value = (p, key) =>
    p[key] ??
    (key === 'axis'
      ? 'enu'
      : key === 'sweep' && p.projName === 'geos'
        ? 'y'
        : ['k0', 'to_meter', 'angularToDegrees'].includes(key)
          ? 1
          : ['utmSouth', 'sphere', 'over', 'R_A', 'approx'].includes(key)
            ? false
            : numeric.includes(key)
              ? 0
              : undefined);
  return (
    a.forward === b.forward &&
    a.inverse === b.inverse &&
    numeric.every((k) =>
      close(
        a[k] ?? (k === 'k0' || k === 'to_meter' || k === 'angularToDegrees' ? 1 : 0),
        b[k] ?? (k === 'k0' || k === 'to_meter' || k === 'angularToDegrees' ? 1 : 0),
      ),
    ) &&
    a.datum?.datum_type === b.datum?.datum_type &&
    JSON.stringify(a.datum?.datum_params ?? []) ===
      JSON.stringify(b.datum?.datum_params ?? []) &&
    JSON.stringify(a.nadgrids ?? []) === JSON.stringify(b.nadgrids ?? []) &&
    [...keys].every((k) => close(value(a, k), value(b, k)))
  );
}
