/**
 * @fileoverview Public API for pure GeoJSON/Esri-to-SQL spatial conversion.
 * Returns geometry, diagnostics and parameter bindings; execution belongs to the caller.
 */
export {
  fromGeoJSON,
  fromEsri,
  fromFeatureSet,
  iterateGeoJSON,
  iterateFeatureSet,
  fromSpatial,
  toSqlSpatial,
  sqlBinding,
  GEO_TYPES,
  SQL_TYPES,
} from './lib/convert.js';
export { SpatialError } from './lib/common.js';
