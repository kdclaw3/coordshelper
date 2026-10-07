import { writeFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../index.js';
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
        CASE WHEN @g.STIsValid()=1 THEN @g.STIntersects(${r.spatialType}::STGeomFromText(@inside,@srid)) END AS inside,
        CASE WHEN @g.STIsValid()=1 THEN @g.STIntersects(${r.spatialType}::STGeomFromText(@outside,@srid)) END AS outside,
        @g.AsTextZM() AS text;`)
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
        (row) => assert.ok(row.text.includes('0.00000001')),
      );
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
