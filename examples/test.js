const geometry = require('../index.js');


// geojson
let geoJSON = require('./geoJSON').features;
for (let i = 0, l = geoJSON.length; i < 1; i++) {
  const feature = geoJSON[i];
  // if (feature && feature.geometry && feature.geometry.coordinates) {
  let cs = '+proj=lcc +lat_1=40.96666666666667 +lat_2=39.93333333333333 +lat_0=39.33333333333334 +lon_0=-77.75 +x_0=600000 +y_0=0 +ellps=GRS80 +datum=NAD83 +to_meter=0.3048006096012192 +no_defs ';
  let d = geometry.geometry(feature, cs);
  console.log('select', d + '\nunion all');
  // }
}

/*
// arcgis poly
let arcgisPoly = require('./arcgisPoly.json');
for (let i = 0, l = arcgisPoly.features.length; i < l; i++) {
  const feature = arcgisPoly.features[i];
  feature.geometry.type = arcgisPoly.geometryType;
  if (feature && feature.geometry) {
    let cs = 'EPSG:3857';
    let d = geometry.geometry(feature, cs);
    console.log('select', d + '\nunion all');
  }
}

// arcgis line
let arcgisLine = require('./arcgisLine.json');
for (let i = 0, l = arcgisLine.features.length; i < l; i++) {
  const feature = arcgisLine.features[i];
  feature.geometry.type = arcgisLine.geometryType;
  if (feature && feature.geometry) {
    let cs = 'EPSG:3857';
    let d = geometry.geometry(feature, cs);
    console.log('select', d + '\nunion all');
  }
}

// arcgis point
let arcgisPoint = require('./arcgisPoint.json');
for (let i = 0, l = arcgisPoint.features.length; i < l; i++) {
  const feature = arcgisPoint.features[i];
  feature.geometry.type = arcgisPoint.geometryType;
  if (feature && feature.geometry) {
    let cs = 'EPSG:3857';
    let d = geometry.geometry(feature, cs);
    console.log('select', d + '\nunion all');
  }
}*/
