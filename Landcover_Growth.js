//Configuration and load data

Map.centerObject(aoi, 10);

var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(aoi);

var startYear = ee.Date(dw.aggregate_min('system:time_start')).get('year');
var endYear   = ee.Date(dw.aggregate_max('system:time_start')).get('year');

var LULC = 0;
var Name = 'Water';

var lulcVis = {
  min: 0,
  max: 1,
  palette: ['ffffff', 'red'],
  opacity:0.2
};

var years = ee.List.sequence(startYear,endYear);

// Create Annual LULC Image for selected Class - FUNCTION

var annualImages = years.map(
  function(year) {
    year = ee.Number(year);

    var start = ee.Date.fromYMD(year,1,1);
    var end = start.advance(1,'year');

    var yearlyDW = dw.filterDate(start, end);

    var annualLULC = yearlyDW
      .select('label')
      .reduce(ee.Reducer.mode())
      .eq(LULC)
      .toByte()
      .clip(aoi);

    return annualLULC
      .set('year', year)
      .set('system:time_start',start.millis()
      );
      
  });

// create image collection  
var annualCollection = ee.ImageCollection( annualImages );

// Add to map
years.evaluate(function(yearList) {
  yearList.forEach(function(year) {
    var image = annualCollection
    .filter(ee.Filter.eq('year', year))
    .first();
    Map.addLayer(image.selfMask(), lulcVis,
    Name + '_' + year, false );
      });
    });

// Create multi-band composite
var stack = annualCollection .sort('year') .toBands();

// Rename Bands
var bandNames = years.map(function(year) {
  return ee.String(Name) .cat('_') .cat( ee.Number(year).format('%d') ); 
  });

stack = stack.rename(bandNames);

//Export Stack
Export.image.toDrive({
  image: stack, description: 'DynamicWorld_' + Name + '_Annual',
  folder: 'DynamicWorld', fileNamePrefix: 'DW_' + Name + '_Annual',
  region: aoi, scale: 10, crs: 'EPSG:4326', maxPixels: 1e13, fileFormat: 'GeoTIFF' });
