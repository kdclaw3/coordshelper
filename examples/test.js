const geometry = require('../index.js');
let geoJSON = JSON.parse(JSON.stringify(require('./geoJSON').features));
let geoJSON2 = JSON.parse(JSON.stringify(require('./geoJSON').features));
let arcgisPoly = require('./arcgisPoly.json');
let arcgisLine = require('./arcgisLine.json');
let arcgisPoint = require('./arcgisPoint.json');


// simple translation no sql
for (let i = 0, l = geoJSON.length; i < l; i++) {
  const feature = geoJSON[i];
  let cs = '+proj=lcc +lat_1=40.96666666666667 +lat_2=39.93333333333333 +lat_0=39.33333333333334 +lon_0=-77.75 +x_0=600000 +y_0=0 +ellps=GRS80 +datum=NAD83 +to_meter=0.3048006096012192 +no_defs ';
  if (((feature || {}).geometry || {}).coordinates) {
    let d = geometry.recurse(feature.geometry.coordinates, cs);
    console.log(JSON.stringify(d) + '\n');
  }
}

// geojson
for (let i = 0, l = geoJSON2.length; i < l; i++) {
  const feature = geoJSON2[i];
  let cs = '+proj=lcc +lat_1=40.96666666666667 +lat_2=39.93333333333333 +lat_0=39.33333333333334 +lon_0=-77.75 +x_0=600000 +y_0=0 +ellps=GRS80 +datum=NAD83 +to_meter=0.3048006096012192 +no_defs ';
  let d = geometry.geometry(feature, cs);
  console.log('select', d + '\nunion all');
}

// arcgis poly
for (let i = 0, l = arcgisPoly.features.length; i < l; i++) {
  const feature = arcgisPoly.features[i];
  feature.geometry.type = arcgisPoly.geometryType;
  let cs = 'EPSG:3857';
  let d = geometry.geometry(feature, cs);
  console.log('select', d + '\nunion all');
}

// arcgis line
for (let i = 0, l = arcgisLine.features.length; i < l; i++) {
  const feature = arcgisLine.features[i];
  feature.geometry.type = arcgisLine.geometryType;
  let cs = 'EPSG:3857';
  let d = geometry.geometry(feature, cs);
  console.log('select', d + '\nunion all');
}

// arcgis point
for (let i = 0, l = arcgisPoint.features.length; i < l; i++) {
  const feature = arcgisPoint.features[i];
  feature.geometry.type = arcgisPoint.geometryType;
  let cs = 'EPSG:3857';
  let d = geometry.geometry(feature, cs);
  console.log('select', d + '\nunion all');
}
