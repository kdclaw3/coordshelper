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
  converter?: (xy: [number, number]) => [number, number];
  spatialReference?: { wkid?: number; latestWkid?: number; wkt?: string };
  geometryType?: string;
  hasZ?: boolean;
  hasM?: boolean;
  maxPositions?: number;
  maxDepth?: number;
  maxTopologyChecks?: number;
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
  geometry: Geometry | null;
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
  validation: { structural: true; sqlServerValidated: false };
}
export class SpatialError extends Error {
  constructor(code: string, message: string, path?: string);
  readonly code: string;
  readonly path: string;
  readonly detail: string;
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
  input: Geometry | GeoJSONFeature | null,
  options?: ConversionOptions,
): SpatialResult | null;
export function fromGeoJSON(
  input: unknown,
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
export function fromSpatial(input: unknown, options?: ConversionOptions): SpatialResult;
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
