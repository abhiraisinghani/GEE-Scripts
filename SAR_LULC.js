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

//apply the classifier
var classified = final.select(bands)
  .classify(classifier)
  .clip(roi);
  //remove salt-and-pepper noise (mode value)
var classified2 = classified.focal_mode({radius: 1, kernelType: 'circle', iterations: 1});

//Display the Classification
Map.addLayer(classified, 
{min: 1, max: 5, palette: ['0f65be', 'ff0e0e', 'ffba45', '0fc200', 'd7ff93']},
'SAR Classification',1);
Map.addLayer(classified2, 
{min: 1, max: 5, palette: ['0f65be', 'ff0e0e', 'ffba45', '0fc200', 'd7ff93']},
'SAR Classification2',1);

