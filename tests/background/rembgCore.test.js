import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    applyMask,
    buildModelInput,
    cutoutFromPrediction,
    predictionToMask,
    resizeLanczos
} from '../../src/background/rembgCore.js';
import { REMBG_MODELS, getRembgModel } from '../../src/background/rembgModels.js';

// Expected values come from Pillow 12 (Image.resize with Resampling.LANCZOS),
// which is what rembg uses.
const PILLOW = {
    rgb: [78, 204, 64, 34, 16, 250, 233, 32, 103, 122, 13, 204, 138, 172, 208, 127, 124, 100, 12, 151, 222, 203, 251, 153, 211, 235, 80, 182, 176, 41, 88, 7, 141, 241, 73, 124, 223, 123, 222, 37, 84, 55, 200, 102, 211, 60, 159, 237, 53, 138, 57, 140, 55, 21, 7, 18, 118, 67, 241, 138, 148, 221, 56, 33, 89, 208, 34, 193, 76, 167, 197, 242, 177, 243, 188, 250, 92, 195, 51, 159, 144, 36, 75, 222, 86, 85, 118, 94, 59, 57, 79, 37, 219, 116, 234, 130, 213, 138, 152, 113, 99, 19, 176, 169, 19],
    rgbTo3x4: [114, 121, 128, 177, 60, 173, 99, 133, 171, 179, 206, 131, 116, 64, 77, 136, 133, 120, 65, 146, 185, 138, 152, 143, 73, 146, 157, 70, 83, 117, 157, 164, 178, 149, 124, 73],
    gray: [119, 163, 122, 70, 255, 89, 16, 219, 40, 224, 81, 35],
    grayTo9x7: [80, 102, 144, 183, 186, 147, 92, 51, 28, 133, 143, 151, 150, 135, 112, 97, 92, 90, 220, 208, 162, 98, 50, 53, 104, 158, 191, 255, 239, 172, 77, 0, 8, 98, 193, 251, 156, 172, 170, 137, 68, 32, 71, 133, 172, 37, 88, 163, 209, 162, 79, 47, 54, 62, 0, 37, 158, 252, 218, 108, 33, 7, 0]
};

test('Lanczos downscaling matches Pillow exactly', () => {
    const out = resizeLanczos(Uint8Array.from(PILLOW.rgb), 7, 5, 3, 3, 4);
    assert.deepEqual([...out], PILLOW.rgbTo3x4);
});

test('Lanczos upscaling matches Pillow exactly', () => {
    const out = resizeLanczos(Uint8Array.from(PILLOW.gray), 4, 3, 1, 9, 7);
    assert.deepEqual([...out], PILLOW.grayTo9x7);
});

test('resizing to the same size copies the pixels', () => {
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resizeLanczos(src, 2, 2, 1, 2, 2);
    assert.deepEqual([...out], [1, 2, 3, 4]);
    assert.notEqual(out, src);
});

test('a flat image stays flat at any size', () => {
    const src = new Uint8Array(40 * 30 * 3).fill(173);
    for (const [w, h] of [[320, 320], [7, 3], [41, 29]]) {
        const out = resizeLanczos(src, 40, 30, 3, w, h);
        assert.equal(out.length, w * h * 3);
        assert.ok(out.every((value) => value === 173), `${w}x${h}`);
    }
});

test('model input is scaled by the brightest sample, normalised and laid out as NCHW', () => {
    // 2x2 RGBA image already at the model size, so no resampling happens.
    const rgba = Uint8Array.from([
        200, 100, 50, 255, 0, 0, 0, 255,
        100, 100, 100, 0, 50, 25, 200, 255
    ]);
    const spec = { size: 2, mean: [0.5, 0.25, 0], std: [0.5, 1, 2] };
    const input = buildModelInput(rgba, 2, 2, spec);
    const expected = [];
    for (let c = 0; c < 3; c++) {
        for (let i = 0; i < 4; i++) {
            expected.push((rgba[i * 4 + c] / 200 - spec.mean[c]) / spec.std[c]);
        }
    }
    assert.equal(input.length, 12);
    expected.forEach((value, index) => assert.ok(Math.abs(input[index] - value) < 1e-6, `index ${index}`));
});

test('a black image does not divide by zero', () => {
    const input = buildModelInput(new Uint8Array(4 * 4 * 4), 4, 4, REMBG_MODELS.fast);
    assert.equal(input.length, 3 * 320 * 320);
    assert.ok(input.every(Number.isFinite));
});

test('predictions are stretched to 0-255 and truncated like numpy', () => {
    const { mask, width, height } = predictionToMask(Float32Array.from([0.2, 0.4, 0.6, 1.0]), [1, 1, 2, 2]);
    assert.equal(width, 2);
    assert.equal(height, 2);
    assert.deepEqual([...mask], [0, 63, 127, 255]);
});

test('only the first channel of the first output is used', () => {
    const output = Float32Array.from([0, 1, 1, 0, /* channel 1 */ 5, 5, 5, 5]);
    const { mask } = predictionToMask(output, [1, 2, 2, 2]);
    assert.deepEqual([...mask], [0, 255, 255, 0]);
});

test('sigmoid outputs are squashed before stretching', () => {
    const { mask } = predictionToMask(Float32Array.from([-10, 0, 10]), [1, 1, 1, 3], { sigmoid: true });
    assert.equal(mask[0], 0);
    assert.ok(Math.abs(mask[1] - 127) <= 1);
    assert.equal(mask[2], 255);
});

test('a flat prediction gives an empty mask instead of NaN', () => {
    const { mask } = predictionToMask(new Float32Array(9).fill(0.7), [1, 1, 3, 3]);
    assert.ok(mask.every((value) => value === 0));
});

test('the mask becomes alpha, keeps colours, and respects existing transparency', () => {
    const rgba = Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128]);
    const out = applyMask(rgba, Uint8Array.from([255, 0, 255]));
    assert.deepEqual([...out], [10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 128]);
});

test('a prediction is turned into a full-size cutout', () => {
    const width = 6;
    const height = 4;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    // Left half background, right half subject.
    const output = Float32Array.from([0, 0, 1, 1, 0, 0, 1, 1]);
    const { mask, cutout } = cutoutFromPrediction(rgba, width, height, output, [1, 1, 2, 4], REMBG_MODELS.fast);
    assert.equal(mask.length, width * height);
    assert.equal(cutout.length, width * height * 4);
    assert.ok(mask[0] < 30, 'left edge is background');
    assert.ok(mask[width - 1] > 225, 'right edge is subject');
    assert.equal(cutout[3], mask[0]);
});

test('model settings match rembg', () => {
    const rembg = {
        fast: { rembgName: 'u2netp', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], md5: '8e83ca70e441ab06c318d82300c84806' },
        best: { rembgName: 'isnet-general-use', size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], md5: 'fc16ebd8b0c10d971d3513d564d01e29' }
    };
    for (const [id, expected] of Object.entries(rembg)) {
        const model = REMBG_MODELS[id];
        assert.equal(model.rembgName, expected.rembgName);
        assert.equal(model.size, expected.size);
        assert.deepEqual([...model.mean], expected.mean);
        assert.deepEqual([...model.std], expected.std);
        assert.equal(model.md5, expected.md5);
        assert.equal(model.url, `https://github.com/danielgatis/rembg/releases/download/v0.0.0/${model.file}`);
    }
    assert.equal(getRembgModel('nope'), REMBG_MODELS.fast);
});

test('every page links to the background remover, and the deploy fetches its models', () => {
    for (const page of ['dev-preview.html', 'video-preview.html', 'pricing.html', 'background.html']) {
        const html = readFileSync(new URL(`../../public/${page}`, import.meta.url), 'utf8');
        assert.match(html, /<a href="\.\/background\.html" class="nav-link"[^>]*>Background<\/a>/, page);
    }
    const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
    assert.match(vercel.buildCommand, /node scripts\/fetch-rembg-models\.js/);
});
