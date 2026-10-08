/** Pure conversion settings. Coordinate transformation never changes Z/M. */
export interface ConversionOptions {
  spatialType?: 'geography' | 'geometry';
  srid?: number;
  repair?: 'none' | 'safe' | 'topology';
  orientation?: 'normalize' | 'preserve';
  sourceCrs?: string;
  targetCrs?: string;
  project?: boolean;
  projectionDefinitions?: Record<string, string | object>;
  /** Explicit authority for a WKID whose namespace cannot be resolved. */
  wkidAuthorities?: Record<number, 'EPSG' | 'ESRI'>;
  converter?: (xy: [number, number]) => [number, number];
  /** Opt in to an approximate plain NAD83/WGS84 zero datum shift, with a diagnostic. */
  allowNad83ZeroShift?: boolean;
  spatialReference?: {
    wkid?: number;
    latestWkid?: number;
    wkt?: string;
    wkt2?: string;
  };
  geometryType?: string;
  hasZ?: boolean;
  hasM?: boolean;
  maxPositions?: number;
  maxDepth?: number;
  maxTopologyChecks?: number;
  /** Counts geometry objects and members/rings, including empty components. */
  maxComponents?: number;
  maxTotalPositions?: number;
  maxTotalTopologyChecks?: number;
  /** Aggregate generated ASCII WKT bytes; collection exhaustion stops iteration. */
  maxTotalWktBytes?: number;
  maxFeatures?: number;
  onError?: 'collect' | 'throw';
}
export type Coordinate =
  | [number, number]
  | [number, number, number]
  | [number, number, number | null, number | null];
export type GeoType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'GeometryCollection';
export type GeoJSONPosition = [number, number] | [number, number, number];
/** RFC 7946 input types; SQL curves, FullGlobe and nullable Z/M belong to Geometry. */
export type GeoJSONGeometry =
  | { type: 'Point'; coordinates: GeoJSONPosition | [] }
  | { type: 'MultiPoint' | 'LineString'; coordinates: GeoJSONPosition[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: GeoJSONPosition[][] }
  | { type: 'MultiPolygon'; coordinates: GeoJSONPosition[][][] }
  | { type: 'GeometryCollection'; geometries: GeoJSONGeometry[] };
export type SqlType =
  GeoType | 'CircularString' | 'CompoundCurve' | 'CurvePolygon' | 'FullGlobe';
export type Geometry =
  | { type: 'Point'; coordinates: Coordinate | [] }
  | { type: 'MultiPoint' | 'LineString' | 'CircularString'; coordinates: Coordinate[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: Coordinate[][] }
  | { type: 'MultiPolygon'; coordinates: Coordinate[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] }
  | { type: 'CompoundCurve'; segments: Geometry[] }
  | { type: 'CurvePolygon'; rings: Geometry[] }
  | { type: 'FullGlobe' };
export interface GeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJSONGeometry | null;
  properties?: object | null;
}
export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}
export interface Diagnostic {
  code: string;
  path: string;
  detail: unknown;
}
export interface SpatialResult {
  type: SqlType;
  spatialType: 'geography' | 'geometry';
  srid: number;
  wkt: string;
  geometry: Geometry;
  diagnostics: Diagnostic[];
  validation: { structural: true; sqlServerValidated: false; topologyChecks: number };
}
export class SpatialError extends Error {
  constructor(code: string, message: string, path?: string, options?: ErrorOptions);
  readonly code: string;
  readonly path: string;
  readonly detail: string;
  readonly scope?: 'collection';
  readonly processedFeatures?: number;
  /** Eager adapters retain completed results on terminal collection or throw-mode feature errors. */
  readonly partialResults?: readonly FeatureResult[];
}
export interface FeatureResult {
  id: unknown;
  spatial: SpatialResult | null;
  error: SpatialError | null;
}
export interface EsriFeature {
  attributes?: Record<string, unknown>;
  geometry?: Record<string, unknown> | null;
}
export interface EsriFeatureSet {
  features: EsriFeature[];
  geometryType?: string;
  spatialReference?: ConversionOptions['spatialReference'];
  hasZ?: boolean;
  hasM?: boolean;
  objectIdFieldName?: string;
  globalIdFieldName?: string;
}
export const GEO_TYPES: readonly GeoType[];
export const SQL_TYPES: readonly SqlType[];
export function fromGeoJSON(
  input: GeoJSONFeatureCollection,
  options?: ConversionOptions,
): FeatureResult[];
export function fromGeoJSON(
  input: GeoJSONGeometry | GeoJSONFeature | null,
  options?: ConversionOptions,
): SpatialResult | null;
export function fromGeoJSON(
  input: GeoJSONGeometry | GeoJSONFeature | GeoJSONFeatureCollection | null,
  options?: ConversionOptions,
): SpatialResult | FeatureResult[] | null;
export function fromEsri(
  input: EsriFeatureSet,
  options?: ConversionOptions,
): FeatureResult[];
export function fromEsri(
  input: EsriFeature | Record<string, unknown>,
  options?: ConversionOptions,
): SpatialResult | null;
export function fromEsri(
  input: unknown,
  options?: ConversionOptions,
): SpatialResult | FeatureResult[] | null;
export function fromFeatureSet(
  input: EsriFeatureSet,
  options?: ConversionOptions,
): FeatureResult[];
/** Lazy collection counterparts; only consumed features are converted. */
export function iterateFeatureSet(
  input: EsriFeatureSet,
  options?: ConversionOptions,
): Generator<FeatureResult, void, unknown>;
export function iterateGeoJSON(
  input: GeoJSONFeatureCollection,
  options?: ConversionOptions,
): Generator<FeatureResult, void, unknown>;
export function fromSpatial(
  input: Geometry,
  options?: ConversionOptions,
): SpatialResult;
export function toSqlSpatial(
  input: unknown,
  options?: ConversionOptions & { format?: 'geojson' | 'esri' | 'spatial' },
): SpatialResult | FeatureResult[] | null;
export interface SqlBinding {
  expression: string;
  parameters: Record<
    string,
    { type: 'NVarChar(MAX)'; value: string } | { type: 'Int'; value: number }
  >;
}
export function sqlBinding(
  value: SpatialResult,
  options?: { wktParameter?: string; sridParameter?: string },
): SqlBinding;
