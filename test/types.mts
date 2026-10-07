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
