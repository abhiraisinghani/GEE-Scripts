//Define geometry first (ROI)

//  PREPARE THE IMAGERY

// import Landsat 8 images 
var L8C = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
    .filterBounds(geometry)
    .filterDate('2023-01-01', '2024-01-01')
    .filter(ee.Filter.lt('CLOUD_COVER',10)); // Get the whole year first

// Apply scale and offset to Landsat 8 images
// Calculate NDVI and NDWI indices
var l8_preprocess = function (image) {
    // A function to mask clouds and shadows

    function cloudMask(img) {
        var qa = img.select('QA_PIXEL');
        var dilate = (1 << 1);
        var cirrus = (1 << 2);
        var cloud = (1 << 3);
        var shadow = (1 << 4);
        var mask = qa.bitwiseAnd(dilate).eq(0)
            .and(qa.bitwiseAnd(cirrus).eq(0))
            .and(qa.bitwiseAnd(cloud).eq(0))
            .and(qa.bitwiseAnd(shadow).eq(0));
        return img.updateMask(mask);
    }

    var processed = cloudMask(image).clip(geometry); // Apply cloud mask
    var bands = processed.select('SR_B[2-7]');
    var tir = processed.select('ST_B10');
    
    
    var ndvi = processed.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
    var ndwi = processed.normalizedDifference(['SR_B3', 'SR_B5']).rename('NDWI');

  // scale after calculating indices with the original values
    var bands_scaled = bands.multiply(2.75e-05).add(-0.2);
    var tir_scaled = tir.multiply(0.00341802).add(149);

    return bands_scaled.addBands(tir_scaled).addBands(ndvi).addBands(ndwi)
        .copyProperties(image, ["system:time_start"]);
};

//CREATE SEASONAL COMPOSITES

var year = '2023';
// Define the seasons
var seasons = [
  {name: 'spring', start: year + '-03-21', end: year + '-06-20'},
  {name: 'summer', start: year + '-06-21', end: year + '-09-22'},
  {name: 'autumn', start: year + '-09-23', end: year + '-12-21'},
  {name: 'winter', start: year + '-01-01', end: year + '-03-20'}
];

// Function to create a seasonal median composite
var createSeasonalComposite = function(season) {
  var seasonal_collection = L8C.filterDate(season.start, season.end);
  var processed_collection = seasonal_collection.map(l8_preprocess);
  var median_composite = processed_collection.median();
  // Rename bands to be unique for each season
  return median_composite.rename(median_composite.bandNames().map(function(b) {
    return ee.String(season.name).cat('_').cat(b);
  }));
};

// Map over the seasons to create a list of seasonal images
var seasonal_images = seasons.map(createSeasonalComposite);

// Convert the list of images into a single multi-band image (a stack)
var landsat_stack = ee.ImageCollection.fromImages(seasonal_images).toBands();
// The band names will now be like 'winter_SR_B2', 'summer_NDVI', etc.


// import MODIS LC product with 500m resolution
var MODIS_C = ee.ImageCollection("MODIS/061/MCD12Q1")
    .filterDate('2023-01-01', '2024-01-01')
    .select('LC_Type2')
    .first() // Use first() to get a single image
    .clip(geometry);

//SAMPLING AND CLASSIFICATION ---

// Concat the MODIS product with the new seasonal Landsat stack
var mixed = ee.Image.cat([landsat_stack, MODIS_C]);

// Get all the new seasonal band names for the classifier input
var input_properties = landsat_stack.bandNames();

// Sample data using MODIS product 
var full_sample = mixed.stratifiedSample({
    numPoints: 200, 
    classBand: 'LC_Type2',
    region: geometry,
    scale: 30,
    geometries: true
});

// Add a random column and split into training and validation
full_sample = full_sample.randomColumn();
var training_split = 0.7; // 70% for training, 30% for validation
var training_data = full_sample.filter(ee.Filter.lt('random', training_split));
var validation_data = full_sample.filter(ee.Filter.gte('random', training_split));

// Define Classifier and train on the seasonal data
var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees: 100,
    seed: 42
}).train({
    features: training_data,
    classProperty: 'LC_Type2',
    inputProperties: input_properties // Use the full list of seasonal bands
});

//EVALUATION

// Training Accuracy
var train_acc = classifier.confusionMatrix();
print(train_acc.accuracy());
print(train_acc.kappa());

// Validation Accuracy
var validated = validation_data.classify(classifier);
var test_accuracy = validated.errorMatrix('LC_Type2', 'classification');
print(test_accuracy.accuracy());
print(test_accuracy.kappa());


// VISUALIZATION

// Classify the entire seasonal stack
var classified = landsat_stack.classify(classifier);

// Define MODIS land cover visualization palette
var vis = {min: 0, max: 15, palette: ['1c0dff', '05450a', '086a10', '54a708', '78d203', '009900', 'c6b044', 'dcd159', 'dade48', 'fbff13', 'b6ff05', '27ff87', 'c24f44', 'a5a5a5', 'ff6d4c', 'f9ffa4']};

Map.centerObject(geometry, 8);
Map.addLayer(classified, vis, 'L8_LULC_Upsampled_Seasonal');
Map.addLayer(MODIS_C,vis,'MODIS Original Product');
