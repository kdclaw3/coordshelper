# coordshelper v2

Pure GeoJSON and Esri JSON conversion to parameterized SQL Server `geography` or
`geometry` constructors. Version 2 is currently unreleased and replaces the v1 API.
It performs no network access, database execution or automatic SQL `MakeValid()`.

## Runtime and API

Node.js 22 or newer. The supported interface is **ESM-only**, with named exports;
CommonJS `require()` is not supported. TypeScript declarations are included.

```js
import { fromGeoJSON, sqlBinding } from 'coordshelper';

const value = fromGeoJSON({
  type: 'Feature',
  id: 'source-uuid',
  properties: {},
  geometry: { type: 'Point', coordinates: [-83, 43] },
});
const binding = sqlBinding(value);
// expression: geography::STGeomFromText(@wkt, @srid)
// Bind parameters.wkt as NVarChar(MAX), parameters.srid as Int.
```

The application binds and executes SQL. Single-feature conversion does not choose
an asset identifier or persist anything; it returns the spatial value only.

| Export                           | Input and result                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `fromGeoJSON(input, options)`    | Geometry, Feature or FeatureCollection; one spatial result, null, or per-feature results. |
| `fromEsri(input, options)`       | Esri geometry, individual feature or FeatureSet.                                          |
| `fromFeatureSet(input, options)` | Optional Esri collection wrapper around the same single-feature converter.                |
| `fromSpatial(input, options)`    | Explicit SQL spatial representation, including curves and FullGlobe.                      |
| `toSqlSpatial(input, options)`   | Adapter selection; `format` can explicitly select geojson, esri or spatial.               |
| `sqlBinding(result, options)`    | One bound SQL constructor; optionally customize distinct parameter names.                 |
| `SpatialError`                   | Failure with stable `code`, `path` and `detail`.                                          |

A spatial result contains `type`, `spatialType`, `srid`, `wkt`, normalized `geometry`,
`diagnostics` and `validation`. The input is not mutated. **`sqlServerValidated`
is always false**: local checks do not replace verification in the target SQL engine.

## Individual features and optional collections

Individual features are the primary conversion contract. An Esri feature can omit
metadata stored on its containing FeatureSet; supply it in conversion options:

```js
import { fromEsri, fromFeatureSet } from 'coordshelper';

const spatial = fromEsri(feature, {
  spatialReference: { wkid: 4326 },
  hasZ: false,
  hasM: true,
});
const results = fromFeatureSet(response, { onError: 'collect' });
for (const { id, spatial, error } of results) {
  if (error) console.error(id, error.code, error.path);
  else if (spatial) console.log(id, spatial.wkt);
}
```

Both collection adapters default to `onError: 'collect'`, returning
`{id, spatial, error}` for every feature. Errors include `$.features[index]`.
Use `onError: 'throw'` to stop at the first failure. Malformed collection structure
or collection-wide legacy CRS declarations can fail before feature processing.

Esri shared metadata includes `geometryType`, `spatialReference`, `hasZ` and `hasM`.
Conflicting feature declarations are rejected. If shared CRS is missing, the first
feature's CRS supplies it. Declared GlobalID fields take precedence over ObjectID,
matching names regardless of case; duplicate casing is an identity error. UUID
normalization, uniqueness checks, pagination and synchronization belong to the caller.
Without declared field names, the wrapper looks for GlobalID and OBJECTID.

## Projection and native planar coordinates

GeoJSON coordinates are WGS84 longitude/latitude unless the caller explicitly
supplies `sourceCrs`. Legacy `crs` on a Geometry, Feature or FeatureCollection requires
an explicit `sourceCrs`; it is never silently accepted as WGS84.

Esri WKIDs can supply the source CRS. Common Web Mercator aliases resolve to
EPSG:3857; Esri-only 100xxx identifiers remain in the ESRI namespace. Prefer a
verified `latestWkid` where available. The library does not bundle every projection.
Provide missing definitions or a ready-made XY converter:

```js
const projected = fromEsri(feature, {
  projectionDefinitions: { 'ESRI:102999': verifiedProjectionDefinition },
});
const custom = fromEsri(feature, {
  converter: ([x, y]) => existingConverter.forward([x, y]),
});
const native = fromEsri(feature, {
  spatialType: 'geometry',
  project: false,
  srid: 1234,
});
```

Definition maps are local to a conversion; proj4's global registry is not modified.
Projection is constructed once per feature, not once per position. Z/M values are
preserved without vertical transformation. The converter must return two finite XY
numbers. Reprojected planar output requires `targetCrs` unless a converter is supplied.

Native planar output retains source coordinates. When `srid` is omitted in native
Esri mode, a numeric `latestWkid`/`wkid` becomes the label; that label does not prove
the identifier is an EPSG code. Geography output supports **WGS84 SRID 4326 only**;
other datums, including NAD83 and GDA94, require verified reprojection to WGS84.

## Shapes, dimensions and empty values

All seven GeoJSON geometry types are supported, with XY and optional Z. Measures
require Esri or explicit spatial input: XYM emits SQL's positional `NULL` Z, and
XYZM preserves both. SQL dimensional markers such as `POINT Z` are not emitted.
Mixed dimensions, nonfinite coordinates and inconsistent ring closure are rejected.

GeoJSON null geometry and Esri features without geometry return null. Empty coordinate
arrays produce typed `EMPTY` values. Esri `{x: null}` and `{xmin: null}` produce empty
Point and Polygon respectively. Strings such as `"NaN"` are malformed coordinates,
not silently discarded records. Empty rings inside nonempty polygons are rejected.

`fromSpatial` supports CircularString (`coordinates`), CompoundCurve (`segments`),
CurvePolygon (`rings`) and FullGlobe. These are not invented GeoJSON types. FullGlobe
is geography-only and cannot be nested inside GeometryCollection. Explicit spatial
curved ring direction is preserved for the caller's target-engine verification.

Esri circular `c` arcs are retained as curves. Its curved rings are classified using
analytic local circular geometry, shells rewound counterclockwise and holes clockwise;
several shells produce GeometryCollection. Geography classification is restricted to
local non-polar extents at most 10 degrees wide/high within +/-80 latitude. Crossings,
contacts, overlapping arcs, global ambiguity, elliptical/Bezier arcs and curved
reprojection are rejected. `orientation: 'preserve'` is unavailable for Esri curved
rings; use explicit spatial input for deliberate interiors. Verify curved hole
containment, intended interior and area in SQL; validity alone is insufficient.

## Repairs and interpretation

| Policy                     | Behavior                                                                  |
| -------------------------- | ------------------------------------------------------------------------- |
| `repair: 'none'`           | Reject incorrect closure, duplicate vertices or winding.                  |
| `repair: 'safe'` (default) | Diagnose structural closure, exact duplicate removal and winding changes. |
| `repair: 'topology'`       | Explicit local topology repair; can change type, vertices or part count.  |

Polygon winding uses WGS84 ellipsoidal area. `orientation: 'preserve'` retains deliberate
large interiors for ordinary GeoJSON or explicit spatial input. Planar clipping is
not used to repair polar/global topology, dimensional topology or preserved interiors.
Ordinary explicit polygon repair uses a nonzero shell union minus holes.

Esri containment handles disjoint shells, holes and islands. Under explicit topology
repair, consistently clockwise shell rings can be unioned. Crossing mixed-role rings
remain rejected rather than guessing shell/hole intent. Line overlap repair preserves
directed traversal and every Z/M value by isolating affected segments in a
GeometryCollection, retaining unaffected runs. A repair that changes a CompoundCurve
section's type is rejected with `CURVE_REPAIR`.

Polygon intersection screening uses unwrapped planar coordinates; SQL geography uses
curved-earth edges. Especially for long edges, these interpretations can differ.
There is **no automatic densification** or universal ellipsoidal MakeValid replacement.
Applications must choose their edge interpretation and verify results in SQL Server.

## Limits and performance

Defaults: `maxPositions: 100000`, `maxDepth: 32`, `maxTopologyChecks: 1000000`, and
`maxFeatures: 100000`. Limits apply per feature except the collection size limit.
Bounding-box filtering removes irrelevant segment comparisons. Broad-phase pair work
and containment checks are budgeted; dense/pathological shapes can still hit a limit.
Raise limits explicitly only after measuring representative data.

`sqlBinding` handles one spatial value. Database batching, SQL parameter limits and
table-valued parameters remain the consuming application's responsibility.

## Development and verification

```sh
npm ci
npm test
npm run test:types
npm run format:check
npm run benchmark
node examples/v2.js
```

Tests are portable synthetic package tests, using Node's built-in runner. No private
workspace repositories or customer systems are needed. Formatting uses a pinned
transient Prettier invocation; Prettier is not a package dependency. Runtime dependencies
provide geodesic calculations, clipping and projection; TypeScript is development-only.

SQL tests are opt-in, use bound parameters and local SQL variables, and perform no
table/schema/transaction writes or cleanup. Install `mssql` separately in your test
environment, or set `SPATIAL_SQL_DRIVER` to its module URL. Set `SPATIAL_SQL_TEST=1`,
`SPATIAL_TEST_DB_HOST`, `PORT`, `USER`, `PASSWORD` and `DATABASE` with the shared
`SPATIAL_TEST_DB_` prefix. Certificate trust, if required, is an explicit
`SPATIAL_TEST_TRUST_CERTIFICATE=1`. Run `npm run test:sql`. Optional
`SPATIAL_TEST_REPORT` writes synthetic evidence locally. Never commit credentials.

CI tests Node 22 and 24 and does not publish the package. Successful unit tests do not
establish acceptance on every SQL Server version. Before deployment, verify SQL validity,
SRID, intended area/containment and the application's complete save/read/map path.

## References

- [GeoJSON RFC 7946](https://www.rfc-editor.org/rfc/rfc7946)
- [Esri geometry objects](https://developers.arcgis.com/rest/services-reference/enterprise/geometry-objects/)
- [Esri FeatureSet](https://developers.arcgis.com/rest/services-reference/enterprise/featureset-object/)
- [SQL Server spatial types](https://learn.microsoft.com/en-us/sql/relational-databases/spatial/spatial-data-types-overview)
- [Proj4js](https://github.com/proj4js/proj4js)
- [GeographicLib](https://github.com/geographiclib/geographiclib-js)
- [polyclip-ts](https://github.com/luizbarboza/polyclip-ts)
