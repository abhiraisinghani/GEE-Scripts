// configuration

var startYear = 2001;
var endYear = 2025;

var baselineStart = 2001;
var baselineEnd = 2010;

// Loading data

var modis = ee.ImageCollection('MODIS/061/MOD11A2')
  .filterBounds(aoi)
  .filterDate(
    ee.Date.fromYMD(startYear, 1, 1),
    ee.Date.fromYMD(endYear + 1, 1, 1)
  )
  .select('LST_Day_1km');

// MODIS LST scale factor = 0.02 and then Kelvin -> Celsius

var lst = modis.map(function(image) {

  var temperature = image
    .multiply(0.02)
    .subtract(273.15)
    .rename('LST');

  return temperature
    .copyProperties(image, ['system:time_start']);
});

print('LST collection:', lst);

// Yearly - Monthly Mean Temperature - FUNCTION

var years = ee.List.sequence(startYear, endYear);
var months = ee.List.sequence(1, 12);

var monthlyImages = ee.ImageCollection.fromImages(

  years.map(function(year) {

    return months.map(function(month) {

      year = ee.Number(year);
      month = ee.Number(month);

      var start = ee.Date.fromYMD(year, month, 1);
      var end = start.advance(1, 'month');

      var monthly = lst
        .filterDate(start, end)
        .mean()
        .rename('LST');

      return monthly
        .set('year', year)
        .set('month', month)
        .set('system:time_start', start.millis());

    });

  }).flatten()
);

print('Monthly LST:', monthlyImages);

// MONTHLY CLIMATOLOGY FUNCTION - for baseline

var climatology = ee.ImageCollection.fromImages(

  months.map(function(month) {

    month = ee.Number(month);

    var monthlyClimatology = monthlyImages
      .filter(ee.Filter.eq('month', month))
      .filter(ee.Filter.gte('year', baselineStart))
      .filter(ee.Filter.lte('year', baselineEnd))
      .mean()
      .rename('Climatology');

    return monthlyClimatology
      .set('month', month);

  })
);

print('Monthly climatology:', climatology);

// Anomaly = Monthly LST - Monthly climatological mean - FUNCTION

var anomalies = monthlyImages.map(function(image) {

  var month = ee.Number(image.get('month'));

  var normal = climatology
    .filter(ee.Filter.eq('month', month))
    .first();

  var anomaly = image
    .subtract(normal)
    .rename('Temperature_Anomaly');

  return anomaly
    .set('year', image.get('year'))
    .set('month', image.get('month'))
    .set(
      'system:time_start',
      image.get('system:time_start')
    );

});

print('Temperature anomalies:', anomalies);

// Display an example year. 
// Change these to the year/month you want to display.

var displayYear = 2024;
var displayMonth = 4;


//for (var displayYear = 2020; displayYear<=2025;displayYear++){

// Get selected anomaly

var selectedAnomaly = anomalies
  .filter(ee.Filter.eq('year', displayYear))
  .filter(ee.Filter.eq('month', displayMonth))
  .first();

// Get selected monthly temperature

var selectedTemperature = monthlyImages
  .filter(ee.Filter.eq('year', displayYear))
  .filter(ee.Filter.eq('month', displayMonth))
  .first();

// Get climatological mean

var selectedClimatology = climatology
  .filter(ee.Filter.eq('month', displayMonth))
  .first();


// Visualisation Parameters

var tempVis = {
  min: 15,
  max: 45,
  palette: [
    'blue',
    'cyan',
    'green',
    'yellow',
    'orange',
    'red'
  ]
};

var anomalyVis = {
  min: -5,
  max: 5,
  palette: [
    '08306b',
    '2171b5',
    '6baed6',
    'ffffff',
    'fcbba1',
    'fb6a4a',
    'cb181d',
    '67000d'
  ]
};

// Add layers

Map.addLayer(
  selectedTemperature.clip(aoi),
  tempVis,
  'Monthly LST ' + displayYear + '-' + displayMonth,
  false
);

Map.addLayer(
  selectedClimatology.clip(aoi),
  tempVis,
  'Climatological Mean',
  false
);

Map.addLayer(
  selectedAnomaly.clip(aoi),
  anomalyVis,
  'Temperature Anomaly ' +
  displayYear + '-' + displayMonth,
  true
);

// Charts and statistics

// Temp Anomaly mean/min/max

var anomalyStats = selectedAnomaly.reduceRegion({
  reducer: ee.Reducer.mean()
    .combine({
      reducer2: ee.Reducer.min(),
      sharedInputs: true
    })
    .combine({
      reducer2: ee.Reducer.max(),
      sharedInputs: true
    }),
  geometry: aoi,
  scale: 1000,
  maxPixels: 1e13
});

print(
  'AOI Temperature Anomaly Statistics:',
  anomalyStats
);

//MEAN TEMPERATURE FOR AOI

var temperatureStats = selectedTemperature.reduceRegion({
  reducer: ee.Reducer.mean(),
  geometry: aoi,
  scale: 1000,
  maxPixels: 1e13
});

print(
  'AOI Mean LST:',
  temperatureStats
);

// mean baseline temp

var climatologyStats = selectedClimatology.reduceRegion({
  reducer: ee.Reducer.mean(),
  geometry: aoi,
  scale: 1000,
  maxPixels: 1e13
});

print(
  'AOI Climatological Mean:',
  climatologyStats
);

//monthly anomaly chart / AOI-average anomaly time series.

var chart = ui.Chart.image.series({
  imageCollection: anomalies,
  region: aoi,
  reducer: ee.Reducer.mean(),
  scale: 1000,
  xProperty: 'system:time_start'
})
.setOptions({
  title: 'Monthly MODIS Temperature Anomaly',
  hAxis: {
    title: 'Date'
  },
  vAxis: {
    title: 'Temperature Anomaly (°C)'
  },
  lineWidth: 1,
  pointSize: 2,
  legend: {
    position: 'none'
  }
});

print(chart);

// Calculate annual mean anomaly from monthly anomalies and chart

var annualAnomalies = ee.ImageCollection.fromImages(

  years.map(function(year) {

    year = ee.Number(year);

    var annual = anomalies
      .filter(ee.Filter.eq('year', year))
      .mean()
      .rename('Annual_Temperature_Anomaly');

    return annual
      .set('year', year)
      .set(
        'system:time_start',
        ee.Date.fromYMD(year, 1, 1).millis()
      );

  })
);

print(
  'Annual Temperature Anomalies:',
  annualAnomalies
);

var annualChart = ui.Chart.image.series({
  imageCollection: annualAnomalies,
  region: aoi,
  reducer: ee.Reducer.mean(),
  scale: 1000,
  xProperty: 'system:time_start'
})
.setOptions({
  title: 'Annual Mean Temperature Anomaly',
  hAxis: {
    title: 'Year'
  },
  vAxis: {
    title: 'Temperature Anomaly (°C)'
  },
  lineWidth: 2,
  pointSize: 4,
  legend: {
    position: 'none'
  }
});

print(annualChart);


// EXPORT SELECTED ANOMALY

Export.image.toDrive({
  image: selectedAnomaly.clip(aoi),
  description:
    'MODIS_Temperature_Anomaly_' +
    displayYear + '_' +
    displayMonth,
  folder: 'GEE_MODIS_Temperature_Anomaly',
  fileNamePrefix:
    'MODIS_Temperature_Anomaly_' +
    displayYear + '_' +
    displayMonth,
  region: aoi,
  scale: 1000,
  maxPixels: 1e13,
  fileFormat: 'GeoTIFF'
});

Export.image.toDrive({
  image: selectedClimatology.clip(aoi),
  description:
    'MODIS_Temperature_mean_' +
    displayYear + '_' +
    displayMonth,
  folder: 'GEE_MODIS_Temperature_Anomaly',
  fileNamePrefix:
    'MODIS_Temperature_mean_' +
    displayYear + '_' +
    displayMonth,
  region: aoi,
  scale: 1000,
  maxPixels: 1e13,
  fileFormat: 'GeoTIFF'
});

Export.image.toDrive({
  image: selectedTemperature.clip(aoi),
  description:
    'MODIS_Temperature_Temp_' +
    displayYear + '_' +
    displayMonth,
  folder: 'GEE_MODIS_Temperature_Anomaly',
  fileNamePrefix:
    'MODIS_Temperature_Temp_' +
    displayYear + '_' +
    displayMonth,
  region: aoi,
  scale: 1000,
  maxPixels: 1e13,
  fileFormat: 'GeoTIFF'
});
