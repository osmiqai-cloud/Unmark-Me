// rembg's image pipeline, ported to typed arrays so it runs in a browser worker
// and in Node tests. The model call itself lives in the worker.
//
// Ported from rembg (https://github.com/danielgatis/rembg):
//   sessions/base.py  BaseSession.normalize   -> buildModelInput
//   sessions/*.py     predict (min-max mask)  -> predictionToMask
//   bg.py             putalpha_cutout         -> applyMask
// rembg is MIT licensed, Copyright (c) 2020 Daniel Gatis.
//
// rembg resizes with Pillow's LANCZOS filter. resizeLanczos reproduces
// Pillow's 8-bit resampler (Resample.c): the same kernel, support, coefficient
// rounding and horizontal-then-vertical passes, so the model sees the same
// pixels it would under rembg.

const LANCZOS_SUPPORT = 3;
const PRECISION_BITS = 32 - 8 - 2;
const FIXED_ONE = 2 ** PRECISION_BITS;
const FIXED_HALF = 2 ** (PRECISION_BITS - 1);

function sinc(x) {
    if (x === 0) return 1;
    const px = x * Math.PI;
    return Math.sin(px) / px;
}

function lanczos(x) {
    return x >= -LANCZOS_SUPPORT && x < LANCZOS_SUPPORT
        ? sinc(x) * sinc(x / LANCZOS_SUPPORT)
        : 0;
}

// Pillow's precompute_coeffs + normalize_coeffs_8bpc.
function computeCoefficients(inSize, outSize) {
    const scale = inSize / outSize;
    const filterScale = Math.max(scale, 1);
    const support = LANCZOS_SUPPORT * filterScale;
    const taps = Math.ceil(support) * 2 + 1;
    const ss = 1 / filterScale;
    const starts = new Int32Array(outSize);
    const counts = new Int32Array(outSize);
    const weights = new Float64Array(outSize * taps);

    for (let xx = 0; xx < outSize; xx++) {
        const center = (xx + 0.5) * scale;
        const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
        const count = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
        const base = xx * taps;
        let total = 0;
        for (let x = 0; x < count; x++) {
            const w = lanczos((x + xmin - center + 0.5) * ss);
            weights[base + x] = w;
            total += w;
        }
        for (let x = 0; x < count; x++) {
            const w = total !== 0 ? weights[base + x] / total : weights[base + x];
            weights[base + x] = Math.trunc(w < 0 ? w * FIXED_ONE - 0.5 : w * FIXED_ONE + 0.5);
        }
        starts[xx] = xmin;
        counts[xx] = count;
    }
    return { starts, counts, weights, taps };
}

function clip8(sum) {
    const value = Math.floor(sum / FIXED_ONE);
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

function resampleHorizontal(src, width, height, channels, outWidth) {
    const { starts, counts, weights, taps } = computeCoefficients(width, outWidth);
    const out = new Uint8Array(outWidth * height * channels);
    for (let y = 0; y < height; y++) {
        const row = y * width * channels;
        const outRow = y * outWidth * channels;
        for (let xx = 0; xx < outWidth; xx++) {
            const start = starts[xx];
            const count = counts[xx];
            const base = xx * taps;
            for (let c = 0; c < channels; c++) {
                let sum = FIXED_HALF;
                let index = row + start * channels + c;
                for (let x = 0; x < count; x++, index += channels) {
                    sum += src[index] * weights[base + x];
                }
                out[outRow + xx * channels + c] = clip8(sum);
            }
        }
    }
    return out;
}

function resampleVertical(src, width, height, channels, outHeight) {
    const { starts, counts, weights, taps } = computeCoefficients(height, outHeight);
    const stride = width * channels;
    const out = new Uint8Array(stride * outHeight);
    const sums = new Float64Array(stride);
    for (let yy = 0; yy < outHeight; yy++) {
        sums.fill(FIXED_HALF);
        const start = starts[yy];
        const count = counts[yy];
        const base = yy * taps;
        for (let y = 0; y < count; y++) {
            const weight = weights[base + y];
            const row = (start + y) * stride;
            for (let i = 0; i < stride; i++) {
                sums[i] += src[row + i] * weight;
            }
        }
        const outRow = yy * stride;
        for (let i = 0; i < stride; i++) {
            out[outRow + i] = clip8(sums[i]);
        }
    }
    return out;
}

// Resize interleaved 8-bit samples (`channels` per pixel) with Lanczos.
export function resizeLanczos(src, width, height, channels, outWidth, outHeight) {
    let data = src;
    if (outWidth !== width) {
        data = resampleHorizontal(data, width, height, channels, outWidth);
    }
    if (outHeight !== height) {
        data = resampleVertical(data, outWidth, height, channels, outHeight);
    }
    return data === src ? Uint8Array.from(src) : data;
}

export function rgbaToRgb(rgba, width, height) {
    const pixels = width * height;
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0, j = 0; i < pixels; i++, j += 4) {
        rgb[i * 3] = rgba[j];
        rgb[i * 3 + 1] = rgba[j + 1];
        rgb[i * 3 + 2] = rgba[j + 2];
    }
    return rgb;
}

// BaseSession.normalize: resize to the model's square input, scale by the
// brightest sample, subtract the mean, divide by the std, lay out as NCHW.
export function buildModelInput(rgba, width, height, { size, mean, std }) {
    const resized = resizeLanczos(rgbaToRgb(rgba, width, height), width, height, 3, size, size);
    let max = 0;
    for (let i = 0; i < resized.length; i++) {
        if (resized[i] > max) max = resized[i];
    }
    const scale = Math.max(max, 1e-6);
    const plane = size * size;
    const input = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) {
            input[c * plane + i] = (resized[i * 3 + c] / scale - mean[c]) / std[c];
        }
    }
    return input;
}

// predict(): first output, first channel, optional sigmoid, then stretch to
// 0-255. The math runs in float32 like the numpy original.
export function predictionToMask(output, dims, { sigmoid = false } = {}) {
    const height = dims[dims.length - 2];
    const width = dims[dims.length - 1];
    const plane = width * height;
    const pred = new Float32Array(plane);
    for (let i = 0; i < plane; i++) {
        pred[i] = sigmoid ? 1 / (1 + Math.exp(-output[i])) : output[i];
    }
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < plane; i++) {
        if (pred[i] < min) min = pred[i];
        if (pred[i] > max) max = pred[i];
    }
    const range = Math.fround(max - min);
    const mask = new Uint8Array(plane);
    if (!(range > 0)) {
        return { mask, width, height };
    }
    for (let i = 0; i < plane; i++) {
        const normalized = Math.fround(Math.fround(pred[i] - min) / range);
        const value = Math.trunc(Math.fround(normalized * 255));
        mask[i] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
    return { mask, width, height };
}

// putalpha_cutout: keep every colour and use the mask as alpha. Pixels that
// were already transparent in the original stay transparent.
export function applyMask(rgba, mask) {
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0, j = 0; j < rgba.length; i++, j += 4) {
        out[j] = rgba[j];
        out[j + 1] = rgba[j + 1];
        out[j + 2] = rgba[j + 2];
        out[j + 3] = Math.round((mask[i] * rgba[j + 3]) / 255);
    }
    return out;
}

// rembg's mask at the image's size: model output -> 0-255 mask -> Lanczos resize.
export function maskFromPrediction(width, height, output, dims, model) {
    const small = predictionToMask(output, dims, model);
    return resizeLanczos(small.mask, small.width, small.height, 1, width, height);
}

// The whole of rembg's remove() after the model call, unrefined.
export function cutoutFromPrediction(rgba, width, height, output, dims, model) {
    const mask = maskFromPrediction(width, height, output, dims, model);
    return { mask, cutout: applyMask(rgba, mask) };
}
