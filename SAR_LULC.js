//Define geometry first (ROI)

//Import or Define Sample
  // var Water: Featu reC011ection 4 elements)
  // var Built: Featu reCollection 17 elements)
  // var Barren: Featu reC011ection (13 elements)
  // var Forest: Featu reCot1ection (42 elements)
  // var Agriculture: Featu recollection (21 elements)

Map.centerObject(ROI);

//Merge Feature Collections (sample data)
var newfc = Water.merge(Built).merge(Barren).merge(Forest).merge(Agriculture);
//DATES
var startDate = '2019-12-01';
var endDate = '2019-12-30';

// Extract SAR Bands Sentinel 1
// VV band
var collectionVV = ee.ImageCollection('COPERNICUS/S1_GRD')
.filter(ee.Filter.eq('instrumentMode', 'IW'))
.filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
.filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
.filterMetadata('resolution_meters', 'equals' , 10)
.filterBounds(roi)
.filterDate(startDate, endDate)
.select('VV');

// VH band
var collectionVH = ee.ImageCollection('COPERNICUS/S1_GRD')
.filter(ee.Filter.eq('instrumentMode', 'IW'))
.filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
.filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
.filterMetadata('resolution_meters', 'equals' , 10)
.filterBounds(roi)
.filterDate(startDate, endDate)
.select('VH');

//mosaic
var SARVV = collectionVV.mosaic();
var SARVH = collectionVH.mosaic();

//Cloud Mask
// Function to cloud mask from the QA_PIXEL band of Landsat 8 SR data.
function maskL8sr(image) {
  // Bits 3 and 5 are cloud shadows and clouds, respectively.
  var cloudShadowBitMask = 1 << 3;
  var cloudsBitMask = 1 << 5;
  // Get the QA_PIXEL band.
  var qa = image.select('QA_PIXEL');
  // Both flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudShadowBitMask).eq(0)
  .and(qa.bitwiseAnd(cloudsBitMask).eq(0));
  // Return the masked image, scaled to reflectance, without the QA bands.
   return image.updateMask(mask).divide(10000)
  .select("SR_B[0-9]*")
  .copyProperties(image, ["system:time_start"]);
  }

// Extract the images and apply cloudmask from the Landsat8 collection
var collectionl8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
.filterDate(startDate, endDate)
.filterBounds(roi)
.map(maskL8sr);
//take median layer>generate NDVI> make new collection
var comp = collectionl8.median();
var ndvi = comp.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
var composite = ee.Image.cat(comp,ndvi);

//Apply filter to reduce speckle in SAR Data
var SMOOTHING_RADIUS = 50;
var SARVV_filtered = SARVV.focal_mean(SMOOTHING_RADIUS, 'circle', 'meters');
var SARVH_filtered = SARVH.focal_mean(SMOOTHING_RADIUS, 'circle', 'meters');

//Define the SAR bands to train your data
var final = ee.Image.cat(SARVV_filtered,SARVH_filtered);
var bands = ['VH','VV'];
var training = final.select(bands).sampleRegions({
  collection: newfc,
  properties: ['landcover'],
  scale: 10 });
  
//Train the classifier
var classifier = ee.Classifier.libsvm().train({
  features: training,
  classProperty: 'landcover',
  inputProperties: bands
});
