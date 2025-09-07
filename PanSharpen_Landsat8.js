// Create ROI first (region of Interest)

var startDate = '2020-04-01';
var endDate = '2020-04-15';
var dataset = ee.ImageCollection('LANDSAT/LC08/C02/T1_TOA')
   .filterDate(startDate, endDate).filterBounds(roi).mean();
   
   Map.centerObject(roi);
     var visualization = {
  bands: ['B4', 'B3', 'B2'], min: 0, max: 0.25, gamma: [1.1,1.1,1]
};
Map.addLayer(dataset,visualization,'RGB');

var hsv = dataset.select(['B4','B3','B2']).rgbToHsv();

var sharpned = ee.Image.cat([
  hsv.select('hue'),hsv.select('saturation'),dataset.select('B8')
  ]).hsvToRgb();
  
  Map.addLayer(sharpned,{ min: 0, max: 0.25, gamma: [1.3,1.3,1]},'PANsharpned');
