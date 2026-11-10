// Background removal off the main thread: loads a rembg model, runs it with
// onnxruntime-web (WebGPU when the browser has it, otherwise WebAssembly),
// cleans up the mask (matteRefine.js) and returns the cutout. Nothing leaves
// the device.
//
// Messages in:  { type: 'remove', id, modelId, bitmap }   (bitmap is transferred)
// Messages out: { type: 'progress', id, stage, loaded?, total? }
//               { type: 'result', id, width, height, cutout, provider, timings }
//               { type: 'error', id, message, code }

import { getRembgModel } from '../background/rembgModels.js';
import { applyMask, buildModelInput, maskFromPrediction } from '../background/rembgCore.js';
import { refineCutout } from '../background/matteRefine.js';

const CACHE_NAME = 'unmark-me-rembg-models-v1';
const assetUrl = (path) => new URL(path, self.location.href).href;

const WASM_PATHS = Object.freeze({
    mjs: assetUrl('../onnxruntime/ort-wasm-simd-threaded.mjs'),
    wasm: assetUrl('../onnxruntime/ort-wasm-simd-threaded.wasm')
});
const WEBGPU_WASM_PATHS = Object.freeze({
    mjs: assetUrl('../onnxruntime/ort-wasm-simd-threaded.asyncify.mjs'),
    wasm: assetUrl('../onnxruntime/ort-wasm-simd-threaded.asyncify.wasm')
});

const runtimes = new Map();
let webgpuBroken = false;
// Progress goes to the newest request, even when it reuses a model download
// that an earlier request started.
let reportProgress = () => {};

class WorkerError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function now() {
    return performance.now();
}

function threadCount() {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return 1;
    const cores = Number(self.navigator?.hardwareConcurrency) || 2;
    return Math.max(1, Math.min(8, cores - 1));
}

// Models are cached with the Cache API so the large one downloads only once.
async function loadModelBytes(model, onProgress) {
    const url = assetUrl(`../models/rembg/${model.file}`);
    const cacheKey = `${url}?md5=${model.md5}`;
    let cache = null;
    try {
        cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(cacheKey);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch {
        cache = null;
    }

    let response;
    try {
        response = await fetch(url);
    } catch {
        throw new WorkerError('model-network', 'The AI model could not be downloaded. Check your connection and try again.');
    }
    if (!response.ok || !response.body) {
        throw new WorkerError('model-missing', `The ${model.label} model isn't available on this server.`);
    }

    // The size is known up front, so progress works even if the response is compressed.
    let bytes = new Uint8Array(model.bytes);
    let loaded = 0;
    const reader = response.body.getReader();
    let lastReport = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.length > bytes.length) {
            const grown = new Uint8Array(Math.max(bytes.length * 2, loaded + value.length));
            grown.set(bytes.subarray(0, loaded));
            bytes = grown;
        }
        bytes.set(value, loaded);
        loaded += value.length;
        const time = now();
        if (time - lastReport > 80) {
            lastReport = time;
            onProgress(Math.min(loaded, model.bytes), model.bytes);
        }
    }
    if (loaded !== bytes.length) bytes = bytes.slice(0, loaded);
    onProgress(model.bytes, model.bytes);

    try {
        await cache?.put(cacheKey, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
        // Out of quota or private mode: it simply downloads again next time.
    }
    return bytes;
}

function configureOrt(ort, wasmPaths, numThreads) {
    ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = numThreads;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
}

async function createWebGpuSession(bytes) {
    const ort = await import('onnxruntime-web/webgpu');
    // The GPU does the work; one CPU thread is enough for the few ops it hands back.
    configureOrt(ort, WEBGPU_WASM_PATHS, 1);
    if (ort.env.webgpu) ort.env.webgpu.powerPreference = 'high-performance';
    const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all'
    });
    return { ort, session, provider: 'webgpu' };
}

async function createWasmSession(bytes) {
    const ort = await import('onnxruntime-web/wasm');
    configureOrt(ort, WASM_PATHS, threadCount());
    const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
    });
    return { ort, session, provider: 'wasm' };
}

async function createRuntime(model) {
    const bytes = await loadModelBytes(model, (loaded, total) => reportProgress('download', { loaded, total }));
    reportProgress('starting');
    if (self.navigator?.gpu && !webgpuBroken) {
        try {
            return await createWebGpuSession(bytes);
        } catch (error) {
            webgpuBroken = true;
            console.warn('WebGPU background removal unavailable, using WebAssembly:', error);
        }
    }
    return createWasmSession(bytes);
}

function getRuntime(model) {
    if (!runtimes.has(model.id)) {
        const promise = createRuntime(model);
        runtimes.set(model.id, promise);
        promise.catch(() => runtimes.delete(model.id));
    }
    return runtimes.get(model.id);
}

async function predict(runtime, model, input) {
    const { ort, session } = runtime;
    const tensor = new ort.Tensor('float32', input, [1, 3, model.size, model.size]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const output = outputs[session.outputNames[0]];
    const data = output.location && output.location !== 'cpu' ? await output.getData() : output.data;
    const dims = [...output.dims];
    for (const value of Object.values(outputs)) value.dispose?.();
    return { data, dims };
}

async function removeBackground({ id, modelId, bitmap, refine = true }) {
    const model = getRembgModel(modelId);
    const report = (stage, extra = {}) => self.postMessage({ type: 'progress', id, stage, ...extra });
    reportProgress = report;
    const timings = {};
    const started = now();

    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = context.getImageData(0, 0, width, height).data;

    let runtime = await getRuntime(model);
    timings.load = now() - started;

    report('removing');
    let mark = now();
    const input = buildModelInput(rgba, width, height, model);
    let prediction;
    try {
        prediction = await predict(runtime, model, input);
    } catch (error) {
        if (runtime.provider !== 'webgpu') throw error;
        // Some GPUs create the session but fail to run it; finish on the CPU.
        console.warn('WebGPU run failed, retrying with WebAssembly:', error);
        webgpuBroken = true;
        runtimes.delete(model.id);
        runtime = await getRuntime(model);
        prediction = await predict(runtime, model, input);
    }
    timings.model = now() - mark;

    mark = now();
    const mask = maskFromPrediction(width, height, prediction.data, prediction.dims, model);
    // Clean up the mask using the photo's colours (matteRefine.js); `refine:
    // false` returns rembg's raw cutout, for comparisons.
    const cutout = refine ? refineCutout(rgba, width, height, mask).cutout : applyMask(rgba, mask);
    timings.finish = now() - mark;
    timings.total = now() - started;

    self.postMessage(
        { type: 'result', id, width, height, cutout: cutout.buffer, provider: runtime.provider, timings },
        [cutout.buffer]
    );
}

self.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type !== 'remove') return;
    removeBackground(message).catch((error) => {
        console.error('Background removal failed:', error);
        self.postMessage({
            type: 'error',
            id: message.id,
            code: error?.code || 'failed',
            detail: String(error?.message || error).slice(0, 300),
            message: error instanceof WorkerError
                ? error.message
                : 'The background could not be removed from this image.'
        });
    });
});
