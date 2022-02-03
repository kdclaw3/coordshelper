# coordshelper


Utility functions for transforming coordinates for insertion into Microsoft SQL Database. SQL Server decides to be finicky about inserting valid geography with the correct ring orientation and valid syntax. The use case for this package was to specifically:

* Transform ArcGIS Server Feature Coordinates or GeoJSON Coordinates to MSSQL geography
* Coordinates Tree Traversal: Process large lines, polygons, and multipolygons quickly without dropping multis or loosing minus polygons.
* Polygon Correction: SQL Server requires anticlockwise coordinates for polygons, usually... 
* Spatial Projection: Allow the projection of coordinates into a geographic coordinate system (EPSG:4326). This library uses "proj4", found good luck in specifying proj4 coordinate systems from http://spatialreference.org/. 
* Valid Geometry: After all this work SQL Server tends to freeeeak out, we lazily slap a MakeValid() on every geometry.


# ![Alt text](us.png?raw=true "Title")


## Install

To use it in your project, run:

```bash
npm install --save coordshelper
```

## GeoJSON Example

Specifying something like this...
```js
const geometry = require('coordshelper');
let feature = {
	type: 'Feature',
	id: 1,
	geometry: {
		type: 'Polygon',
		coordinates: [[[1349235.9285449, 498684.84654698], [1349199.5195318, 497632.0466852], [1349692.1275532, 497527.06626685], [1345877.3452267, 498207.3156757], [1346722.8178152, 498340.50814124], [1346731.0806201, 498725.56802003], [1349235.9285449, 498684.84654698]]]
	},
	properties: { NAME: 'PITTSBURGH' }
};
// State Plane Coordinate System Pennsylvania South (ftus)
let cs = '+proj=lcc +lat_1=40.96666666666667 +lat_2=39.93333333333333 +lat_0=39.33333333333334 +lon_0=-77.75 +x_0=600000 +y_0=0 +ellps=GRS80 +datum=NAD83 +to_meter=0.3048006096012192 +no_defs';
let d = geometry.geometry(feature, cs);
console.log(d + '\n');
```

Will give you something like this...
```sql
geography::STPolyFromText('POLYGON ((-79.98301052449202 40.68075935135676,-79.99204263502472 40.68069690676022,-79.99203717387824 40.67963973601989,-79.99507230435954 40.679215307900044,-79.98126075345523 40.67761406748069,-79.98304578309079 40.67786795917588,-79.98301052449202 40.68075935135676))', 4326).MakeValid()
```

## Esri ArcGIS Server Example

Specifying something like this...
```js
const geometry = require('coordshelper');
let feature = {
  attributes: {
    'objectid': 1007165,
    'apn': '234270017',
    'address': '3125  Myers St',
    'pool_permit': 0,
    'has_pool': 0,
    'st_area(shape)': 82300.902959399231,
    'st_length(shape)': 1256.8567145994186
  },
  geometry: {
    rings: [[[-13073597.685949696, 4016816.2240414247], [-13073556.927396163, 4016869.786173813], [-13073373.50213326, 4016598.5825590119], [-13073609.988653919, 4016800.3193637431], [-13073597.685949696, 4016816.2240414247]]]
  }
};
feature.geometry.type = 'esriGeometryPolygon'; // <--see esri examples, esri declares type at the route not the feature
let cs = 'EPSG:3857';
let d = geometry.geometry(feature, cs);
console.log(d + '\n');
```

Will give you something like this...
```sql
geography::STPolyFromText('POLYGON ((-117.4421261971822 33.91069040186868,-117.44223671425458 33.9105718293564,-117.44011231969463 33.90906782733127,-117.44176005686622 33.91108971692754,-117.4421261971822 33.91069040186868))', 4326).MakeValid()
```

## License
MIT License