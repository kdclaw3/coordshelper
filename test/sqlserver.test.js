import { writeFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
import {
  worldwideParts,
  worldwideHoles,
  polarCap,
  polarBowtie,
  datelineBowtie,
  containingParts,
  polarContainingParts,
} from './geography-atlas-fixtures.js';
import { projectedControls, optionsFor } from './projected-wkt-fixtures.js';
import {
  notch,
  curvedHole,
  curvedParts,
  greatEllipseOverlap,
  shortOverlap,
  geographyControls,
} from './geography-fixtures.js';
import {
  allTypes,
  repairs,
  globals,
  curve,
  compound,
  curvedPolygon,
  shell,
  hole,
  square,
  esriCircle,
} from './fixtures.js';
// Opt-in, SELECT-only integration tests. No table, schema, transaction or cleanup writes.
test(
  'SQL Server geography/geometry acceptance and intended shape',
  { skip: process.env.SPATIAL_SQL_TEST !== '1' },
  async (t) => {
    const { default: sql } = await import(process.env.SPATIAL_SQL_DRIVER ?? 'mssql');
    const e = process.env;
    for (const name of ['HOST', 'USER', 'PASSWORD', 'DATABASE'])
      assert.ok(e[`SPATIAL_TEST_DB_${name}`], `Missing SPATIAL_TEST_DB_${name}`);
    const pool = await new sql.ConnectionPool({
      server: e.SPATIAL_TEST_DB_HOST,
      port: Number(e.SPATIAL_TEST_DB_PORT ?? 1433),
      user: e.SPATIAL_TEST_DB_USER,
      password: e.SPATIAL_TEST_DB_PASSWORD,
      database: e.SPATIAL_TEST_DB_DATABASE,
      options: {
        encrypt: true,
        trustServerCertificate: e.SPATIAL_TEST_TRUST_CERTIFICATE === '1',
      },
      pool: { max: 1, min: 0 },
      requestTimeout: 30000,
    }).connect();
    const evidence = [];
    try {
      const engine = (
        await pool
          .request()
          .query(
            "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version,compatibility_level AS compatibility FROM sys.databases WHERE name=DB_NAME()",
          )
      ).recordset[0];
      t.diagnostic(
        `SQL Server ${engine.version}, compatibility ${engine.compatibility}`,
      );
      async function inspect(r, inside = [0, 0], outside = [20, 20]) {
        const b = h.sqlBinding(r);
        const request = pool
          .request()
          .input('wkt', sql.NVarChar(sql.MAX), b.parameters.wkt.value)
          .input('srid', sql.Int, b.parameters.srid.value)
          .input('inside', sql.NVarChar(sql.MAX), `POINT (${inside.join(' ')})`)
          .input('outside', sql.NVarChar(sql.MAX), `POINT (${outside.join(' ')})`);
        // Only the library's whitelist-selected SQL type is interpolated; all coordinates are parameters.
        return (
          await request.query(`DECLARE @g ${r.spatialType} = ${b.expression};
        SELECT @g.STIsValid() AS valid,@g.STGeometryType() AS type,@g.STSrid AS srid,
        CASE WHEN @g.STIsValid()=1 THEN @g.STNumGeometries() END AS parts,
        CASE WHEN @g.STIsValid()=1 THEN @g.STNumPoints() END AS points,
        CASE WHEN @g.STIsValid()=1 THEN @g.STArea() END AS area,
        CASE WHEN @g.STIsValid()=1 THEN @g.STLength() END AS length,
        CASE WHEN @g.STIsValid()=1 THEN @g.STIntersects(${r.spatialType}::STGeomFromText(@inside,@srid)) END AS inside,
        CASE WHEN @g.STIsValid()=1 THEN @g.STIntersects(${r.spatialType}::STGeomFromText(@outside,@srid)) END AS outside,
        @g.AsTextZM() AS text${
          r.type === 'Point'
            ? r.spatialType === 'geography'
              ? ', @g.Long AS x, @g.Lat AS y, @g.Z AS z, @g.M AS m'
              : ', @g.STX AS x, @g.STY AS y, @g.Z AS z, @g.M AS m'
            : ''
        };`)
        ).recordset[0];
      }
      async function check(name, r, extra = () => {}) {
        await t.test(name, async () => {
          const row = await inspect(r);
          evidence.push({ name, ...row });
          assert.equal(
            row.valid,
            true,
            `${name} must be valid WITHOUT MakeValid: ${row.text}`,
          );
          assert.equal(row.type, r.type);
          assert.equal(row.srid, r.srid);
          await extra(row);
        });
      }
      for (const [name, input] of [
        ['worldwide independent parts', worldwideParts],
        ['worldwide shells and holes', worldwideHoles],
        ['chart-supported polar cap', polarCap],
        ['polar self-crossing repair', polarBowtie],
        ['antimeridian canonical repair', datelineBowtie],
      ])
        await check(
          `geography atlas: ${name}`,
          h.fromGeoJSON(input, { repair: 'topology' }),
        );
      await check(
        'geography atlas: Esri worldwide shells and holes',
        h.fromEsri({
          rings: worldwideHoles.coordinates.flatMap(([s, hole]) => [
            hole,
            s.toReversed(),
          ]),
        }),
      );
      await check(
        'geography atlas: sub-metre overlap repair',
        h.fromGeoJSON(
          {
            type: 'MultiPolygon',
            coordinates: [
              [square(-83, 43, 0.000001)],
              [square(-82.9999995, 43.0000005, 0.000001)],
            ],
          },
          { repair: 'topology' },
        ),
      );
      await check(
        'geography atlas: worldwide Esri islands within holes',
        h.fromEsri({
          rings: worldwideHoles.coordinates
            .flatMap(([s, hole]) => {
              const [x, y] = s[0];
              return [square(x + 0.6, y + 0.6, 0.1).toReversed(), hole, s.toReversed()];
            })
            .toReversed(),
        }),
        (row) => assert.equal(row.parts, 8),
      );
      for (const [name, input] of [
        ['contained parts', containingParts],
        ['polar contained parts', polarContainingParts],
      ]) {
        await check(
          `geography atlas union: ${name}`,
          h.fromGeoJSON(input, { repair: 'topology' }),
        );
      }
      await t.test(
        'geography atlas: distant interiors and holes are not complements',
        async () => {
          const polar = await inspect(
            h.fromGeoJSON(polarCap, { repair: 'topology' }),
            [0, 89],
            [0, 0],
          );
          assert.equal(polar.inside, true);
          assert.equal(polar.outside, false);
          assert.ok(polar.area > 0 && polar.area < 1e13);
          evidence.push({ name: 'atlas polar interior probe', ...polar });
          for (const input of [worldwideParts, worldwideHoles]) {
            const result = h.fromGeoJSON(input);
            for (const [shell] of input.coordinates) {
              const [x, y] = shell[0];
              const row = await inspect(result, [x + 0.2, y + 0.2], [0, 0]);
              assert.equal(row.valid, true);
              assert.equal(row.inside, true);
              assert.equal(row.outside, false);
              assert.equal(row.parts, 4);
              assert.ok(row.area > 0 && row.area < 1e12);
              evidence.push({ name: 'atlas interior probe', ...row });
            }
          }
          const result = h.fromGeoJSON(worldwideHoles);
          for (const [shell] of worldwideHoles.coordinates) {
            const [x, y] = shell[0];
            assert.equal((await inspect(result, [x + 0.75, y + 0.75])).inside, false);
          }
        },
      );
      for (const [name, input, errorCode] of [
        ['near-touching notch', notch(), 'TOPOLOGY'],
        ['curved shell crossing a hole', curvedHole, 'TOPOLOGY'],
        ['curved multipart overlap', curvedParts, 'TOPOLOGY'],
        ['great elliptic line overlap', greatEllipseOverlap, 'LINE_OVERLAP'],
        ['short duplicate line overlap', shortOverlap, 'LINE_OVERLAP'],
      ]) {
        await t.test(`round-earth regression: ${name}`, async () => {
          // Duplicate lines are invalid in both models, so serialize this trusted
          // synthetic fixture directly to demonstrate the unguarded SQL failure.
          const rawWkt =
            input.type === 'MultiLineString'
              ? `MULTILINESTRING (${input.coordinates.map((r) => `(${r.map((p) => p.join(' ')).join(',')})`).join(',')})`
              : h.fromGeoJSON(input, { spatialType: 'geometry' }).wkt;
          const row = (
            await pool.request().input('wkt', sql.NVarChar(sql.MAX), rawWkt)
              .query(`DECLARE @g geography=geography::STGeomFromText(@wkt,4326);
              SELECT @g.STIsValid() AS valid,@g.IsValidDetailed() AS detail;`)
          ).recordset[0];
          evidence.push({ name: `invalid original: ${name}`, ...row });
          assert.equal(row.valid, false);
          assert.throws(
            () => h.fromGeoJSON(input),
            (e) => e.code === errorCode,
          );
        });
        await check(
          `explicit round-earth repair: ${name}`,
          h.fromGeoJSON(input, { repair: 'topology' }),
        );
      }
      for (const longitude of [0, -83, 179.999]) {
        await check(
          `valid notch clearance at longitude ${longitude}`,
          h.fromGeoJSON(notch(0.000001, 45, longitude)),
        );
      }
      for (const [name, geometry, code] of [
        [
          'preserved hole has the shell winding',
          {
            type: 'Polygon',
            coordinates: [square(0, 0, 4), square(1, 1)],
          },
          'WINDING',
        ],
        [
          'preserved complement overlaps another part',
          {
            type: 'MultiPolygon',
            coordinates: [[square(0, 0, 4).toReversed()], [square(10, 0, 4)]],
          },
          'GEOGRAPHY_UNCERTAIN',
        ],
      ])
        await t.test(`geography validity: ${name}`, async () => {
          const raw = h.fromGeoJSON(geometry, {
            spatialType: 'geometry',
            orientation: 'preserve',
          });
          const row = (
            await pool.request().input('wkt', sql.NVarChar(sql.MAX), raw.wkt)
              .query(`DECLARE @g geography=geography::STGeomFromText(@wkt,4326);
            SELECT @g.STIsValid() AS valid,@g.IsValidDetailed() AS detail;`)
          ).recordset[0];
          assert.equal(row.valid, false);
          assert.throws(
            () => h.fromGeoJSON(geometry, { orientation: 'preserve' }),
            (e) => e.code === code,
          );
          evidence.push({ name: `invalid original: ${name}`, ...row });
        });
      await check(
        'two shell contacts remain valid SQL geography',
        h.fromGeoJSON({
          type: 'Polygon',
          coordinates: [
            square(0, 0, 4),
            [
              [0, 2],
              [2, 1],
              [4, 2],
              [2, 3],
              [0, 2],
            ],
          ],
        }),
      );
      await check(
        'single touching hole keeps a connected geography interior',
        h.fromGeoJSON({
          type: 'Polygon',
          coordinates: [
            square(0, 0, 4),
            [
              [0, 2],
              [1, 1],
              [2, 2],
              [1, 3],
              [0, 2],
            ],
          ],
        }),
      );
      const accepted = [];
      for (const { name, geometry } of geographyControls())
        for (const repair of ['safe', 'topology']) {
          try {
            accepted.push({
              name: `${name}/${repair}`,
              spatial: h.fromGeoJSON(geometry, { repair }),
            });
          } catch (error) {
            assert.ok(error instanceof h.SpatialError);
            assert.equal(repair, 'safe', `${name}: explicit repair must succeed`);
            assert.ok(['TOPOLOGY', 'LINE_OVERLAP'].includes(error.code));
            evidence.push({ name: `${name}/${repair}`, locallyRejected: error.code });
          }
        }
      // Synthetic VALUES batches reduce integration-test latency only. The package
      // still returns individual bindings and has no database execution dependency.
      for (let start = 0; start < accepted.length; start += 40)
        await t.test(`round-earth differential controls ${start}`, async () => {
          const batch = accepted.slice(start, start + 40);
          const request = pool.request();
          batch.forEach(({ spatial }, i) =>
            request.input(`w${i}`, sql.NVarChar(sql.MAX), spatial.wkt),
          );
          const rows = (
            await request.query(`SELECT p.id,g.s.STIsValid() AS valid,
            g.s.IsValidDetailed() AS detail FROM (VALUES ${batch.map((_, i) => `(${i},@w${i})`).join(',')}) p(id,wkt)
            CROSS APPLY (SELECT geography::STGeomFromText(p.wkt,4326) AS s) g;`)
          ).recordset;
          for (const row of rows) {
            const { name } = batch[row.id];
            evidence.push({ name, valid: row.valid, detail: row.detail });
            assert.equal(row.valid, true, `${name}: ${row.detail}`);
          }
        });
      await t.test(
        'repaired geography supports application spatial reads without MakeValid',
        async () => {
          for (const input of [notch(), curvedHole, curvedParts, greatEllipseOverlap]) {
            const result = h.fromGeoJSON(input, { repair: 'topology' });
            const row = (
              await pool.request().input('wkt', sql.NVarChar(sql.MAX), result.wkt)
                .query(`DECLARE @g geography=geography::STGeomFromText(@wkt,4326);
              DECLARE @view geography=geography::STGeomFromText('POLYGON ((100 0,101 0,101 1,100 1,100 0))',4326);
              SELECT @view.STIntersects(@g) AS intersects,@g.STDistance(geography::Point(0,100,4326)) AS distance,
                @g.STArea() AS area,@g.STLength() AS length,
                @g.STIntersection(@view).STIsValid() AS intersectionValid,
                @g.STBuffer(1).STIsValid() AS bufferValid,@g.Reduce(0.001).STIsValid() AS reduceValid;`)
            ).recordset[0];
            assert.equal(row.intersects, false);
            assert.ok(Number.isFinite(row.distance) && row.distance > 0);
            assert.equal(row.intersectionValid, true);
            assert.equal(row.bufferValid, true);
            assert.equal(row.reduceValid, true);
            evidence.push({
              name: `spatial reads after repair: ${input.type}`,
              ...row,
            });
          }
        },
      );
      for (const fixture of projectedControls) {
        await check(
          `Esri WKT1 ${fixture.name} preserves its known SQL control point`,
          h.fromEsri(
            {
              x: fixture.xy[0],
              y: fixture.xy[1],
              spatialReference: {
                wkt: fixture.wkt,
                wkt2: fixture.wkt2,
                wkid: fixture.wkid,
              },
            },
            optionsFor(fixture),
          ),
          (row) => {
            assert.ok(Math.abs(row.x - fixture.lonlat[0]) < 1e-9);
            assert.ok(Math.abs(row.y - fixture.lonlat[1]) < 1e-9);
          },
        );
      }
      await check(
        'WKT2-only source produces WGS84 geography',
        h.fromEsri({
          x: 10,
          y: 20,
          spatialReference: {
            wkt2: 'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]],CS[ellipsoidal,2],AXIS["longitude",east],AXIS["latitude",north],ANGLEUNIT["degree",0.0174532925199433]]',
          },
        }),
        (row) => {
          assert.ok(Math.abs(row.x - 10) < 1e-12);
          assert.ok(Math.abs(row.y - 20) < 1e-12);
        },
      );
      const approximate = h.fromGeoJSON(
        { type: 'Point', coordinates: [-83, 43] },
        { sourceCrs: 'EPSG:4269', allowNad83ZeroShift: true },
      );
      assert.ok(approximate.diagnostics.some((d) => d.code === 'NAD83_ZERO_SHIFT'));
      await check(
        'explicit NAD83 approximation remains SQL-representable',
        approximate,
        (row) => {
          assert.ok(Math.abs(row.x + 83) < 1e-10);
          assert.ok(Math.abs(row.y - 43) < 1e-10);
        },
      );
      for (const coordinate of [6.123233995736766e-17, 1e-100, Number.MIN_VALUE, 1e100])
        await check(
          `extreme numeric literal ${coordinate}`,
          h.fromGeoJSON(
            { type: 'Point', coordinates: [coordinate, 0] },
            { spatialType: 'geometry' },
          ),
          (row) => assert.equal(row.x, coordinate),
        );
      await t.test(
        'large touching hole preserves the intended planar interior',
        async () => {
          const ring = (count, radius, cx = 0) => {
            const points = Array.from({ length: count }, (_, i) => [
              cx + radius * Math.cos((i * 2 * Math.PI) / count),
              radius * Math.sin((i * 2 * Math.PI) / count),
            ]);
            return [...points, points[0]];
          };
          const value = h.fromGeoJSON(
            { type: 'Polygon', coordinates: [ring(2000, 2), ring(500, 0.5, 1.5)] },
            { spatialType: 'geometry' },
          );
          const row = await inspect(value, [0, 0], [1.5, 0]);
          assert.equal(row.valid, true);
          assert.equal(row.inside, true);
          assert.equal(row.outside, false);
          assert.ok(Math.abs(row.area - 3.75 * Math.PI) < 0.001);
          evidence.push({ name: 'large touching hole planar interior', ...row });
        },
      );
      await check(
        'optional absent Esri measure',
        h.fromEsri({
          hasM: true,
          hasZ: false,
          paths: [
            [
              [0, 0],
              [1, 1, 5],
            ],
          ],
        }),
      );
      for (const g of allTypes)
        await check(`all GeoJSON types: ${g.type}`, h.fromGeoJSON(g), (r) => {
          if (g.type.startsWith('Multi') || g.type === 'GeometryCollection')
            assert.equal(r.parts, 2);
        });
      for (const type of h.GEO_TYPES)
        await check(
          `empty ${type}`,
          h.fromGeoJSON(
            type === 'GeometryCollection'
              ? { type, geometries: [] }
              : { type, coordinates: [] },
          ),
          (r) => assert.equal(r.parts, 0),
        );
      await t.test(
        'clockwise Esri curved shell has its intended small interior',
        async () => {
          const row = await inspect(
            h.fromEsri({ curveRings: [esriCircle()] }),
            [0, 0],
            [3, 0],
          );
          assert.equal(row.valid, true);
          assert.equal(row.inside, true);
          assert.equal(row.outside, false);
          assert.ok(row.area > 1e9 && row.area < 1e11);
          evidence.push({ name: 'Esri curved shell interior', ...row });
        },
      );
      await t.test(
        'shuffled Esri curved hole and separate shell retain correct interiors',
        async () => {
          const value = h.fromEsri({
            curveRings: [esriCircle(0, 0, 0.2), esriCircle(4, 0, 0.5), esriCircle()],
          });
          assert.equal(value.type, 'GeometryCollection');
          const row = await inspect(value, [0.5, 0], [0, 0]);
          assert.equal(row.valid, true);
          assert.equal(row.parts, 2);
          assert.equal(row.inside, true);
          assert.equal(row.outside, false);
          const separate = await inspect(value, [4, 0], [2, 0]);
          assert.equal(separate.inside, true);
          assert.equal(separate.outside, false);
          evidence.push({ name: 'Esri curved hole and disjoint shells', ...row });
        },
      );
      await check(
        'tiny decimal coordinates',
        h.fromGeoJSON({ type: 'Point', coordinates: [1e-8, -1e-9] }),
        (row) => {
          // SQL Server can serialize tiny values with exponents; verify the stored position.
          assert.ok(Math.abs(row.x - 1e-8) < 1e-22);
          assert.ok(Math.abs(row.y + 1e-9) < 1e-23);
        },
      );
      for (const spatialType of ['geography', 'geometry']) {
        for (const geometry of [
          { type: 'Point', coordinates: [0, 0, null, null] },
          {
            type: 'LineString',
            coordinates: [
              [0, 0, null, null],
              [1, 1, null, null],
            ],
          },
          {
            type: 'CircularString',
            coordinates: [
              [0, 0, null, null],
              [1, 1, null, null],
              [2, 0, null, null],
            ],
          },
        ])
          await check(
            `nullable ZM ${spatialType} ${geometry.type}`,
            h.fromSpatial(geometry, { spatialType }),
            (row) => {
              if (geometry.type === 'Point') {
                assert.equal(row.x, 0);
                assert.equal(row.y, 0);
                assert.equal(row.z, null);
                assert.equal(row.m, null);
              }
            },
          );
        if (spatialType === 'geometry')
          for (const type of h.SQL_TYPES.filter((type) => type !== 'FullGlobe')) {
            const geometry =
              type === 'GeometryCollection'
                ? { type, geometries: [] }
                : type === 'CurvePolygon'
                  ? { type, rings: [] }
                  : type === 'CompoundCurve'
                    ? { type, segments: [] }
                    : { type, coordinates: [] };
            await check(
              `SQL planar empty ${type}`,
              h.fromSpatial(geometry, { spatialType }),
              (row) => assert.equal(row.parts, 0),
            );
          }
        await t.test(
          `line repair ${spatialType} retains traversal and ZM`,
          async () => {
            const input = [
              [0, 0, 3, 4],
              [1, 0, 5, 6],
              [2, 0, 7, 8],
              [1, 0, 9, 10],
              [1, 1, 11, 12],
            ];
            const value = h.fromSpatial(
              { type: 'LineString', coordinates: input },
              { spatialType, repair: 'topology' },
            );
            assert.equal(value.type, 'GeometryCollection');
            const row = await inspect(value);
            assert.equal(row.valid, true);
            assert.equal(row.type, 'GeometryCollection');
            assert.equal(row.parts, value.geometry.geometries.length);
            let expectedLength = 0;
            const components = value.geometry.geometries;
            for (let i = 0; i < components.length; i++) {
              const part = h.fromSpatial(components[i], { spatialType });
              const observed = await inspect(part);
              assert.equal(observed.valid, true);
              assert.equal(observed.points, components[i].coordinates.length);
              assert.equal(components[i].coordinates[0].length, 4);
              // SQL's own serialization must retain the component's original directed positions.
              const expectedText = components[i].coordinates
                .map((p) => p.join(' '))
                .join(', ');
              assert.equal(observed.text, `LINESTRING (${expectedText})`);
              expectedLength += observed.length;
            }
            assert.ok(
              Math.abs(row.length - expectedLength) <=
                Math.max(1e-8, expectedLength * 1e-12),
            );
            assert.deepEqual(
              components.flatMap((g, i) =>
                i ? g.coordinates.slice(1) : g.coordinates,
              ),
              input,
            );
            evidence.push({ name: `line repair ${spatialType}`, ...row });
          },
        );
        await check(
          `tiny and large decimal planar controls ${spatialType}`,
          h.fromSpatial(
            {
              type: 'Point',
              coordinates:
                spatialType === 'geometry' ? [1e21, -1e-20] : [1e-20, -1e-20],
            },
            { spatialType },
          ),
          (row) => {
            assert.equal(row.x, spatialType === 'geometry' ? 1e21 : 1e-20);
            assert.equal(row.y, -1e-20);
          },
        );
      }
      for (const [name, g] of Object.entries(repairs))
        await check(`local repair: ${name}`, h.fromGeoJSON(g, { repair: 'topology' }));
      await t.test('holes retain intended interior', async () => {
        const r = h.fromGeoJSON({
          type: 'Polygon',
          coordinates: [shell, hole],
        });
        const row = await inspect(r, [0.5, 0.5], [2, 2]);
        assert.equal(row.valid, true);
        assert.equal(row.inside, true);
        assert.equal(row.outside, false);
        const control = await inspect(
          h.fromGeoJSON({ type: 'Polygon', coordinates: [shell] }),
        );
        assert.ok(row.area < control.area);
        evidence.push({ name: 'hole-containment', ...row });
      });
      for (const fixture of globals)
        await t.test(`global ${fixture.name} interior`, async () => {
          const row = await inspect(
            h.fromGeoJSON(fixture.geometry),
            fixture.inside,
            fixture.outside,
          );
          assert.equal(row.valid, true);
          assert.equal(row.inside, true);
          assert.equal(row.outside, false);
          evidence.push({ name: fixture.name, ...row });
        });
      for (const g of [curve, compound, curvedPolygon, { type: 'FullGlobe' }])
        await check(`SQL geography ${g.type}`, h.fromSpatial(g));
      for (const g of [
        { type: 'CircularString', coordinates: [] },
        { type: 'CompoundCurve', segments: [] },
        { type: 'CurvePolygon', rings: [] },
      ])
        await check(`SQL empty ${g.type}`, h.fromSpatial(g));
      await check(
        '3D GeoJSON retains Z',
        h.fromGeoJSON({ type: 'Point', coordinates: [0, 0, 12.25] }),
        (r) => assert.equal(r.text, 'POINT (0 0 12.25)'),
      );
      await check('Esri M without Z', h.fromEsri({ x: 0, y: 0, m: 7 }), (r) =>
        assert.equal(r.text, 'POINT (0 0 NULL 7)'),
      );
      await check('Esri ZM', h.fromEsri({ x: 0, y: 0, z: 3, m: 7 }), (r) =>
        assert.equal(r.text, 'POINT (0 0 3 7)'),
      );
      await check(
        'Esri multipart paths',
        h.fromEsri({
          paths: [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [2, 2],
              [3, 3],
            ],
          ],
        }),
        (r) => assert.equal(r.parts, 2),
      );
      await check(
        'Esri disjoint shells',
        h.fromEsri({ rings: [square(), square(5, 5)] }),
        (r) => assert.equal(r.parts, 2),
      );
      await check(
        'Esri circular path',
        h.fromEsri({
          curvePaths: [
            [
              [0, 0],
              {
                c: [
                  [2, 0],
                  [1, 1],
                ],
              },
              [3, 0],
            ],
          ],
        }),
      );
      await check(
        'Esri circular polygon',
        h.fromEsri({
          curveRings: [
            [
              [2, 1],
              {
                c: [
                  [0, 1],
                  [1, 2],
                ],
              },
              {
                c: [
                  [2, 1],
                  [1, 0],
                ],
              },
            ],
          ],
        }),
      );
      await check(
        'Esri single shell bow-tie repair',
        h.fromEsri(
          {
            rings: [
              [
                [0, 0],
                [2, 2],
                [0, 2],
                [2, 0],
                [0, 0],
              ],
            ],
          },
          { repair: 'topology' },
        ),
        (r) => assert.equal(r.parts, 2),
      );
      await check(
        'Esri measured circular path',
        h.fromEsri({
          hasM: true,
          hasZ: false,
          curvePaths: [
            [
              [0, 0, 4],
              {
                c: [
                  [2, 0, 6],
                  [1, 1, 5],
                ],
              },
            ],
          ],
        }),
        (r) => assert.ok(r.text.includes('NULL 4')),
      );
      await check(
        'nested and empty collection components',
        h.fromGeoJSON({
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [] },
            {
              type: 'GeometryCollection',
              geometries: [{ type: 'Point', coordinates: [0, 0] }],
            },
          ],
        }),
      );
      await check(
        'empty component inside multiline',
        h.fromGeoJSON({
          type: 'MultiLineString',
          coordinates: [
            [],
            [
              [0, 0],
              [1, 1],
            ],
          ],
        }),
      );
      await check(
        '3D polygon',
        h.fromGeoJSON({
          type: 'Polygon',
          coordinates: [square().map((p) => [...p, 12])],
        }),
      );
      for (const x of [-83, 0, 120])
        for (const y of [-60, 0, 43])
          await t.test(`translated hole containment ${x}/${y}`, async () => {
            const outer = square(x, y, 0.5),
              inner = square(x + 0.1, y + 0.1, 0.2);
            const row = await inspect(
              h.fromGeoJSON({ type: 'Polygon', coordinates: [outer, inner] }),
              [x + 0.05, y + 0.05],
              [x + 0.2, y + 0.2],
            );
            assert.equal(row.valid, true);
            assert.equal(row.inside, true);
            assert.equal(row.outside, false);
            evidence.push({ name: `translated ${x}/${y}`, ...row });
          });
      for (const g of allTypes)
        await check(
          `planar geometry ${g.type}`,
          h.fromGeoJSON(g, { spatialType: 'geometry', srid: 0 }),
        );
      await t.test('preserved complement is larger than a hemisphere', async () => {
        const clockwise = {
          type: 'Polygon',
          coordinates: [[...square()].reverse()],
        };
        const row = await inspect(
          h.fromGeoJSON(clockwise, { orientation: 'preserve' }),
          [20, 20],
          [0.5, 0.5],
        );
        assert.equal(row.valid, true);
        assert.ok(row.area > 2.5e14);
        assert.equal(row.inside, true);
        assert.equal(row.outside, false);
        evidence.push({ name: 'large-interior', ...row });
      });
      if (e.SPATIAL_TEST_REPORT)
        writeFileSync(
          e.SPATIAL_TEST_REPORT,
          JSON.stringify({ engine, evidence }, null, 2),
        );
    } finally {
      await pool.close();
    }
  },
);
