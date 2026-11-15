/* Demo scenarios.
 * Flood extents here are ILLUSTRATIVE blobs placed over real flood-prone areas so the
 * routing logic can be demonstrated offline. For real events, import an official flood
 * mask as GeoJSON (NASA Disasters, UNOSAT, Copernicus EMS, Sentinel-1 / VIIRS products). */
const SCENARIOS = {
  dadu: {
    name: "Sindh, Pakistan — Indus floods (2022)",
    center: [26.73, 67.78],
    halfLat: 0.055, halfLng: 0.065,
    zoom: 12,
    dates: { before: "2022-06-20", during: "2022-09-06" },
    // r = radius in metres, seed = shape of the irregular blob
    blobs: [
      { lat: 26.745, lng: 67.805, r: 1500, seed: 11 },
      { lat: 26.700, lng: 67.770, r: 1700, seed: 23 },
      { lat: 26.742, lng: 67.742, r: 1300, seed: 37 },
      { lat: 26.690, lng: 67.835, r: 1000, seed: 5 },
    ],
    villages: [
      { name: "Dadu — north-east settlement", lat: 26.762, lng: 67.800 },
      { name: "Dadu — east settlement", lat: 26.745, lng: 67.805 },
      { name: "Dadu — southern fields", lat: 26.700, lng: 67.770 },
      { name: "Dadu — west settlement", lat: 26.742, lng: 67.742 },
    ],
  },
  sylhet: {
    name: "Sylhet, Bangladesh — monsoon floods (2022)",
    center: [24.90, 91.87],
    halfLat: 0.05, halfLng: 0.06,
    zoom: 12,
    dates: { before: "2022-04-20", during: "2022-06-22" },
    blobs: [
      { lat: 24.915, lng: 91.845, r: 1300, seed: 7 },
      { lat: 24.885, lng: 91.895, r: 1400, seed: 19 },
      { lat: 24.925, lng: 91.900, r: 900, seed: 41 },
    ],
    villages: [
      { name: "Sylhet — north-west area", lat: 24.918, lng: 91.856 },
      { name: "Sylhet — northern edge", lat: 24.930, lng: 91.856 },
      { name: "Sylhet — south-east area", lat: 24.876, lng: 91.910 },
    ],
  },
  kerala: {
    name: "Kuttanad, Kerala — floods (2018)",
    center: [9.45, 76.42],
    halfLat: 0.05, halfLng: 0.06,
    zoom: 12,
    dates: { before: "2018-07-10", during: "2018-08-21" },
    blobs: [
      { lat: 9.465, lng: 76.395, r: 2500, seed: 3 },
      { lat: 9.430, lng: 76.445, r: 2300, seed: 29 },
      { lat: 9.470, lng: 76.450, r: 1400, seed: 13 },
    ],
    villages: [
      { name: "Kuttanad — north-east edge", lat: 9.458, lng: 76.444 },
      { name: "Kuttanad — north-west", lat: 9.465, lng: 76.395 },
      { name: "Kuttanad — south-east", lat: 9.430, lng: 76.445 },
    ],
  },
};
