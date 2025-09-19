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
