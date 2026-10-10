import {
  fromGeoJSON,
  fromFeatureSet,
  fromEsri,
  fromSpatial,
  toSqlSpatial,
  sqlBinding,
  SpatialError,
  GEO_TYPES,
  SQL_TYPES,
} from 'coordshelper';
import type { ConversionOptions, SpatialResult, FeatureResult } from 'coordshelper';

const options: ConversionOptions = {
  repair: 'safe',
  converter: ([x, y]) => [x, y],
  project: true,
};
const single = fromGeoJSON({ type: 'Point', coordinates: [0, 0] }, options);
if (single) {
  const result: SpatialResult = single;
  sqlBinding(result);
}
const rows: FeatureResult[] = fromFeatureSet({
  features: [{ attributes: { id: 1 }, geometry: null }],
});
rows.forEach((row) => {
  if (row.error instanceof SpatialError) console.log(row.error.code, row.error.path);
});
fromGeoJSON({ type: 'FeatureCollection', features: [] });
fromEsri({ x: 1, y: 2 });
fromSpatial({ type: 'FullGlobe' });
toSqlSpatial(null);
GEO_TYPES.includes('Polygon');
SQL_TYPES.includes('CurvePolygon');
// @ts-expect-error Unknown repair policies must not type-check.
fromGeoJSON(null, { repair: 'always-make-valid' });
// @ts-expect-error SQL binding accepts one conversion, not collection results.
sqlBinding(rows);
// @ts-expect-error Invalid projection callbacks must not type-check.
fromEsri({}, { converter: (x: string) => x });
// @ts-expect-error Input format is a closed set.
toSqlSpatial(null, { format: 'wkt' });
// @ts-expect-error FullGlobe is SQL spatial input, never GeoJSON.
fromGeoJSON({ type: 'FullGlobe' });
// @ts-expect-error SQL curved types cannot appear in a GeoJSON Feature.
fromGeoJSON({ type: 'Feature', geometry: { type: 'CurvePolygon', rings: [] } });
// @ts-expect-error Nested GeoJSON collections cannot contain SQL-only shapes.
fromGeoJSON({ type: 'GeometryCollection', geometries: [{ type: 'FullGlobe' }] });
// @ts-expect-error GeoJSON positions cannot contain SQL NULL dimensions.
fromGeoJSON({ type: 'Point', coordinates: [0, 0, null, null] });
const unvalidated: unknown = { type: 'Point', coordinates: [0, 0] };
// @ts-expect-error External unknown inputs must be narrowed before calling the typed API.
fromGeoJSON(unvalidated);
fromSpatial({ type: 'CurvePolygon', rings: [] });
fromGeoJSON({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'GeometryCollection',
        geometries: [{ type: 'Point', coordinates: [0, 0, 3] }],
      },
    },
  ],
});
import { iterateFeatureSet, iterateGeoJSON } from '../index.js';
for (const row of iterateFeatureSet(
  { features: [], spatialReference: { wkt2: 'definition' } },
  {
    maxComponents: 10,
    maxTotalPositions: 100,
    maxTotalTopologyChecks: 1000,
    maxTotalWktBytes: 1000,
  },
))
  row.error?.processedFeatures;
iterateGeoJSON({ type: 'FeatureCollection', features: [] });
// @ts-expect-error Iteration requires a collection, not a single geometry.
iterateGeoJSON({ type: 'Point', coordinates: [0, 0] });
// @ts-expect-error The component limit must be numeric.
fromSpatial({ type: 'FullGlobe' }, { maxComponents: 'unlimited' });
fromEsri({}, { allowNad83ZeroShift: true });
fromGeoJSON(null, { repair: 'topology', lineOverlap: 'deduplicate' });
fromSpatial({ type: 'LineString', coordinates: [] }, { lineOverlap: 'preserve' });
// @ts-expect-error Line cleanup policies are a closed set.
fromGeoJSON(null, { repair: 'topology', lineOverlap: 'merge' });
// @ts-expect-error Datum approximation requires a boolean opt-in.
fromEsri({}, { allowNad83ZeroShift: 'yes' });
try {
  fromFeatureSet({ features: [] });
} catch (error) {
  if (error instanceof SpatialError) {
    const completed: readonly FeatureResult[] | undefined = error.partialResults;
    completed?.forEach((row) => row.spatial?.wkt);
    // @ts-expect-error Recovery array is read-only in the declared contract.
    error.partialResults?.push({ id: 1, spatial: null, error: null });
  }
}
