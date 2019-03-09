const geometry = require('./index.js');
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
    rings: [
      [
        [
          -13073597.685949696,
          4016816.2240414247
        ],
        [
          -13073556.927396163,
          4016869.786173813
        ],
        [
          -13073373.50213326,
          4016598.5825590119
        ],
        [
          -13073609.988653919,
          4016800.3193637431
        ],
        [
          -13073597.685949696,
          4016816.2240414247
        ]
      ]
    ]
  }
};
feature.geometry.type = 'esriGeometryPolygon';
let cs = 'EPSG:3857';
let d = geometry.geometry(feature, cs);
console.log(d + '\n');
