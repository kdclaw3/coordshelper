# coordshelper

Convert GeoJSON and Esri JSON into validated, parameter-ready SQL Server `geography` and `geometry` values, with ring orientation, explicit repairs and diagnostics.

[![npm](https://img.shields.io/npm/v/coordshelper)](https://www.npmjs.com/package/coordshelper)
[![CI](https://github.com/kdclaw3/coordshelper/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/kdclaw3/coordshelper/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Importing GIS features into SQL Server often means writing code to reproject coordinates, build WKT, correct polygon rings and keep multipart geometry intact.

coordshelper handles those steps for GeoJSON and Esri JSON. Supply a feature, convert it to a SQL spatial value and bind it to your query. Holes, parts, elevations and measures are preserved, and diagnostics show any repairs made before you save the result.

## Install and requirements

Install the tagged release from GitHub:

```sh
npm install github:kdclaw3/coordshelper#v2.0.0
```

- Node.js **22 or newer**, **ESM named imports**. TypeScript declarations are included.
- SQL acceptance tested against **SQL Server 2019**, engine 15.0.4198.2, compatibility level 150.
- A database driver is optional. Install `mssql` to run the SQL example below.

The API below is the 2.x interface. See [Migrating from v1](#migrating-from-v1) for existing installations.

## Quick start

```sh
npm install mssql
```

Save this as `example.mjs`. Supply `DB_HOST`, `DB_PORT` (optional), `DB_DATABASE`, `DB_USER` and `DB_PASSWORD` in the environment, then run `node example.mjs`.

```js
import sql from 'mssql';
import { fromGeoJSON, sqlBinding } from 'coordshelper';

const result = fromGeoJSON({ type: 'Point', coordinates: [-83, 43] });
const { expression, parameters } = sqlBinding(result);
console.log(result);

const pool = await new sql.ConnectionPool({
  server: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 1433),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true },
}).connect();

try {
  const response = await pool
    .request()
    .input('wkt', sql.NVarChar(sql.MAX), parameters.wkt.value)
    .input('srid', sql.Int, parameters.srid.value)
    .query(`DECLARE @location geography = ${expression};
      SELECT @location.STAsText() AS wkt, @location.STIsValid() AS valid;`);
  console.log(response.recordset[0]); // { wkt: 'POINT (-83 43)', valid: true }
} finally {
  await pool.close();
}
```

This executes a parameterized spatial constructor without creating a table or changing records. Use the same bound constructor expression in your application's `INSERT` or `UPDATE`. [node-mssql documents connection and parameter binding](https://github.com/tediousjs/node-mssql#documentation).

The local `result` is:

```json
{
  "type": "Point",
  "spatialType": "geography",
  "srid": 4326,
  "wkt": "POINT (-83 43)",
  "geometry": { "type": "Point", "coordinates": [-83, 43] },
  "diagnostics": [],
  "validation": {
    "structural": true,
    "sqlServerValidated": false,
    "topologyChecks": 0
  }
}
```

## Choosing an entry point

Individual features are the primary input. Collection adapters are optional.

| Export                              | Use it for                                                  | Returns                                 |
| ----------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| `fromGeoJSON(input, options)`       | A GeoJSON Geometry, Feature or FeatureCollection            | Spatial result, `null`, or result array |
| `fromEsri(input, options)`          | Esri geometry, feature or FeatureSet                        | Spatial result, `null`, or result array |
| `fromFeatureSet(input, options)`    | An Esri FeatureSet with shared metadata                     | Result array                            |
| `iterateGeoJSON(input, options)`    | A GeoJSON FeatureCollection processed one feature at a time | Generator of feature results            |
| `iterateFeatureSet(input, options)` | An Esri FeatureSet processed one feature at a time          | Generator of feature results            |
| `fromSpatial(input, options)`       | Explicit SQL spatial input, including curves and FullGlobe  | Spatial result                          |
| `toSqlSpatial(input, options)`      | Automatic adapter selection, or explicit `format`           | Spatial result, `null`, or result array |
| `sqlBinding(result, options)`       | One converted value ready for driver parameters             | `{ expression, parameters }`            |
| `SpatialError`                      | Catching conversion failures                                | Error class                             |
| `GEO_TYPES`, `SQL_TYPES`            | Discovering supported type names                            | Read-only arrays                        |

GeoJSON supports Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon and GeometryCollection, with XY or XYZ positions. Esri and explicit spatial input also support measures (XYM/XYZM); XYM WKT uses a positional `NULL` for Z.

## Results, diagnostics and errors

### Spatial results

`geometry` is the normalized geometry, and `wkt` is its SQL text representation. Input objects are not mutated. A null geometry returns `null`; an empty shape returns a spatial result with typed WKT such as `POINT EMPTY`.

`validation.structural` records completed local structural checks. `sqlServerValidated` is always `false`: the library does not contact a database. `topologyChecks` is charged topology work, not elapsed time. Validate the resulting value and intended interior in your SQL engine.

`sqlBinding(result)` returns:

```json
{
  "expression": "geography::STGeomFromText(@wkt, @srid)",
  "parameters": {
    "wkt": { "type": "NVarChar(MAX)", "value": "POINT (-83 43)" },
    "srid": { "type": "Int", "value": 4326 }
  }
}
```

### Diagnostic codes

Diagnostics are `{ code, path, detail }` entries on a successful spatial result. Ring paths identify the source ring, including original Esri ring indices after classification. Topology-generated rings use a `.repaired[...]` suffix when their provenance is available.

| Code                      | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `CLOSED_RING`             | Appended the first position to close a ring                           |
| `DEDUPLICATED`            | Removed consecutive identical positions                               |
| `REWOUND`                 | Reversed a shell or hole to the required winding                      |
| `CANONICAL_LONGITUDE`     | Represented longitude +180 as -180                                    |
| `TOPOLOGY_REPAIRED`       | Rebuilt polygon topology under the selected policy                    |
| `LINE_OVERLAP_REPAIRED`   | Isolated overlapping line traversals in a GeometryCollection          |
| `ESRI_RING_REPAIRED`      | Simplified an Esri ring before classifying its role                   |
| `EMPTY_POINT_OMITTED`     | Omitted an empty Esri MultiPoint member; path identifies that member  |
| `NAD83_ZERO_SHIFT`        | Used the caller-approved approximate NAD83/WGS84 datum alignment      |
| `SQL_VALIDATION_REQUIRED` | SQL engine verification is needed for curved or global interpretation |

### Error codes

`SpatialError` exposes `code`, `path` and `detail`. Wrappers retain the original thrown value as `cause`. Collection recovery fields are described below.

| Cause         | Code               | Meaning                                                                |
| ------------- | ------------------ | ---------------------------------------------------------------------- |
| Input         | `SHAPE`            | Expected an object or dense array of the required shape                |
| Input         | `TYPE`             | Unsupported type, conflicting type metadata or wrong collection member |
| Input         | `DIMENSION`        | Invalid/mixed dimensions or conflicting Z/M declarations               |
| Input         | `COORDINATE`       | A coordinate is not a finite number                                    |
| Input         | `LONGITUDE`        | Longitude is outside -180 to 180                                       |
| Input         | `LATITUDE`         | Latitude is outside -90 to 90                                          |
| Input         | `EMPTY_COMPONENT`  | An empty component occurs inside a nonempty polygon                    |
| Input         | `COLLAPSED`        | Too few distinct positions or zero/unstable area                       |
| Input         | `CLOSURE`          | Closure shares XY but disagrees in Z/M                                 |
| Input         | `UNCLOSED`         | An open ring requires a repair the caller disabled                     |
| Input         | `DUPLICATE`        | Consecutive duplicate positions require a disabled repair              |
| Input         | `ENVELOPE`         | Extent minima are not smaller than maxima                              |
| Input         | `ANTIPODAL`        | A geography edge has antipodal endpoints                               |
| Topology      | `TOPOLOGY`         | Invalid polygon topology or failed topology repair                     |
| Topology      | `WINDING`          | Incorrect ring winding, or invalid orientation option                  |
| Topology      | `LINE_OVERLAP`     | Overlapping line traversals require explicit repair                    |
| Topology      | `ESRI_RING`        | Esri shell/hole roles are ambiguous                                    |
| Topology      | `ESRI_GLOBAL`      | Polar/global Esri rings need explicit shell/hole roles                 |
| Topology      | `GLOBAL_REPAIR`    | Planar repair cannot infer a global or preserved interior              |
| Topology      | `REPAIR_DIMENSION` | Topology repair would discard Z/M                                      |
| Curves        | `CURVE`            | Malformed or unsupported curve structure                               |
| Curves        | `CURVE_CRS`        | Curved input requires reprojection that cannot preserve its arcs       |
| Curves        | `CURVE_GLOBAL`     | Curved geography lies outside supported local extents                  |
| Curves        | `CURVE_REPAIR`     | A straight repair changes a curve section/ring's type                  |
| Curves        | `CURVE_TOPOLOGY`   | Curved ring nesting, crossings or contacts are ambiguous               |
| Curves        | `CURVE_WINDING`    | Requested curved-ring orientation policy is unsupported                |
| Target/CRS    | `CRS`              | Missing, unsupported, conflicting or unapproved projection/datum       |
| Target/CRS    | `SRID`             | Invalid SRID or unsupported geography SRID                             |
| Target/CRS    | `TARGET`           | SQL target must be geography or geometry                               |
| Configuration | `OPTIONS`          | Invalid options object or option value                                 |
| Configuration | `REPAIR`           | Unknown repair policy                                                  |
| Configuration | `FORMAT`           | Unknown adapter format                                                 |
| Configuration | `BINDING`          | Invalid spatial result or SQL parameter names                          |
| Configuration | `LIMIT`            | Invalid limit or processing budget exceeded                            |
| Configuration | `IDENTITY`         | Ambiguous case-insensitive Esri identifier fields                      |
| Unexpected    | `INTERNAL`         | Unexpected collection failure; inspect the original `cause`            |

## Options

Pass conversion options as the second argument. Defaults apply when omitted. Limit options must be positive safe integers.

| Name                     | Type                                               | Default                              | Description                                                                       |
| ------------------------ | -------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `spatialType`            | `'geography' \| 'geometry'`                        | `'geography'`                        | SQL coordinate model                                                              |
| `srid`                   | Integer                                            | 4326 geography; 0 geometry           | SQL SRID label; native Esri geometry can infer a numeric WKID                     |
| `repair`                 | `'none' \| 'safe' \| 'topology'`                   | `'safe'`                             | Repair policy                                                                     |
| `orientation`            | `'normalize' \| 'preserve'`                        | `'normalize'`                        | Normalize winding or retain intentional interiors                                 |
| `sourceCrs`              | String                                             | WGS84 for GeoJSON; inferred for Esri | Explicit source definition or supported name                                      |
| `targetCrs`              | String                                             | WGS84 for geography                  | Destination; required for projected planar output without a custom converter      |
| `project`                | Boolean                                            | `true`                               | Set `false` for native planar coordinates                                         |
| `projectionDefinitions`  | Name → PROJ/WKT string or parsed-definition object | None                                 | Local definitions for unsupported codes                                           |
| `wkidAuthorities`        | Numeric WKID → `'EPSG' \| 'ESRI'`                  | Known aliases/authorities            | Choose the namespace; also supply a missing definition                            |
| `converter`              | `([x, y]) => [x, y]`                               | None                                 | Caller-supplied finite XY transformation; takes priority over built-in projection |
| `allowNad83ZeroShift`    | Boolean                                            | `false`                              | Opt in to the plain NAD83/WGS84 approximation                                     |
| `spatialReference`       | `{ wkid?, latestWkid?, wkt?, wkt2? }`              | Esri metadata                        | Shared or individual source reference                                             |
| `geometryType`           | Esri type-name string                              | Inferred                             | Esri wrapper/feature geometry type                                                |
| `hasZ`                   | Boolean                                            | Esri metadata/inferred               | Declare elevation coordinates                                                     |
| `hasM`                   | Boolean                                            | Esri metadata/inferred               | Declare measures                                                                  |
| `maxPositions`           | Integer                                            | 100,000                              | Position budget per feature                                                       |
| `maxDepth`               | Integer                                            | 32                                   | Geometry/coordinate nesting depth                                                 |
| `maxTopologyChecks`      | Integer                                            | 1,000,000                            | Topology work budget per feature                                                  |
| `maxComponents`          | Integer                                            | 10,000                               | Geometry objects, parts and rings per feature, including empty members            |
| `maxFeatures`            | Integer                                            | 100,000                              | Features per collection                                                           |
| `maxTotalPositions`      | Integer                                            | 1,000,000                            | Aggregate position budget per collection                                          |
| `maxTotalTopologyChecks` | Integer                                            | 10,000,000                           | Aggregate topology work budget per collection                                     |
| `maxTotalWktBytes`       | Integer                                            | 67,108,864                           | Aggregate generated ASCII WKT bytes (64 MiB)                                      |
| `onError`                | `'collect' \| 'throw'`                             | `'collect'`                          | Collection per-feature failure handling                                           |
| `format`                 | `'geojson' \| 'esri' \| 'spatial'`                 | Auto-detect                          | `toSqlSpatial` only: select adapter                                               |
| `wktParameter`           | SQL parameter-name string                          | `'wkt'`                              | `sqlBinding` only: WKT binding name                                               |
| `sridParameter`          | SQL parameter-name string                          | `'srid'`                             | `sqlBinding` only: SRID binding name; must differ from WKT name                   |

## Collections

| Approach                                           | Behavior                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| Eager: `fromGeoJSON`, `fromFeatureSet`, `fromEsri` | Returns all `{ id, spatial, error }` rows; retains converted output |
| Iterator: `iterateGeoJSON`, `iterateFeatureSet`    | Converts as consumed; caller owns yielded results                   |
| `onError: 'collect'`                               | Returns a failed row and continues to the next feature              |
| `onError: 'throw'`                                 | Stops at the first feature error                                    |

An eager terminal error exposes non-enumerable `partialResults`, including completed null geometries and previously collected errors. A throw-mode feature failure reports `processedFeatures` and an indexed path. Collection-wide budget failures are terminal in either mode and add `scope: 'collection'`. The unfinished feature is excluded from recovery data. Invalid configuration or collection structure can fail before processing.

```js
import { fromFeatureSet, SpatialError } from 'coordshelper';

const featureSet = {
  spatialReference: { wkid: 4326 },
  features: [
    { attributes: { OBJECTID: 1 }, geometry: { x: -83, y: 43 } },
    { attributes: { OBJECTID: 2 }, geometry: { x: 'bad', y: 43 } },
  ],
};

try {
  const rows = fromFeatureSet(featureSet, { onError: 'throw' });
  for (const row of rows) console.log(row.id, row.spatial?.wkt);
} catch (error) {
  if (!(error instanceof SpatialError)) throw error;
  for (const row of error.partialResults ?? []) {
    console.log('Completed:', row.id, row.spatial?.wkt);
  }
  console.error(error.code, error.path, error.processedFeatures);
}
```

For bulk processing, consume and discard rows as they arrive:

```js
import { iterateFeatureSet } from 'coordshelper';

const featureSet = {
  spatialReference: { wkid: 4326 },
  features: [
    { attributes: { OBJECTID: 1 }, geometry: { x: -83, y: 43 } },
    { attributes: { OBJECTID: 2 }, geometry: null },
  ],
};

for (const { id, spatial, error } of iterateFeatureSet(featureSet)) {
  if (error) console.error(id, error.code, error.path);
  else console.log(id, spatial?.wkt ?? 'No geometry');
}
```

Iterators use the same aggregate budgets as eager calls. They keep the source array in memory but do not retain previous converted results or a recovery array. Page large layers into bounded collections. Metadata discovery may inspect later features before yielding the first result. Conversion is synchronous; schedule bounded chunks or workers when responsiveness matters.

## Coordinate reference systems

GeoJSON uses WGS84 longitude/latitude by default, following [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946). A legacy `crs` declaration on a Geometry, Feature or FeatureCollection requires an explicit `sourceCrs`.

For Esri, the source is chosen in this order:

1. Caller `sourceCrs` override.
2. `spatialReference.wkt2`.
3. `spatialReference.wkt`.
4. `spatialReference.latestWkid`.
5. `spatialReference.wkid`.

Shared reference metadata is inherited as described under Esri specifics. Equivalent WKT1, WKT2 and known WKID declarations are accepted together; conflicting declarations raise `CRS`. PROJ/WKT definitions are local to the call and honor angular/linear units.

| Source                                | Support                                                              |
| ------------------------------------- | -------------------------------------------------------------------- |
| `EPSG:4326`, `WGS84`                  | Built-in WGS84 longitude/latitude                                    |
| `EPSG:4269`                           | Built-in plain NAD83; cross-datum projection requires approval below |
| `EPSG:3857`, `EPSG:3785`, `GOOGLE`    | Built-in spherical Web Mercator                                      |
| Esri 102100/102113 and alias 900913   | Resolve to Web Mercator 3857                                         |
| `EPSG:32601`–`32660`, `32701`–`32760` | Built-in WGS84 UTM north/south                                       |
| `EPSG:5041`, `EPSG:5042`              | Built-in WGS84 UPS north/south                                       |
| State plane, other EPSG/Esri codes    | Supply a definition, explicit source CRS or converter                |
| Esri 54030 Robinson                   | Known ESRI namespace; projection definition still required           |

### Recipe 1: Web Mercator to geography

```js
import { fromEsri } from 'coordshelper';

const result = fromEsri({
  x: 1113194.9079327357,
  y: 0,
  spatialReference: { wkid: 102100, latestWkid: 3857 },
});
console.log(result.wkt); // POINT (10 0)
```

### Recipe 2: US-foot state plane to geography

This Illinois East definition uses [EPSG conversion 15387](https://epsg.org/api/v1/Conversion/15387/export?format=gml). It explicitly accepts the plain NAD83 approximation.

```js
import { fromEsri } from 'coordshelper';

const illinoisEast =
  '+proj=tmerc +lat_0=36.6666666666667 +lon_0=-88.3333333333333 ' +
  '+k=0.999975 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft';

const result = fromEsri(
  { x: 984250, y: 0, spatialReference: { wkid: 3435 } },
  {
    projectionDefinitions: { 'EPSG:3435': illinoisEast },
    allowNad83ZeroShift: true,
  },
);
console.log(result.geometry.coordinates); // approximately [-88.3333333333333, 36.6666666666667]
console.log(result.diagnostics); // includes NAD83_ZERO_SHIFT
```

### Recipe 3: Keep native planar coordinates

```js
import { fromEsri } from 'coordshelper';

const result = fromEsri(
  { x: 984250, y: 0, spatialReference: { wkid: 3435 } },
  { spatialType: 'geometry', project: false, srid: 3435 },
);
console.log(result.wkt, result.srid); // POINT (984250 0) 3435
```

**NAD83:** Cross-datum projection using plain NAD83's zero-shift path is rejected by default. This applies to `EPSG:4269`, `+datum=NAD83` and plain-NAD83 projected WKT. `allowNad83ZeroShift: true` accepts the approximation and emits a diagnostic. Use a verified realization/epoch-specific converter or nonzero transformation when accuracy requires it. Native planar or same-NAD83-datum projection does not need that opt-in; unresolved NAD83(HARN)/NAD83(2011) WKT still needs a verified converter.

## Esri specifics

- FeatureSet metadata includes `geometryType`, `spatialReference`, `hasZ` and `hasM`. Supply these as options when passing one feature. Caller options take precedence over wrapper settings; incompatible feature/shared declarations fail.
- Without a shared or explicit source reference, the first usable non-null geometry with a reference supplies it, including after null or malformed leading members.
- Collection IDs use `globalIdFieldName` before `objectIdFieldName`, falling back to GlobalID/OBJECTID. Field matching ignores case; ambiguous casing raises `IDENTITY`. Individual conversion returns only spatial data.
- Missing/null feature geometry returns `null`. Empty arrays yield typed `EMPTY`; `{ x: null }` yields an empty Point and `{ xmin: null }` an empty Polygon. `"NaN"` is invalid. Empty MultiPoint members are omitted with `EMPTY_POINT_OMITTED` diagnostics.
- Circular `c` arcs are retained. Esri curved rings are classified as shells/holes and rewound; multiple shells produce GeometryCollection. Straight multipart paths/rings preserve their parts.
- `fromSpatial` additionally accepts CircularString (`coordinates`), CompoundCurve (`segments`), CurvePolygon (`rings`) and FullGlobe. FullGlobe is geography-only and cannot be nested in GeometryCollection.

See [Esri geometry objects](https://developers.arcgis.com/rest/services-reference/enterprise/geometry-objects/) for source structure.

## Repair policies

| Policy                     | Behavior                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `repair: 'none'`           | Reject required closure, duplicate removal or winding changes                                |
| `repair: 'safe'` (default) | Close rings, remove exact consecutive duplicates and normalize winding; diagnose each change |
| `repair: 'topology'`       | Enable local topology repair; may change geometry type, vertices or part count               |

Geography winding uses ellipsoidal area; shells are counterclockwise and holes clockwise. `orientation: 'preserve'` retains deliberate interiors for ordinary GeoJSON/explicit spatial input.

Polygon topology repair uses nonzero shell union minus holes. Esri classification supports disjoint shells, holes and islands; explicit repair can union consistently clockwise shells. Mixed-role crossing rings remain ambiguous. Line repair keeps directed traversal and Z/M in a GeometryCollection, splitting affected runs while retaining unaffected ones. Type-changing repairs inside CompoundCurve/CurvePolygon raise `CURVE_REPAIR`.

## Limits

| Budget                                  | Default    | Scope          |
| --------------------------------------- | ---------- | -------------- |
| Positions                               | 100,000    | Per feature    |
| Nesting depth                           | 32         | Per feature    |
| Topology checks                         | 1,000,000  | Per feature    |
| Components, including empty parts/rings | 10,000     | Per feature    |
| Features                                | 100,000    | Per collection |
| Total positions                         | 1,000,000  | Per collection |
| Total topology checks                   | 10,000,000 | Per collection |
| Generated WKT                           | 64 MiB     | Per collection |

Measure representative shapes before raising limits. Aggregate work includes failed features; WKT bytes count successfully generated results. A 50,000-feature layer averaging 30 positions requires 1.5 million positions, so page it or explicitly raise `maxTotalPositions`. Iterators reduce retained output but do not bypass budgets. Dense geometry may exhaust topology work even with relatively few vertices.

## Limitations and non-goals

- Conversion does not fetch GIS data, execute SQL, create records, normalize UUIDs, enforce unique IDs or schedule synchronization.
- Geography targets WGS84 **SRID 4326 only**. An SRID label alone is not reprojection. Unrecognized WKIDs need explicit configuration; numeric ranges do not determine their namespace.
- CRS comparison is conservative, not a universal equivalence solver. Axis declarations are compared, but input XY order is retained. Dynamic, bound, compound/vertical and unresolved datum transformations need an explicit verified converter. Z/M are retained without vertical transformation.
- Polygon topology checks use unwrapped planar edges; SQL geography uses curved-earth edges. Long edges can differ. There is no automatic densification or universal ellipsoidal repair. Verify SQL validity, interior, area and containment.
- Curved reprojection, elliptical/Bezier arcs and ambiguous curved crossings/contacts are unsupported. Esri curved geography classification is limited to non-polar extents up to 10° wide/high within ±80° latitude. Explicit spatial curved winding is preserved for SQL verification; Esri curved rings do not support `orientation: 'preserve'`.
- Planar topology repair is refused for global/polar shapes, preserved interiors and repairs that lose Z/M. Sparse arrays, mixed dimensions and inconsistent closure are rejected.
- WKT expands decimal numbers within a conservative literal budget and uses lossless scientific notation for longer expansions. It does not round coordinates to fit the SQL reader.
- `sqlBinding` handles one value. Driver choice, batching, SQL parameter limits and table-valued parameters belong to the application. Validate acceptance on your target SQL Server version.

## Migrating from v1

The 2.x API replaces the CommonJS 1.x interface; there is no compatibility wrapper. Upgrade an existing 1.x installation before using these named exports.

| v1 usage/behavior                                        | 2.x replacement                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `require('coordshelper')`                                | ESM named imports on Node ≥22                                              |
| `helper.geometry(geoJSONFeature, cs)`                    | `fromGeoJSON(feature, { sourceCrs: cs })`, then `sqlBinding(result)`       |
| `helper.geometry(esriFeature, cs)`                       | `fromEsri(feature, { sourceCrs: cs })`, then `sqlBinding(result)`          |
| Returned SQL string with embedded WKT and `.MakeValid()` | Structured spatial result plus bound WKT/SRID parameters; explicit repairs |
| `mapping` constructor table                              | `GEO_TYPES`/`SQL_TYPES` for types and `sqlBinding` for constructors        |
| `recurse` and `isAntiClockwise`                          | Conversion performs traversal and winding; inspect diagnostics             |
| `gridLocation`                                           | Removed; keep grid generation in the application                           |
| Plain NAD83 source projected automatically               | Opt in to approximate zero shift or provide a verified transformation      |
| No aggregate conversion budgets                          | Configure collection limits and page large inputs                          |
| Invalid input often returned `null`                      | Catch `SpatialError`; `null` now means absent geometry                     |

```js
import { fromEsri, sqlBinding } from 'coordshelper';

const feature = { geometry: { x: 1113194.9079327357, y: 0 } };
const spatial = fromEsri(feature, { sourceCrs: 'EPSG:3857' });
if (spatial) {
  const binding = sqlBinding(spatial);
  console.log(binding.expression, binding.parameters);
}
```

Review saved geometry when migrating: corrected ring roles, complete multipart output, dimensional preservation and explicit repairs can produce different results from 1.x. Shape metadata no longer needs a synthetic Esri `geometry.type` when the geometry or wrapper identifies the type.

## License and contributions

[MIT License](LICENSE). To propose a change or report a reproducible issue, use [the contribution/issue tracker](https://github.com/kdclaw3/coordshelper/issues). Include a small synthetic input, options and expected result.
