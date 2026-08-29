// config
Map.centerObject(aoi,10);

var year = 2013; // 2013 tot 2024
var start = ee.Date.fromYMD(year, 1, 1);
var end = start.advance(1, 'year');

var seasons = [ 
  { name: 'Winter', start: year + '-01-01', end: year + '-04-01' },
  { name: 'Summer', start: year + '-04-01', end: year + '-07-01' },
  { name: 'Monsoon', start: year + '-07-01', end: year + '-10-01' },
  { name: 'Post-Monsoon', start: year + '-10-01', end: year + '-12-31' } ];

// import Landsat 8 images 
var collection = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
    .filterBounds(aoi)
    .filterDate(start,end)
    .filter(ee.Filter.lt('CLOUD_COVER',10)) // Get the whole year first
    .map(function(image) {
      return image.clip(aoi);});
      
      
print(collection);

var preprocess = function (image) {

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

    var processed = cloudMask(image); // Apply cloud mask
    processed = processed.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
                                 ['B2','B3','B4','B5','B6','B7']);
                                 
                                 
    // scale bands
    var bands_scaled = processed.multiply(2.75e-05).add(-0.2);
    
    //calculating indices
    var ndvi = bands_scaled.normalizedDifference(['B5', 'B4']).rename('NDVI');
    var ndwi = bands_scaled.normalizedDifference(['B3', 'B5']).rename('NDWI');

    return bands_scaled.addBands(ndvi).addBands(ndwi)
        .copyProperties(image, ["system:time_start"]);
};

//CREATE SEASONAL COMPOSITES

// Function to create a seasonal median composite
var createSeasonalComposite = function(season) {
  
  var seasonal_collection = collection.filterDate(season.start, season.end);
  
  var processed_collection = seasonal_collection.map(preprocess);
  
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
    .filterDate(start,end)
    .select('LC_Type2')
    .first() // Use first() to get a single image
    .clip(aoi);
    
  
// Concat the MODIS product with the new seasonal Landsat stack
var mixed = ee.Image.cat([landsat_stack, MODIS_C]);

// Get all the new seasonal band names for the classifier input
var input_properties = landsat_stack.bandNames();

// Sample data using MODIS product 
var full_sample = mixed.stratifiedSample({
    numPoints: 200, 
    classBand: 'LC_Type2',
    region: aoi,
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
print(
  ee.String('Train Accuracy: ')
    .cat(train_acc.accuracy().format('%.4f'))
    .cat(' | Train Kappa: ')
    .cat(train_acc.kappa().format('%.4f'))
);

// Validation Accuracy
var validated = validation_data.classify(classifier);
var test_accuracy = validated.errorMatrix('LC_Type2', 'classification');

print(
  ee.String('Train Accuracy: ')
    .cat(test_accuracy.accuracy().format('%.4f'))
    .cat(' | Train Kappa: ')
    .cat(test_accuracy.kappa().format('%.4f'))
);

// Creating LULC

var landsatProjection = collection.first().select('SR_B2').projection();
  
// Classify the entire seasonal stack

var classified_original = landsat_stack.classify(classifier);
classified_original=classified_original.setDefaultProjection(landsatProjection);

var classified_smoothed = classified_original.focal_mode({radius: 2,  units: 'pixels'});

// VISUALIZATION
// Define MODIS land cover visualization palette
var vis = {min: 0, max: 15, palette: ['1c0dff', '05450a', '086a10', '54a708', '78d203', '009900', 'c6b044', 'dcd159', 'dade48', 'fbff13', 'b6ff05', '27ff87', 'c24f44', 'a5a5a5', 'ff6d4c', 'f9ffa4']};

Map.addLayer(classified_original, vis, 'LULC');
Map.addLayer(classified_smoothed, vis, 'LULC_resampled');
Map.addLayer(MODIS_C,vis,'MODIS Original Product');

// Stastics

function calculateAccuracy(image, name) {

  var image_modis = image
    .reduceResolution({
      reducer: ee.Reducer.mode(),
      maxPixels: 1024
    })
    .reproject({
      crs: MODIS_C.projection()
    });

  var comparison = ee.Image.cat([
    MODIS_C.rename('MODIS'),
    image_modis.rename('Landsat')
  ]);

  var samples = comparison.sample({
    region: aoi,
    scale: 500,
    projection: MODIS_C.projection(),
    geometries: false,
    tileScale: 4
  });

  var matrix = samples.errorMatrix(
    'MODIS',
    'Landsat'
  );
  
  print(
  ee.String(name + ' Classification Statistics: \n')
    .cat('Accuracy: ')
    .cat(matrix.accuracy().format('%.4f'))
    .cat(' | Kappa: ')
    .cat(matrix.kappa().format('%.4f'))
);

  print(matrix);

}


calculateAccuracy(
  classified_original,
  'Original'
);

calculateAccuracy(
  classified_smoothed,
  'Smoothed'
);
