/** Synthetic controls; EPSG conversion 15387 supplies the Illinois East parameters.
 * https://epsg.org/api/v1/Conversion/15387/export?format=gml
 */
const degree = 'ANGLEUNIT["degree",0.0174532925199433]';
const wgs1 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]';
const nad1 =
  'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]';
const base = (name, datum, ellipsoid, rf) =>
  `BASEGEOGCRS["${name}",DATUM["${datum}",ELLIPSOID["${ellipsoid}",6378137,${rf}]],PRIMEM["Greenwich",0,${degree}]]`;
const wgs2 = base('WGS 84', 'World Geodetic System 1984', 'WGS 84', 298.257223563);
const nad2 = base('NAD83', 'North American Datum 1983', 'GRS 1980', 298.257222101);
const metre = 'LENGTHUNIT["metre",1]';
const foot = 'LENGTHUNIT["US survey foot",0.3048006096012192]';
const wkt2 = (name, gcs, method, lat, lon, scale, east, north, unit) =>
  `PROJCRS["${name}",${gcs},CONVERSION["${name}",METHOD["${method}"],PARAMETER["Latitude of natural origin",${lat},${degree}],PARAMETER["Longitude of natural origin",${lon},${degree}],PARAMETER["Scale factor at natural origin",${scale},SCALEUNIT["unity",1]],PARAMETER["False easting",${east},${unit}],PARAMETER["False northing",${north},${unit}]],CS[Cartesian,2],AXIS["Easting",east],AXIS["Northing",north],${unit}]`;

export const statePlane = {
  name: 'Illinois East US feet',
  wkt:
    'PROJCS["NAD_1983_StatePlane_Illinois_East_FIPS_1201_Feet",' +
    nad1 +
    ',PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",984250],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",-88.3333333333333],PARAMETER["Scale_Factor",0.999975],PARAMETER["Latitude_Of_Origin",36.6666666666667],UNIT["Foot_US",0.3048006096012192]]',
  wkt2: wkt2(
    'Illinois East US feet',
    nad2,
    'Transverse Mercator',
    36.6666666666667,
    -88.3333333333333,
    0.999975,
    984250,
    0,
    foot,
  ),
  proj: '+proj=tmerc +lat_0=36.6666666666667 +lon_0=-88.3333333333333 +k=0.999975 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft',
  wkid: 3435,
  aliases: [3435],
  xy: [984250, 0],
  lonlat: [-88.3333333333333, 36.6666666666667],
  options: { allowNad83ZeroShift: true },
};
export const webMercator = {
  name: 'Web Mercator Auxiliary Sphere',
  wkt:
    'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",' +
    wgs1 +
    ',PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",0],PARAMETER["Standard_Parallel_1",0],PARAMETER["Auxiliary_Sphere_Type",0],UNIT["Meter",1]]',
  wkt2: wkt2(
    'WGS 84 Web Mercator',
    wgs2,
    'Popular Visualisation Pseudo Mercator',
    0,
    0,
    1,
    0,
    0,
    metre,
  ),
  proj: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null',
  wkid: 3857,
  aliases: [3857, 102100],
  xy: [1113194.9079327357, 2273030.926987689],
  lonlat: [10, 20],
  options: {},
};
export const utm = {
  name: 'WGS84 UTM 17N',
  wkt:
    'PROJCS["WGS_1984_UTM_Zone_17N",' +
    wgs1 +
    ',PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",-81],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0],UNIT["Meter",1]]',
  wkt2: wkt2(
    'WGS 84 UTM 17N',
    wgs2,
    'Transverse Mercator',
    0,
    -81,
    0.9996,
    500000,
    0,
    metre,
  ),
  proj: '+proj=utm +zone=17 +datum=WGS84 +units=m',
  wkid: 32617,
  aliases: [32617],
  xy: [500000, 0],
  lonlat: [-81, 0],
  options: {},
};
export const projectedControls = [statePlane, webMercator, utm];
export function optionsFor(fixture) {
  return fixture === statePlane
    ? {
        ...fixture.options,
        projectionDefinitions: { [`EPSG:${fixture.wkid}`]: fixture.proj },
      }
    : { ...fixture.options };
}
