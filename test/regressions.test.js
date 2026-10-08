import test from 'node:test';
import assert from 'node:assert/strict';
import * as helper from '../index.js';
const feature = (type, coordinates) => ({
  type: 'Feature',
  properties: {},
  geometry: { type, coordinates },
});
const shell = [
  [-83, 43],
  [-82, 43],
  [-82, 44],
  [-83, 44],
  [-83, 43],
];
const hole = [
  [-82.8, 43.2],
  [-82.8, 43.8],
  [-82.2, 43.8],
  [-82.2, 43.2],
  [-82.8, 43.2],
];
// Original defect assertions ran against v1 BEFORE implementation (baseline retained in memory).
// They now exercise corrected behavior through the version 2 API; no legacy wrapper is needed.
test('DEFECT-01: retain every Esri polyline path', () => {
  const sql = helper.fromEsri({
    paths: [
      [
        [-83, 43],
        [-82, 44],
      ],
      [
        [-81, 43],
        [-80, 44],
      ],
    ],
  }).wkt;
  assert.match(sql, /MULTILINESTRING/);
  assert.ok(sql.includes('-81 43'));
});
test('DEFECT-02: retain clockwise hole independently of shell winding', () => {
  const sql = helper.fromGeoJSON(feature('Polygon', [shell, hole])).wkt;
  assert.ok(sql.includes('-82.8 43.2,-82.8 43.8,-82.2 43.8,-82.2 43.2'));
});
test('DEFECT-03: accept an Esri point on longitude zero', () => {
  assert.match(helper.fromEsri({ x: 0, y: 43 }).wkt, /POINT\s*\(0 43\)/);
});
test('DEFECT-04: preserve closed line direction', () => {
  const line = [...shell].reverse();
  assert.ok(
    helper.fromGeoJSON(feature('LineString', line)).wkt.includes('-83 43,-83 44'),
  );
});
test('DEFECT-05: reject nonfinite coordinates before serialization', () => {
  assert.throws(() => helper.fromGeoJSON(feature('Point', [NaN, 43])), /finite/i);
  assert.throws(() => helper.fromGeoJSON(feature('Point', [Infinity, 43])), /finite/i);
});
test('DEFECT-06: reject latitude outside geography bounds', () => {
  assert.throws(() => helper.fromGeoJSON(feature('Point', [-83, 95])), /latitude/i);
});
test('DEFECT-07: preserve altitude without sentinel strings', () => {
  assert.match(
    helper.fromGeoJSON(feature('Point', [-83, 43, 2])).wkt,
    /POINT\s*\(-83 43 2\)/,
  );
});
test('DEFECT-08: convert a real GeometryCollection', () => {
  assert.match(
    helper.fromGeoJSON({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [0, 0] }],
    }).wkt,
    /GEOMETRYCOLLECTION\s*\(POINT\s*\(0 0\)\)/,
  );
});
test('DEFECT-09: honor embedded Esri spatialReference', () => {
  const x = helper.fromEsri({
    x: 1113194.9079327357,
    y: 0,
    spatialReference: { wkid: 3857 },
  }).geometry.coordinates[0];
  assert.ok(Math.abs(x - 10) < 1e-8);
});
test('DEFECT-10: valid shapes do not request SQL MakeValid', () => {
  const spatial = helper.fromGeoJSON(feature('Point', [0, 0]));
  assert.doesNotMatch(helper.sqlBinding(spatial).expression, /MakeValid/i);
});
test('DEFECT-11: conversion never mutates caller coordinate arrays', () => {
  const input = [shell.map((p) => [...p])];
  const before = structuredClone(input);
  helper.fromGeoJSON({ type: 'Polygon', coordinates: input });
  assert.deepEqual(input, before);
});
test('Feature conversion preserves input', () => {
  const input = feature('Polygon', [shell, hole]);
  const before = structuredClone(input);
  helper.fromGeoJSON(input);
  assert.deepEqual(input, before);
});
