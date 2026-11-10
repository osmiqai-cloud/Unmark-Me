// Background-removal models, taken from rembg's model release
// (https://github.com/danielgatis/rembg, MIT License).
//
// The input size, mean, std and sigmoid flag for each model match rembg's
// session classes: rembg/sessions/u2netp.py and rembg/sessions/dis_general_use.py.
// The md5 values are the ones rembg checks downloads against.
//
// scripts/fetch-rembg-models.js downloads these into dist/models/rembg/ at
// build time, so the browser loads them from this site. GitHub release downloads
// don't send CORS headers, so a page can't fetch them directly.

const RELEASE = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0';

export const REMBG_MODELS = Object.freeze({
    fast: Object.freeze({
        id: 'fast',
        label: 'Fast',
        name: 'U²-Net (small)',
        rembgName: 'u2netp',
        file: 'u2netp.onnx',
        url: `${RELEASE}/u2netp.onnx`,
        md5: '8e83ca70e441ab06c318d82300c84806',
        bytes: 4574861,
        size: 320,
        mean: Object.freeze([0.485, 0.456, 0.406]),
        std: Object.freeze([0.229, 0.224, 0.225]),
        sigmoid: false,
        license: 'Apache-2.0',
        source: 'https://github.com/xuebinqin/U-2-Net'
    }),
    best: Object.freeze({
        id: 'best',
        label: 'Best',
        name: 'IS-Net',
        rembgName: 'isnet-general-use',
        file: 'isnet-general-use.onnx',
        url: `${RELEASE}/isnet-general-use.onnx`,
        md5: 'fc16ebd8b0c10d971d3513d564d01e29',
        bytes: 178648008,
        size: 1024,
        mean: Object.freeze([0.5, 0.5, 0.5]),
        std: Object.freeze([1, 1, 1]),
        sigmoid: false,
        license: 'Apache-2.0',
        source: 'https://github.com/xuebinqin/DIS'
    })
});

export const DEFAULT_REMBG_MODEL = 'fast';

export function getRembgModel(id) {
    return REMBG_MODELS[id] || REMBG_MODELS[DEFAULT_REMBG_MODEL];
}
