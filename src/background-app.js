// Background remover page. The heavy lifting (model download, inference, mask)
// happens in workers/background-worker.js; this file handles the page.

import { DEFAULT_REMBG_MODEL, REMBG_MODELS, getRembgModel } from './background/rembgModels.js';
import { mountAccountMenu } from './shared/accountMenu.js';
import { createImageCompare } from './shared/imageCompare.js';
import { mountThemeSwitch } from './shared/themeSwitch.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MODEL_STORAGE_KEY = 'unmark-bg-model';

const TEXT = {
    notImage: 'Choose a JPG, PNG or WebP image.',
    tooLarge: 'That image is over 20 MB. Choose a smaller one.',
    tooManyPixels: 'That image is too large to process here. Try one under 40 megapixels.',
    unreadable: 'That image could not be opened.',
    downloading: (percent, label) => `Downloading the ${label} model… ${percent}%`,
    starting: 'Starting the AI…',
    removing: 'Removing background…',
    done: 'Background removed',
    failed: 'Couldn’t remove the background',
    copied: 'Copied',
    copyUnsupported: 'Copying images isn’t supported in this browser. Use Download instead.',
    copyFailed: 'Copy failed. Use Download instead.',
    workerUnsupported: 'This browser can’t run the background remover. Try a recent Chrome, Edge, Safari or Firefox.'
};

const MODEL_HINTS = {
    fast: `Quick. Good for products and simple shapes. ${formatMegabytes(REMBG_MODELS.fast.bytes)} download.`,
    best: `Most accurate, for people, hair and fine detail. ${formatMegabytes(REMBG_MODELS.best.bytes)} download, once.`
};

const $ = (id) => document.getElementById(id);
const uploadArea = $('uploadArea');
const fileInput = $('fileInput');
const homeStatus = $('homeStatus');
const workspace = $('workspace');
const comparisonContainer = $('comparisonContainer');
const originalImage = $('originalImage');
const processedOverlay = $('processedOverlay');
const processedImage = $('processedImage');
const sliderHandle = $('sliderHandle');
const resultInfo = $('resultInfo');
const progress = document.querySelector('.bg-progress');
const progressBar = $('progressBar');
const modelHint = $('modelHint');
const customColor = $('customColor');
const downloadBtn = $('downloadBtn');
const copyBtn = $('copyBtn');
const resetBtn = $('resetBtn');
const statusMessage = $('statusMessage');
const modelButtons = [...document.querySelectorAll('[data-model]')];
const backgroundButtons = [...document.querySelectorAll('[data-background]')];
const customSwatch = document.querySelector('[data-background="custom"]');

const state = {
    file: null,
    width: 0,
    height: 0,
    originalUrl: null,
    cutoutUrl: null,
    cutoutCanvas: null,
    exports: new Map(),
    model: readSavedModel(),
    background: 'transparent',
    customColor: customColor.value,
    jobId: 0,
    busy: false,
    failed: false,
    result: null
};

let worker = null;
let imageCompare = null;

function formatMegabytes(bytes) {
    return `${Math.round(bytes / 1e6)} MB`;
}

function formatSeconds(ms) {
    return `${Math.max(0.1, ms / 1000).toFixed(1)} s`;
}

function readSavedModel() {
    try {
        const saved = localStorage.getItem(MODEL_STORAGE_KEY);
        if (saved && REMBG_MODELS[saved]) return saved;
    } catch {
        // Storage can be blocked; the default is fine.
    }
    return DEFAULT_REMBG_MODEL;
}

function saveModel(model) {
    try {
        localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
        // Not remembered this time.
    }
}

function setView(view) {
    document.body.dataset.view = view;
}

function setHomeStatus(text) {
    homeStatus.textContent = text;
}

function setStatusMessage(text, tone = '') {
    statusMessage.textContent = text;
    statusMessage.className = `status-message${tone ? ` text-${tone}` : ''}`;
}

function currentBackgroundColor() {
    if (state.background === 'transparent') return null;
    return state.background === 'custom' ? state.customColor : state.background;
}

// ---------- Worker ----------

function getWorker() {
    if (worker) return worker;
    worker = new Worker('./workers/background-worker.js', { type: 'module' });
    worker.addEventListener('message', (event) => handleWorkerMessage(event.data));
    worker.addEventListener('error', (event) => {
        console.error('Background worker crashed:', event.message || event);
        worker?.terminate();
        worker = null;
        if (state.busy) showFailure(TEXT.failed, 'Something went wrong. Please try again.');
    });
    return worker;
}

function handleWorkerMessage(message) {
    if (!message || message.id !== state.jobId) return;
    if (message.type === 'progress') {
        showProgress(message);
    } else if (message.type === 'result') {
        showResult(message);
    } else if (message.type === 'error') {
        showFailure(TEXT.failed, message.message);
    }
}

// ---------- Inspector ----------

function renderMeta({ status, tone = 'processing', rows = [] }) {
    const icon = tone === 'processing'
        ? ''
        : `<svg viewBox="0 0 24 24">${tone === 'warning'
            ? '<path d="M12 7v6m0 4h.01" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
            : '<path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>`;
    const statusClass = tone === 'processing' ? ' is-processing' : tone === 'warning' ? ' is-warning' : '';
    resultInfo.replaceChildren();
    const statusLine = document.createElement('p');
    statusLine.className = `meta-status${statusClass}`;
    statusLine.innerHTML = `<span class="meta-status-icon" aria-hidden="true">${icon}</span>`;
    statusLine.append(status);
    resultInfo.append(statusLine);
    for (const [label, value] of rows) {
        const row = document.createElement('p');
        row.className = 'meta-row';
        const name = document.createElement('span');
        name.textContent = label;
        const data = document.createElement('span');
        data.textContent = value;
        row.append(name, data);
        resultInfo.append(row);
    }
}

function sizeRow() {
    return ['Size', `${state.width} × ${state.height}`];
}

function setProgress(fraction) {
    if (fraction === null) {
        progress.hidden = true;
        progressBar.style.width = '0';
        return;
    }
    progress.hidden = false;
    progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

function showProgress({ stage, loaded = 0, total = 0 }) {
    const model = getRembgModel(state.model);
    if (stage === 'download') {
        const fraction = total ? loaded / total : 0;
        setProgress(fraction);
        renderMeta({
            status: TEXT.downloading(Math.floor(fraction * 100), model.label),
            rows: [sizeRow(), ['Model', model.name]]
        });
        return;
    }
    setProgress(null);
    renderMeta({
        status: stage === 'starting' ? TEXT.starting : TEXT.removing,
        rows: [sizeRow(), ['Model', model.name]]
    });
}

function setActionsEnabled(enabled) {
    downloadBtn.disabled = !enabled;
    copyBtn.disabled = !enabled;
}

function setModelButtonsEnabled(enabled) {
    for (const button of modelButtons) button.disabled = !enabled;
}

// ---------- Flow ----------

async function handleFiles(files) {
    setHomeStatus('');
    const file = [...(files || [])].find(Boolean);
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
        setHomeStatus(TEXT.notImage);
        return;
    }
    if (file.size > MAX_FILE_BYTES) {
        setHomeStatus(TEXT.tooLarge);
        return;
    }

    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        setHomeStatus(TEXT.unreadable);
        return;
    }
    const { width, height } = bitmap;
    bitmap.close();
    if (width * height > MAX_PIXELS) {
        setHomeStatus(TEXT.tooManyPixels);
        return;
    }
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
        setHomeStatus(TEXT.workerUnsupported);
        return;
    }

    clearImage();
    state.file = file;
    state.width = width;
    state.height = height;
    state.originalUrl = URL.createObjectURL(file);
    originalImage.src = state.originalUrl;
    setView('single');
    workspace.style.display = '';
    runRemoval();
}

async function runRemoval() {
    if (!state.file) return;
    const jobId = ++state.jobId;
    const model = getRembgModel(state.model);

    state.busy = true;
    state.failed = false;
    state.result = null;
    workspace.dataset.state = 'processing';
    imageCompare.reset();
    processedOverlay.style.display = 'none';
    sliderHandle.style.display = 'none';
    setActionsEnabled(false);
    setModelButtonsEnabled(false);
    setStatusMessage('');
    renderMeta({ status: TEXT.removing, rows: [sizeRow(), ['Model', model.name]] });

    let bitmap;
    try {
        bitmap = await createImageBitmap(state.file);
    } catch {
        showFailure(TEXT.failed, TEXT.unreadable);
        return;
    }
    if (jobId !== state.jobId) {
        bitmap.close();
        return;
    }
    getWorker().postMessage({ type: 'remove', id: jobId, modelId: model.id, bitmap }, [bitmap]);
}

async function showResult({ width, height, cutout, provider, timings }) {
    const jobId = state.jobId;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(cutout), width, height), 0, 0);
    const blob = await canvasToPng(canvas);
    if (jobId !== state.jobId) return;

    revokeCutout();
    state.cutoutCanvas = canvas;
    state.exports = new Map([['transparent', blob]]);
    state.cutoutUrl = URL.createObjectURL(blob);
    processedImage.src = state.cutoutUrl;
    await decodeBriefly(processedImage);
    if (jobId !== state.jobId) return;

    const model = getRembgModel(state.model);
    state.busy = false;
    state.result = { provider, timings, model: model.id };
    setProgress(null);
    renderMeta({
        status: TEXT.done,
        tone: 'success',
        rows: [
            sizeRow(),
            ['Model', model.name],
            ['Time', formatSeconds(timings.total)],
            ['Runs on', provider === 'webgpu' ? 'GPU' : 'CPU']
        ]
    });
    applyBackgroundPreview();
    workspace.dataset.state = 'done';
    processedOverlay.style.display = '';
    sliderHandle.style.display = '';
    imageCompare.activate();
    setActionsEnabled(true);
    setModelButtonsEnabled(true);
}

function showFailure(status, detail) {
    state.busy = false;
    state.failed = true;
    setProgress(null);
    delete workspace.dataset.state;
    renderMeta({ status, tone: 'warning', rows: [sizeRow()] });
    setStatusMessage(detail, 'warning');
    setModelButtonsEnabled(true);
}

// Wait for the cutout to decode so it doesn't flash in, but never for long:
// browsers hold decodes for background tabs until they are shown again.
function decodeBriefly(image) {
    return Promise.race([
        image.decode().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
}

function revokeCutout() {
    if (state.cutoutUrl) URL.revokeObjectURL(state.cutoutUrl);
    state.cutoutUrl = null;
    state.cutoutCanvas = null;
    state.exports = new Map();
}

function clearImage() {
    state.jobId++;
    state.busy = false;
    state.failed = false;
    state.result = null;
    revokeCutout();
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    state.originalUrl = null;
    state.file = null;
    originalImage.removeAttribute('src');
    processedImage.removeAttribute('src');
    processedOverlay.style.display = 'none';
    sliderHandle.style.display = 'none';
    imageCompare?.reset();
    resultInfo.replaceChildren();
    setProgress(null);
    setStatusMessage('');
    setActionsEnabled(false);
    setModelButtonsEnabled(true);
    delete workspace.dataset.state;
}

function reset() {
    clearImage();
    workspace.style.display = 'none';
    fileInput.value = '';
    setView('home');
    uploadArea.focus({ preventScroll: true });
}

// ---------- Background colour ----------

function applyBackgroundPreview() {
    processedOverlay.style.backgroundColor = currentBackgroundColor() || '';
}

function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
}

// The cutout drawn over the chosen colour, encoded once per colour.
function exportBlob() {
    const color = currentBackgroundColor();
    const key = color || 'transparent';
    if (!state.exports.has(key)) {
        const source = state.cutoutCanvas;
        const canvas = document.createElement('canvas');
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext('2d');
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0);
        state.exports.set(key, canvasToPng(canvas));
    }
    return Promise.resolve(state.exports.get(key));
}

function exportName() {
    const base = (state.file?.name || 'image').replace(/\.[^.]+$/, '');
    return `${base}-no-background.png`;
}

async function download() {
    if (!state.cutoutCanvas) return;
    const blob = await exportBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportName();
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copy() {
    if (!state.cutoutCanvas) return;
    if (!navigator.clipboard?.write || !window.ClipboardItem) {
        setStatusMessage(TEXT.copyUnsupported, 'warning');
        return;
    }
    try {
        // Hand the clipboard a promise so the copy stays inside the click.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
        const label = copyBtn.querySelector('span');
        const original = label.textContent;
        label.textContent = TEXT.copied;
        setTimeout(() => { label.textContent = original; }, 2000);
    } catch (error) {
        console.error('Copy failed:', error);
        setStatusMessage(TEXT.copyFailed, 'warning');
    }
}

// ---------- Radio groups ----------

function setupRadioGroup(buttons, onSelect) {
    buttons.forEach((button, index) => {
        button.addEventListener('click', () => onSelect(button));
        button.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
            let next = index;
            for (let tries = 0; tries < buttons.length; tries++) {
                next = (next + step + buttons.length) % buttons.length;
                if (!buttons[next].disabled) break;
            }
            buttons[next].focus();
            onSelect(buttons[next], { fromKeyboard: true });
        });
    });
}

function markChecked(buttons, selected) {
    for (const button of buttons) {
        const checked = button === selected;
        button.setAttribute('aria-checked', String(checked));
        button.tabIndex = checked ? 0 : -1;
    }
}

function selectModel(model, { rerun = true } = {}) {
    const button = modelButtons.find((item) => item.dataset.model === model);
    if (!button) return;
    const changed = state.model !== model;
    state.model = model;
    markChecked(modelButtons, button);
    modelHint.textContent = MODEL_HINTS[model];
    if (changed) saveModel(model);
    // Picking a model reruns the image; picking the same one again retries a failure.
    if (rerun && state.file && !state.busy && (changed || state.failed)) runRemoval();
}

function selectBackground(button, { fromKeyboard = false } = {}) {
    state.background = button.dataset.background;
    markChecked(backgroundButtons, button);
    applyBackgroundPreview();
    if (state.background === 'custom' && !fromKeyboard) openColorPicker();
}

function openColorPicker() {
    try {
        if (typeof customColor.showPicker === 'function') {
            customColor.showPicker();
            return;
        }
    } catch {
        // showPicker needs a user gesture in some browsers; click() below works then.
    }
    customColor.click();
}

function setupControls() {
    setupRadioGroup(modelButtons, (button) => selectModel(button.dataset.model));
    setupRadioGroup(backgroundButtons, selectBackground);
    customColor.addEventListener('input', () => {
        state.customColor = customColor.value;
        customSwatch.style.setProperty('--swatch', customColor.value);
        if (state.background !== 'custom') markChecked(backgroundButtons, customSwatch);
        state.background = 'custom';
        applyBackgroundPreview();
    });
    selectModel(state.model, { rerun: false });
}

// ---------- Input ----------

function setupInput() {
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInput.click();
        }
    });
    fileInput.addEventListener('change', () => handleFiles(fileInput.files));

    document.addEventListener('dragover', (event) => {
        event.preventDefault();
        uploadArea.classList.add('is-dragging');
    });
    document.addEventListener('dragleave', (event) => {
        if (event.clientX === 0 && event.clientY === 0) uploadArea.classList.remove('is-dragging');
    });
    document.addEventListener('drop', (event) => {
        event.preventDefault();
        uploadArea.classList.remove('is-dragging');
        if (event.dataTransfer?.files?.length) handleFiles(event.dataTransfer.files);
    });
    document.addEventListener('paste', (event) => {
        const files = [...(event.clipboardData?.items || [])]
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile());
        if (files.length) handleFiles(files);
    });

    resetBtn.addEventListener('click', reset);
    downloadBtn.addEventListener('click', download);
    copyBtn.addEventListener('click', copy);
}

function setupImageCompare() {
    imageCompare = createImageCompare({
        container: comparisonContainer,
        beforeImage: originalImage,
        grip: sliderHandle,
        lineSvg: comparisonContainer.querySelector('.cmp-line'),
        linePath: comparisonContainer.querySelector('.cmp-line path'),
        beforeTag: comparisonContainer.querySelector('.cmp-tag-before'),
        afterTag: comparisonContainer.querySelector('.cmp-tag-after')
    });
}

mountThemeSwitch(document.getElementById('themeSwitch'));
mountAccountMenu(document.getElementById('accountButton'));
setupImageCompare();
setupControls();
setupInput();
