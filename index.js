// ------ index.js ------
const proj4 = require('proj4');

const funk = {

  // https://docs.microsoft.com/en-us/sql/t-sql/spatial-geography/stlinefromtext-geography-data-type?view=sql-server-2017
  mapping: {
    // geojson
    Point: { f: 'STPointFromText', t: 'POINT' },
    MultiPoint: { f: 'STMPointFromText', t: 'MULTIPOINT' },
    LineString: { f: 'STLineFromText', t: 'LINESTRING' },
    MultiLineString: { f: 'STMLineFromText', t: 'MULTILINESTRING' },
    Polygon: { f: 'STPolyFromText', t: 'POLYGON' },
    MultiPolygon: { f: 'STMPolyFromText', t: 'MULTIPOLYGON' },
    // esri
    esriGeometryPolygon: { f: 'STPolyFromText', t: 'POLYGON' },
    esriGeometryPoint: { f: 'STPointFromText', t: 'POINT' },
    esriGeometryPolyline: { f: 'STLineFromText', t: 'LINESTRING' }
  },

  geometry: (feature_in, cs) => {
    if (typeof (feature_in || {}).geometry !== 'object') return null;
    if (typeof ((feature_in || {}).geometry || {}).type !== 'string') return null;
    let feature = JSON.parse(JSON.stringify(feature_in)); //deep copy
    let wtp = feature.geometry.coordinates; // geojson
    if (feature.geometry.rings) wtp = feature.geometry.rings; // esri polygon
    else if (feature.geometry.paths) wtp = feature.geometry.paths[0]; // esri line
    else if (feature.geometry.x) wtp = [feature.geometry.x, feature.geometry.y]; // esri point
    if (!Array.isArray(wtp) || (Array.isArray(wtp) && wtp.toString().replace(/,/g, '') === '')) return null;
    let t = feature.geometry.type;
    let str = `geography::${funk.mapping[t].f}('${funk.mapping[t].t} `;
    let r = funk.recurse(wtp, cs);
    const mapObj = { '"': '', '[': '(', ']': ')' };
    r = JSON.stringify(r).replace(/"|\[|\]/gi, matched => (mapObj[matched]));
    r = r.indexOf('(') === -1 ? `(${r})` : r;
    str += r + `', 4326).MakeValid()`;
    return str;
  },

  // singed area i.e. shoelace function, technically for signed area you need to divide by 2
  isAntiClockwise: poly => {
    if(!poly || poly.length < 3) return null; // has to have 3 + beginning to be a poly
    const end = poly.length - 1;
    // console.log('check for poly');
    if (poly[0].toString() !== poly[end].toString()) return null; // end has to match start
    let sum = poly[end][0] * poly[0][1] - poly[0][0] * poly[end][1]; // end of signed area/shoelace
    for(let i = 0; i < end; ++i) { // calculate beginning of singed area
      const n = i + 1;
      sum += poly[i][0] * poly[n][1] - poly[n][0] * poly[i][1];
    }
    return sum > 0 ? true : false;
  },

  recurse: (obj, cs, cb) => {
    if (Array.isArray(obj) && obj.length === 2 && !obj.some(isNaN)) {
      obj = cs ? proj4(cs, 'EPSG:4326', obj).join(' ') : obj.join(' ');
    } else if (Array.isArray(obj)) {
      if(funk.isAntiClockwise(obj) === false) obj.reverse();
      for (let i = 0, l = obj.length; i < l; ++i) {
        funk.recurse(obj[i], cs, r => {
          obj[i] = r;
        });
      }
    } else {
      obj = 'what the funk?';
    }
    if (typeof cb === 'function') {
      return cb(obj);
    }
    return obj;
  },

  gridLocation: (n, origin = [0, 0], spacing = [1, 1]) => {
    // always pass the javascript index of the element
    n = n + 1;
    let ring;
    let sqrt = Math.sqrt(n);
    if (Number.isInteger(sqrt) && Math.floor(sqrt) % 2 !== 0) {
      ring = sqrt;
    } else if (Math.floor(sqrt) % 2 === 0) {
      ring = Math.floor(sqrt) + 1;
    } else {
      ring = Math.floor(sqrt) + 2;
    }
    let max = Math.floor(ring / 2);
    let lastNumberOfRing = ring * ring;
    let positionInRing = Math.abs(n - lastNumberOfRing);

    let xGrid, yGrid, xT = [], xS = [], yB;
    for (let x = (max * -1); x <= max; ++x) {
      xT.push(x);
    }
    for (let x = 0; x < ring - 2; ++x) {
      xS.push(max);
    }
    xGrid = [...xT, ...xS, ...xT.reverse(), ...xS.map(x => -x)];

    yGrid = [...xGrid];
    yB = [...yGrid.splice(0, ring - 1)];
    yGrid.push(...yB);

    return {
      x: (xGrid[positionInRing] * spacing[0]) + origin[0],
      y: (yGrid[positionInRing] * spacing[1]) + origin[1]
    };
  }

};

module.exports = funk;
