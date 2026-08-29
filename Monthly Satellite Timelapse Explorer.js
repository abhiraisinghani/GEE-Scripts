// 1. Constants

var MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

var YEAR_LIST = (function () {
  var years = [];
  for (var y = 2015; y <= 2026; y++) years.push(String(y));
  return years;
})();

var SENSOR_MAP = {
  'Sentinel-2 (10m)': 'S2',
  'Landsat 8/9 (30m)': 'LANDSAT',
  'Sentinel-2 + Landsat (30m)': 'COMBINED'
};

var SCALE_MAP = { S2: 10, LANDSAT: 30, COMBINED: 30 };
var MAX_MONTHS = 120;
var PREVIEW_DIMENSIONS = 671; // ~650-700px wide as specified

//2. Default State

var state = {
  aoi: null,          // ee.Geometry
  sensor: 'S2',
  cloudPct: 20,
  composites: [],      // client array of ee.Image (one per month)
  collection: null,    // ee.ImageCollection of the composites above
  visParams: null,     // common 2-98% stretch, shared across all months
  frames: [],          // client array of {image, label, count, hasData}
  currentIndex: 0,
  playing: false,
  speed: 1.0,          // seconds per frame
  timerId: null
};

// 3. Image Pre Processing

function maskSentinel2(img) {
  var scl = img.select('SCL');
  var mask = scl.neq(3)   // cloud shadow
    .and(scl.neq(8))      // cloud, medium probability
    .and(scl.neq(9))      // cloud, high probability
    .and(scl.neq(10))     // cirrus
    .and(scl.neq(11));    // snow / ice
  return img.updateMask(mask);
}

function prepareSentinel2(aoi, start, end, cloudPct) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate(start, end)
    .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', cloudPct))
    .map(maskSentinel2)
    .map(function (img) {
      return img.select(['B4', 'B3', 'B2'])
        .multiply(0.0001)
        .rename(['R', 'G', 'B'])
        .set('system:time_start', img.get('system:time_start'));
    });
}

function maskLandsat(img) {
  var qa = img.select('QA_PIXEL');
  var dilatedCloudOk = qa.bitwiseAnd(1 << 1).eq(0);
  var cirrusOk = qa.bitwiseAnd(1 << 2).eq(0);
  var cloudOk = qa.bitwiseAnd(1 << 3).eq(0);
  var cloudShadowOk = qa.bitwiseAnd(1 << 4).eq(0);
  var mask = dilatedCloudOk.and(cirrusOk).and(cloudOk).and(cloudShadowOk);
  return img.updateMask(mask);
}

function prepareLandsatOne(collectionId, aoi, start, end, cloudPct) {
  return ee.ImageCollection(collectionId)
    .filterBounds(aoi)
    .filterDate(start, end)
    .filter(ee.Filter.lte('CLOUD_COVER', cloudPct))
    .map(maskLandsat)
    .map(function (img) {
      return img.select(['SR_B4', 'SR_B3', 'SR_B2'])
        .multiply(0.0000275).add(-0.2)
        .rename(['R', 'G', 'B'])
        .set('system:time_start', img.get('system:time_start'));
    });
}

function prepareLandsat(aoi, start, end, cloudPct) {
  var l8 = prepareLandsatOne('LANDSAT/LC08/C02/T1_L2', aoi, start, end, cloudPct);
  var l9 = prepareLandsatOne('LANDSAT/LC09/C02/T1_L2', aoi, start, end, cloudPct);
  return l8.merge(l9);
}

function prepareCombined(aoi, start, end, cloudPct) {

  var s2 = prepareSentinel2(aoi, start, end, cloudPct);
  var landsat = prepareLandsat(aoi, start, end, cloudPct);
  return s2.merge(landsat);
}

function getPreparedCollection(sensorKey, aoi, start, end, cloudPct) {
  if (sensorKey === 'S2') return prepareSentinel2(aoi, start, end, cloudPct);
  if (sensorKey === 'LANDSAT') return prepareLandsat(aoi, start, end, cloudPct);
  return prepareCombined(aoi, start, end, cloudPct);
}

// 4. Monthly Composit

function createMonthlyComposite(sensorKey, start, end, aoi, cloudPct, dateLabel) {
  var prepared = getPreparedCollection(sensorKey, aoi, start, end, cloudPct);
  var count = prepared.size();
  var hasData = count.gt(0);

  var placeholder = ee.ImageCollection([
    ee.Image.constant([0, 0, 0]).rename(['R', 'G', 'B'])
      .updateMask(ee.Image.constant(0))
  ]);

  var safeCollection = ee.ImageCollection(
    ee.Algorithms.If(hasData, prepared, placeholder)
  );

  var composite = ee.Image(safeCollection.median()).clip(aoi);

  composite = composite.set({
    date_label: dateLabel,
    image_count: count,
    has_data: hasData,
    sensor: sensorKey,
    month_start: start.millis(),
    month_end: end.millis(),
    'system:time_start': start.millis()
  });

  return composite;
}

function createMonthlyCollection(sensorKey, monthSpecs, aoi, cloudPct) {
  var composites = monthSpecs.map(function (spec) {
    return createMonthlyComposite(
      sensorKey, spec.start, spec.end, aoi, cloudPct, spec.label
    );
  });
  var collection = ee.ImageCollection.fromImages(composites);
  return { composites: composites, collection: collection };
}

// 5. Visualisation

function computeStretch(collection, aoi, scale) {
  var overall = collection.median().clip(aoi);
  return overall.reduceRegion({
    reducer: ee.Reducer.percentile([2, 98]),
    geometry: aoi,
    scale: scale,
    maxPixels: 1e9,
    bestEffort: true
  });
}

function buildVisParams(stretchInfo) {
  var d = 0.3; // sane fallback if a band could not be computed (e.g. fully masked)
  function pick(key, fallback) {
    var v = stretchInfo ? stretchInfo[key] : null;
    return (v === null || v === undefined) ? fallback : v;
  }
  return {
    bands: ['R', 'G', 'B'],
    min: [pick('R_p2', 0), pick('G_p2', 0), pick('B_p2', 0)],
    max: [pick('R_p98', d), pick('G_p98', d), pick('B_p98', d)],
    gamma: 1
  };
}

// 6. Thumbnail Generation

function generateThumbnailURLs(composites, visParams, metaInfo) {

  return composites.map(function (img, i) {
    var hasData = metaInfo.hasData[i];
    var visImage = img.visualize(visParams);
    var thumbnail = hasData
      ? ui.Thumbnail(visImage, { dimensions: PREVIEW_DIMENSIONS, format: 'png' }, { width: '100%' })
      : null;
    return {
      image: visImage,
      thumbnail: thumbnail,
      label: metaInfo.labels[i],
      count: metaInfo.counts[i],
      hasData: hasData
    };
  });
}

//7. UI

var sensorSelect = ui.Select({
  items: Object.keys(SENSOR_MAP),
  value: 'Sentinel-2 (10m)',
  style: { stretch: 'horizontal' }
});

var startMonthSelect = ui.Select({ items: MONTH_NAMES, value: 'January', style: { stretch: 'horizontal' } });
var startYearSelect = ui.Select({ items: YEAR_LIST, value: '2024' });
var endMonthSelect = ui.Select({ items: MONTH_NAMES, value: 'December', style: { stretch: 'horizontal' } });
var endYearSelect = ui.Select({ items: YEAR_LIST, value: '2024' });

var cloudLabel = ui.Label('Cloud threshold: 20%');
var cloudSlider = ui.Slider({ min: 0, max: 100, value: 20, step: 1, style: { stretch: 'horizontal' } });
cloudSlider.onChange(function (value) {
  state.cloudPct = value;
  cloudLabel.setValue('Cloud threshold: ' + value + '%');
});

var rectangleBtn = ui.Button('Rectangle', function () { drawRectangle(); });
var clearBtn = ui.Button('Clear AOI', function () { clearAOI(); });
var aoiStatusLabel = ui.Label('AOI: default example area loaded (draw your own to replace it).');

var generateBtn = ui.Button({
  label: 'GENERATE TIMELAPSE',
  onClick: function () { generateTimelapse(); },
  style: { stretch: 'horizontal' }
});
var statusLabel = ui.Label('', { color: 'gray' });

var controlMonthLabel = ui.Label('Month: —', { fontWeight: 'bold' });
var controlCountLabel = ui.Label('Images used: —');

var prevBtn = ui.Button('◀', function () { stopAnimation(); showFrame(state.currentIndex - 1); });
var playPauseButton = ui.Button('▶ Play', function () {
  if (state.playing) stopAnimation(); else startAnimation();
});
var nextBtn = ui.Button('▶', function () { stopAnimation(); showFrame(state.currentIndex + 1); });

var monthSliderPanel = ui.Panel({ style: { stretch: 'horizontal' } });
var monthSlider = null;

function rebuildMonthSlider(maxIndex) {
  monthSliderPanel.clear();

  var sliderMax = Math.max(maxIndex, 1);
  monthSlider = ui.Slider({
    min: 0, max: sliderMax, value: 0, step: 1,
    style: { stretch: 'horizontal' }
  });
  monthSlider.onChange(function (value) {
    stopAnimation();
    var idx = Math.round(value);
    if (idx > maxIndex) idx = maxIndex;
    showFrame(idx);
  });
  monthSliderPanel.add(monthSlider);
}
rebuildMonthSlider(0);

var speedLabel = ui.Label('Speed: 1.0 sec/frame');
var speedSlider = ui.Slider({ min: 0.3, max: 3.0, value: 1.0, step: 0.1, style: { stretch: 'horizontal' } });
speedSlider.onChange(function (value) {
  state.speed = value;
  var rounded = Math.round(value * 10) / 10; 
  speedLabel.setValue('Speed: ' + rounded + ' sec/frame');
});

// 8. GIF and Export
var EXPORT_QUALITY_MAP = {
  'Standard (720px)': 720,
  'High (1080px)': 1080,
  'Maximum (1920px)': 1920
};
var qualityLabel = ui.Label('Download quality');
var qualitySelect = ui.Select({
  items: Object.keys(EXPORT_QUALITY_MAP),
  value: 'Standard (720px)',
  style: { stretch: 'horizontal' }
});
var qualityHintLabel = ui.Label(
  'Higher quality = larger files and slower rendering. Very high resolution ' +
  'over a large AOI or a long month range can exceed the GIF download\'s size ' +
  'limit — if that happens, drop to Standard, or use "Export to Drive" instead ' +
  '(it runs as a background task with no such limit).',
  { fontSize: '11px', color: 'gray' }
);
var gifBtn = ui.Button('Download Timelapse (GIF)', function () { createGIFPreview(); });
var gifPreviewPanel = ui.Panel();
var gifHintLabel = ui.Label(
  'Opens a direct link from Earth Engine — no Drive needed. ' +
  'Right-click the link (or the image it opens) and choose "Save As" to download.',
  { fontSize: '11px', color: 'gray' }
);
var exportBtn = ui.Button({
  label: 'Export Timelapse to Drive',
  onClick: function () { exportTimelapse(); },
  style: { stretch: 'horizontal' }
});

var showOnMapCheckbox = ui.Checkbox({ label: 'Show current month on map', value: true });
showOnMapCheckbox.onChange(function () { updateMapLayer(); });
var previewMonthLabel = ui.Label('No timelapse generated yet', { fontWeight: 'bold', fontSize: '16px' });
var previewImagePanel = ui.Panel({ style: { stretch: 'horizontal' } });

// 9. Map and AOI

var mapWidget = ui.Map();
mapWidget.style().set({ stretch: 'both' });
mapWidget.setControlVisibility({ drawingToolsControl: false });

var drawingTools = mapWidget.drawingTools();
drawingTools.setShown(false);
drawingTools.setDrawModes(['rectangle', 'polygon']);
drawingTools.layers().reset();

var DEFAULT_AOI = ee.Geometry.Rectangle([-122.55, 37.60, -122.30, 37.85]); // SF Bay Area example
var defaultAoiOutline = ee.FeatureCollection([ee.Feature(DEFAULT_AOI)])
  .style({ color: '1f77ff', fillColor: '00000000', width: 2 }); // transparent fill, outline only
mapWidget.addLayer(defaultAoiOutline, {}, 'Default AOI (draw your own to replace)');
state.aoi = DEFAULT_AOI;
mapWidget.centerObject(DEFAULT_AOI, 9);

function refreshAOIFromDrawingTools() {
  try {
    if (drawingTools.layers().length() === 0) {
      // Nothing drawn yet — keep the current state.aoi (the default AOI)
      // until the user draws their own shape.
      return;
    }
    var layer = drawingTools.layers().get(0);
    var geoms = layer.geometries();
    if (geoms.length() === 0) {
      state.aoi = null;
      aoiStatusLabel.setValue('AOI: none — draw a shape on the map.');
      return;
    }
    state.aoi = layer.getEeObject();
    aoiStatusLabel.setValue('AOI: set (' + geoms.length() + ' shape(s)).');
    mapWidget.layers().reset(); // remove the "Default AOI" visual layer now that the user has their own
    updateMapLayer();
  } catch (e) {
    aoiStatusLabel.setValue('AOI error: ' + e.message);
  }
}

drawingTools.onDraw(function () { refreshAOIFromDrawingTools(); });
drawingTools.onEdit(function () { refreshAOIFromDrawingTools(); });
drawingTools.onErase(function () { refreshAOIFromDrawingTools(); });

function updateMapLayer() {
  mapWidget.layers().reset();
  if (!showOnMapCheckbox.getValue()) return;
  if (state.frames.length === 0) return;
  var frame = state.frames[state.currentIndex];
  if (frame && frame.hasData) {
    // frame.image already has visualize() baked in (0-255 RGB), so no
    // extra vis params are needed here.
    mapWidget.layers().add(ui.Map.Layer(frame.image, {}, frame.label));
  }
}


function drawRectangle() {
  drawingTools.setShape('rectangle');
  drawingTools.draw();
}

function clearAOI() {
  if (drawingTools.layers().length() === 0) {
    state.aoi = null;
    aoiStatusLabel.setValue('AOI: none — draw a shape on the map.');
    return;
  }
  var layer = drawingTools.layers().get(0);
  var geoms = layer.geometries();
  while (geoms.length() > 0) {
    geoms.remove(geoms.get(0));
  }
  state.aoi = null;
  aoiStatusLabel.setValue('AOI: none — draw a shape on the map.');
}

// 10. Frame Disply and Playback

function showFrame(index) {
  if (state.frames.length === 0) return;
  if (index < 0) index = state.frames.length - 1;
  if (index >= state.frames.length) index = 0;
  state.currentIndex = index;

  var frame = state.frames[index];

  previewImagePanel.clear();
  if (frame.hasData && frame.thumbnail) {
    previewImagePanel.add(frame.thumbnail);
  } else if (frame.hasData) {
    // Fallback in case the pre-built widget is ever missing.
    previewImagePanel.add(ui.Thumbnail(
      frame.image, { dimensions: PREVIEW_DIMENSIONS, format: 'png' }, { width: '100%' }
    ));
  } else {
    previewImagePanel.add(ui.Label('NO VALID IMAGERY', {
      color: 'red', fontWeight: 'bold', margin: '60px 0 0 0'
    }));
  }

  controlMonthLabel.setValue('Month: ' + frame.label);
  controlCountLabel.setValue(
    'Images used: ' + frame.count +
    (frame.hasData ? '' : '  (no valid imagery)')
  );
  previewMonthLabel.setValue(frame.label);
  updateMapLayer();

  if (monthSlider) monthSlider.setValue(index, false);
}

function startAnimation() {
  if (state.frames.length === 0) return;
  state.playing = true;
  playPauseButton.setLabel('⏸ Pause');
  animateStep();
}

function animateStep() {
  if (!state.playing) return;
  var next = (state.currentIndex + 1) % state.frames.length;
  showFrame(next);
  state.timerId = ui.util.setTimeout(animateStep, state.speed * 1000);
}

function stopAnimation() {
  state.playing = false;
  playPauseButton.setLabel('▶ Play');
  if (state.timerId) {
    ui.util.clearTimeout(state.timerId);
    state.timerId = null;
  }
}

// 11. Date Selector

function buildMonthSpecs(startMonthName, startYearStr, endMonthName, endYearStr) {
  var startIdx = MONTH_NAMES.indexOf(startMonthName) + 1;
  var endIdx = MONTH_NAMES.indexOf(endMonthName) + 1;
  var sy = parseInt(startYearStr, 10);
  var ey = parseInt(endYearStr, 10);

  if (sy > ey || (sy === ey && startIdx > endIdx)) {
    return [];
  }

  var specs = [];
  var y = sy, m = startIdx;
  while (y < ey || (y === ey && m <= endIdx)) {
    var start = ee.Date.fromYMD(y, m, 1);
    var end = start.advance(1, 'month');
    specs.push({
      year: y, month: m, start: start, end: end,
      label: MONTH_NAMES[m - 1] + ' ' + y
    });
    m++;
    if (m > 12) { m = 1; y++; }
    if (specs.length > MAX_MONTHS + 1) break; // safety valve
  }
  return specs;
}

// 12. Main Generate Timelaps

function generateTimelapse() {
  stopAnimation();

  if (!state.aoi) {
    statusLabel.setValue('Please draw an AOI before generating.');
    return;
  }

  var sensorKey = SENSOR_MAP[sensorSelect.getValue()];
  var specs = buildMonthSpecs(
    startMonthSelect.getValue(), startYearSelect.getValue(),
    endMonthSelect.getValue(), endYearSelect.getValue()
  );

  if (specs.length === 0) {
    statusLabel.setValue('End date must be on or after start date.');
    return;
  }
  if (specs.length > MAX_MONTHS) {
    statusLabel.setValue('Range too long (max ' + MAX_MONTHS + ' months). Please narrow the range.');
    return;
  }

  statusLabel.setValue('Generating ' + specs.length + ' monthly composite(s)... please wait.');
  gifPreviewPanel.clear();

  // Yield to the UI thread briefly so the status label repaints before the
  // (blocking) Earth Engine calls below run.
  ui.util.setTimeout(function () {
    runGeneration(sensorKey, specs);
  }, 50);
}

function runGeneration(sensorKey, specs) {
  try {
    var aoi = state.aoi;
    var cloudPct = state.cloudPct;
    var scale = SCALE_MAP[sensorKey];

    var built = createMonthlyCollection(sensorKey, specs, aoi, cloudPct);
    var composites = built.composites;
    var collection = built.collection;

    var stretchDict = computeStretch(collection, aoi, scale);
    var metaDict = ee.Dictionary({
      labels: collection.aggregate_array('date_label'),
      counts: collection.aggregate_array('image_count'),
      hasData: collection.aggregate_array('has_data')
    });

    // Single combined server round-trip for both the stretch and all metadata.
    var combined = ee.Dictionary({ stretch: stretchDict, meta: metaDict }).getInfo();

    var visParams = buildVisParams(combined.stretch);
    var frames = generateThumbnailURLs(composites, visParams, combined.meta);

    state.sensor = sensorKey;
    state.composites = composites;
    state.collection = collection;
    state.visParams = visParams;
    state.frames = frames;
    state.currentIndex = 0;

    rebuildMonthSlider(frames.length - 1);
    statusLabel.setValue('Timelapse ready: ' + frames.length + ' month(s).');
    showFrame(0);
  } catch (err) {
    statusLabel.setValue('Error generating timelapse: ' + err.message);
  }
}

// 13. GIF Preview and Export

function createGIFPreview() {
  if (!state.collection || state.frames.length === 0) {
    statusLabel.setValue('Generate a timelapse first.');
    return;
  }
  gifPreviewPanel.clear();
  gifPreviewPanel.add(ui.Label('Building GIF...', { color: 'gray' }));

  ui.util.setTimeout(function () {
    try {
      var visCollection = state.collection.map(function (img) {
        return img.visualize(state.visParams);
      });
      var fps = Math.max(1, Math.round(1 / state.speed));
      var gifDims = EXPORT_QUALITY_MAP[qualitySelect.getValue()];
      var gifUrl = visCollection.getVideoThumbURL({
        dimensions: gifDims,
        region: state.aoi,
        framesPerSecond: fps,
        format: 'gif',
        crs: 'EPSG:3857'
      });
      gifPreviewPanel.clear();
      gifPreviewPanel.add(ui.Label('▶ Open / Download GIF', { color: 'blue', fontWeight: 'bold' }, gifUrl));
    } catch (e) {
      gifPreviewPanel.clear();
      gifPreviewPanel.add(ui.Label('GIF generation failed: ' + e.message, { color: 'red' }));
    }
  }, 50);
}

function exportTimelapse() {
  if (!state.collection || state.frames.length === 0) {
    statusLabel.setValue('Generate a timelapse first.');
    return;
  }
  var visCollection = state.collection.map(function (img) {
    return img.visualize(state.visParams).copyProperties(img, ['system:time_start']);
  });
  var fps = Math.max(1, Math.round(1 / state.speed));
  var videoDims = EXPORT_QUALITY_MAP[qualitySelect.getValue()];

  Export.video.toDrive({
    collection: visCollection,
    description: 'GEE_Timelapse_Export',
    folder: 'GEE_Timelapse',
    fileNamePrefix: 'timelapse_' + state.sensor + '_' + Date.now(),
    framesPerSecond: fps,
    dimensions: videoDims,
    region: state.aoi,
    crs: 'EPSG:3857'
  });

  statusLabel.setValue('Export task created — open the Tasks tab (top right) and click Run to start the Drive export.');
}

// 14. layout

var controlPanel = ui.Panel({
  style: { width: '340px', padding: '8px', stretch: 'vertical' }
});

controlPanel.add(ui.Label('Monthly Satellite Timelapse', { fontWeight: 'bold', fontSize: '16px' }));

controlPanel.add(ui.Label('Satellite', { fontWeight: 'bold' }));
controlPanel.add(sensorSelect);

controlPanel.add(ui.Label('Start Month / Year', { fontWeight: 'bold' }));
controlPanel.add(ui.Panel([startMonthSelect, startYearSelect], ui.Panel.Layout.Flow('horizontal')));

controlPanel.add(ui.Label('End Month / Year', { fontWeight: 'bold' }));
controlPanel.add(ui.Panel([endMonthSelect, endYearSelect], ui.Panel.Layout.Flow('horizontal')));

controlPanel.add(cloudLabel);
controlPanel.add(cloudSlider);

controlPanel.add(ui.Label('Area of Interest', { fontWeight: 'bold' }));
controlPanel.add(ui.Panel([rectangleBtn, clearBtn], ui.Panel.Layout.Flow('horizontal')));
controlPanel.add(aoiStatusLabel);

controlPanel.add(generateBtn);
controlPanel.add(statusLabel);

controlPanel.add(ui.Panel([], ui.Panel.Layout.Flow('horizontal'), { border: '1px solid #ccc', margin: '8px 0' }));

controlPanel.add(controlMonthLabel);
controlPanel.add(controlCountLabel);
controlPanel.add(ui.Panel([prevBtn, playPauseButton, nextBtn], ui.Panel.Layout.Flow('horizontal')));
controlPanel.add(monthSliderPanel);
controlPanel.add(showOnMapCheckbox);

controlPanel.add(speedLabel);
controlPanel.add(speedSlider);

controlPanel.add(qualityLabel);
controlPanel.add(qualitySelect);
controlPanel.add(qualityHintLabel);
controlPanel.add(gifBtn);
controlPanel.add(gifHintLabel);
controlPanel.add(gifPreviewPanel);
controlPanel.add(ui.Label('— or, for a higher-resolution MP4 —', { fontSize: '11px', color: 'gray' }));
controlPanel.add(exportBtn);

// Display Area
var mapContainer = ui.Panel({
  widgets: [mapWidget],
  layout: ui.Panel.Layout.Flow('vertical'),
  style: { width: '30%', height: '100%', stretch: 'both' }
});

var previewContainer = ui.Panel({
  layout: ui.Panel.Layout.Flow('vertical'),
  style: { width: '70%', padding: '8px', stretch: 'both' }
});
previewContainer.add(previewMonthLabel);
previewContainer.add(previewImagePanel);

var displayArea = ui.Panel({
  layout: ui.Panel.Layout.Flow('horizontal'),
  style: { stretch: 'both' }
});
displayArea.add(mapContainer);
displayArea.add(previewContainer);

var rootPanel = ui.Panel({
  layout: ui.Panel.Layout.Flow('horizontal'),
  style: { stretch: 'both' }
});
rootPanel.add(controlPanel);
rootPanel.add(displayArea);

ui.root.clear();
ui.root.add(rootPanel);
