/**
 * Regression coverage for the exact sharp API surface used in
 * src/tools/pdf/extract-images.ts (raw-pixel-buffer input from a PDF's
 * decoded image object, optional resize, jpeg/webp encode to base64).
 *
 * Written specifically to validate the sharp dependency-security upgrade
 * (P3.2): this function processes image data extracted from user-supplied
 * PDFs, i.e. untrusted input reaches sharp/libvips directly, which is what
 * makes the sharp CVEs in <0.35.0 actually reachable in this codebase
 * (unlike most of the other remaining audit findings, which sit behind
 * devDependency-only or install-time-only code paths). This test exists to
 * prove the upgrade doesn't change this function's behavior, not to
 * re-validate the CVE fix itself (that's sharp/libvips's job upstream).
 */
import assert from 'node:assert/strict';
import { convertRawImageToBase64 } from '../dist/tools/pdf/extract-images.js';

function makeRawRgb(width, height, fill = [255, 0, 0]) {
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    buf[i * channels] = fill[0];
    buf[i * channels + 1] = fill[1];
    buf[i * channels + 2] = fill[2];
  }
  return new Uint8ClampedArray(buf);
}

async function testWebpConversionRoundTrips() {
  console.log('\n--- Test: raw RGB buffer converts to a valid webp base64 image ---');
  const width = 40, height = 30;
  const raw = makeRawRgb(width, height, [10, 20, 30]);

  const result = await convertRawImageToBase64(raw, width, height, 3, { format: 'webp', quality: 90 });

  assert.ok(result, 'conversion must succeed for a well-formed raw RGB buffer');
  assert.equal(result.mimeType, 'image/webp');
  assert.match(result.data, /^[A-Za-z0-9+/]+=*$/, 'data must be valid base64');

  const decoded = Buffer.from(result.data, 'base64');
  assert.ok(decoded.length > 0, 'decoded webp buffer must be non-empty');
  // WEBP files start with 'RIFF' (bytes 0-3) and 'WEBP' (bytes 8-11).
  assert.equal(decoded.toString('ascii', 0, 4), 'RIFF');
  assert.equal(decoded.toString('ascii', 8, 12), 'WEBP');

  console.log('ok: webp output is well-formed');
}

async function testJpegConversionRoundTrips() {
  console.log('\n--- Test: raw RGB buffer converts to a valid jpeg base64 image ---');
  const width = 50, height = 50;
  const raw = makeRawRgb(width, height, [200, 150, 100]);

  const result = await convertRawImageToBase64(raw, width, height, 3, { format: 'jpeg', quality: 80 });

  assert.ok(result);
  assert.equal(result.mimeType, 'image/jpeg');
  const decoded = Buffer.from(result.data, 'base64');
  // JPEG files start with the SOI marker 0xFFD8.
  assert.equal(decoded[0], 0xff);
  assert.equal(decoded[1], 0xd8);

  console.log('ok: jpeg output is well-formed');
}

async function testResizeAppliedForLargeImages() {
  console.log('\n--- Test: images larger than maxDimension are resized before encoding ---');
  const width = 2000, height = 1000;
  const raw = makeRawRgb(width, height);

  const result = await convertRawImageToBase64(raw, width, height, 3, { format: 'webp', maxDimension: 500 });
  assert.ok(result);

  // Decode dimensions back out via sharp itself to confirm the resize
  // actually took effect (not just that encoding succeeded).
  const sharp = (await import('sharp')).default;
  const decodedBuffer = Buffer.from(result.data, 'base64');
  const metadata = await sharp(decodedBuffer).metadata();
  assert.equal(metadata.width, 500, 'width must be scaled down to maxDimension');
  assert.equal(metadata.height, 250, 'height must scale proportionally (2:1 aspect ratio preserved)');

  console.log(`ok: resized to ${metadata.width}x${metadata.height} (from ${width}x${height})`);
}

async function testNoResizeForSmallImages() {
  console.log('\n--- Test: images at or under maxDimension are not resized ---');
  const width = 100, height = 80;
  const raw = makeRawRgb(width, height);

  const result = await convertRawImageToBase64(raw, width, height, 3, { format: 'webp', maxDimension: 1200 });
  assert.ok(result);

  const sharp = (await import('sharp')).default;
  const metadata = await sharp(Buffer.from(result.data, 'base64')).metadata();
  assert.equal(metadata.width, width);
  assert.equal(metadata.height, height);

  console.log('ok: small images pass through at original dimensions');
}

async function testGrayscaleChannelCount() {
  console.log('\n--- Test: single-channel (grayscale) raw buffers are handled ---');
  const width = 20, height = 20;
  const buf = Buffer.alloc(width * height, 128);
  const raw = new Uint8ClampedArray(buf);

  const result = await convertRawImageToBase64(raw, width, height, 1, { format: 'webp' });
  assert.ok(result, 'grayscale (1-channel) input must convert successfully');

  console.log('ok: 1-channel raw buffer converts successfully');
}

async function testMalformedInputFailsClosedNotThrows() {
  console.log('\n--- Test: a buffer too short for its declared dimensions fails closed (returns null) ---');
  // Declares 100x100x3 channels but supplies far fewer bytes than that
  // requires — this is what "invalid/corrupt image data extracted from a
  // hostile PDF" looks like from this function's point of view.
  const raw = new Uint8ClampedArray(10);

  const result = await convertRawImageToBase64(raw, 100, 100, 3, { format: 'webp' });
  assert.equal(result, null, 'malformed input must return null (per this function\'s own try/catch), never throw');

  console.log('ok: malformed input returns null rather than throwing or crashing');
}

export default async function runTests() {
  try {
    await testWebpConversionRoundTrips();
    await testJpegConversionRoundTrips();
    await testResizeAppliedForLargeImages();
    await testNoResizeForSmallImages();
    await testGrayscaleChannelCount();
    await testMalformedInputFailsClosedNotThrows();

    console.log('\nSharp image conversion tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Sharp image conversion test failed:', message);
    if (error instanceof Error && error.stack) console.error(error.stack);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => process.exit(success ? 0 : 1));
}
