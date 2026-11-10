// Turns rembg's mask into a clean cutout, using the photo's colours where the
// model is unsure.
//
// The models output a confidence, not a true alpha. Two things go wrong when
// it is used directly:
//   - background the model half-believes (a shadow, ground under an animal)
//     shows up as a faint smear;
//   - subject the model half-believes (a ribbon lying on the floor, the inside
//     of a loop) comes out faded or missing.
//
// So:
//   1. a gentle curve on the confidence: under 25% fades to nothing, over 75%
//      becomes solid, the edge ramp in between stays smooth;
//   2. where the backdrop is plain (a studio sweep, a wall, sky), unsure
//      pixels that are clearly not backdrop colour are kept as subject, and
//      this grows a few steps into pixels the model wrote off entirely.
//      Shadows (darker backdrop) don't count. It only ever adds subject;
//      on a busy backdrop it does nothing and the model decides;
//   3. edge pixels are recoloured so the old backdrop doesn't fringe them
//      (blur-fusion foreground estimation, Forte & Pitié 2021).

const SURE_BG = 8;
const CURVE_LOW = 0.25 * 255;
const CURVE_HIGH = 0.75 * 255;

const STATS_MAX_SIDE = 512;
const STATS_RADIUS_FRACTION = 0.03;
const STATS_WIDE_RADIUS_FRACTION = 0.15;
const STATS_MIN_WEIGHT = 16;
const STATS_PASSES = 3;
const TRANSITION_GAP = 3;
const POCKET_FRACTION = 0.02;

const Z_LOW = 3;
const Z_HIGH = 8;
const NOISE_FLOOR = 4;
const PLAIN_SIGMA = 10;
const BUSY_SIGMA = 30;
// Share of the backdrop the outlier trimming may drop before it counts as busy.
const KEEP_BUSY = 0.75;
const KEEP_PLAIN = 0.92;
const LUMA_BRIGHTER = 0.35;
const LUMA_DARKER = 0.12;

const GROW_STEPS = 3;
const GROW_REACH_FRACTION = 0.015;

const ESTIMATE_MAX_SIDE = 1024;
const ESTIMATE_RADIUS = 8;

function smoothstep(low, high, value) {
    const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
}

function toYcc(r, g, b, out) {
    out[0] = 0.299 * r + 0.587 * g + 0.114 * b;
    out[1] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    out[2] = 0.5 * r - 0.418688 * g - 0.081312 * b;
}

// Box sums of interleaved float channels, window clipped at the borders.
function boxSum(src, width, height, channels, radius) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const pass = (input, output, length, count, stride, step) => {
        for (let line = 0; line < count; line++) {
            const base = line * stride;
            for (let c = 0; c < channels; c++) {
                let sum = 0;
                for (let k = 0; k <= Math.min(radius, length - 1); k++) sum += input[base + k * step + c];
                for (let k = 0; k < length; k++) {
                    output[base + k * step + c] = sum;
                    if (k + radius + 1 < length) sum += input[base + (k + radius + 1) * step + c];
                    if (k - radius >= 0) sum -= input[base + (k - radius) * step + c];
                }
            }
        }
    };
    pass(src, tmp, width, height, width * channels, channels);
    pass(tmp, out, height, width, channels, width * channels);
    return out;
}

// 1 wherever a `set` pixel lies within `radius` (square window).
export function dilate(set, width, height, radius) {
    const n = width * height;
    const rows = new Uint16Array(n);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        let sum = 0;
        for (let x = 0; x <= Math.min(radius, width - 1); x++) sum += set[row + x];
        for (let x = 0; x < width; x++) {
            rows[row + x] = sum;
            if (x + radius + 1 < width) sum += set[row + x + radius + 1];
            if (x - radius >= 0) sum -= set[row + x - radius];
        }
    }
    const out = new Uint8Array(n);
    for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let y = 0; y <= Math.min(radius, height - 1); y++) sum += rows[y * width + x];
        for (let y = 0; y < height; y++) {
            out[y * width + x] = sum > 0 ? 1 : 0;
            if (y + radius + 1 < height) sum += rows[(y + radius + 1) * width + x];
            if (y - radius >= 0) sum -= rows[(y - radius) * width + x];
        }
    }
    return out;
}

// Pixels that must not describe the backdrop: everything the model has any
// belief in, a few pixels around it (its soft edge trails into "sure"
// background), and small enclosed patches of background, which are holes in
// the subject rather than backdrop.
function notBackdrop(mask, width, height) {
    const n = width * height;
    const unsure = new Uint8Array(n);
    for (let i = 0; i < n; i++) unsure[i] = mask[i] > SURE_BG ? 1 : 0;
    const excluded = dilate(unsure, width, height, TRANSITION_GAP);

    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    const maxPocket = Math.round(n * POCKET_FRACTION);
    for (let start = 0; start < n; start++) {
        if (seen[start] || unsure[start]) continue;
        let head = 0;
        let tail = 0;
        let touchesEdge = false;
        queue[tail++] = start;
        seen[start] = 1;
        while (head < tail) {
            const i = queue[head++];
            const x = i % width;
            const y = (i - x) / width;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
            if (x > 0 && !seen[i - 1] && !unsure[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
            if (x < width - 1 && !seen[i + 1] && !unsure[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
            if (y > 0 && !seen[i - width] && !unsure[i - width]) { seen[i - width] = 1; queue[tail++] = i - width; }
            if (y < height - 1 && !seen[i + width] && !unsure[i + width]) { seen[i + width] = 1; queue[tail++] = i + width; }
        }
        if (!touchesEdge && tail <= maxPocket) {
            for (let k = 0; k < tail; k++) excluded[queue[k]] = 1;
        }
    }
    return excluded;
}

// Distance from the local backdrop in units of its own noise. Brightness
// counts less than colour, and darkening least, so shadows read as backdrop.
function backdropDistance(ycc, local) {
    const dy = ycc[0] - local[0];
    const lumaWeight = dy < 0 ? LUMA_DARKER : LUMA_BRIGHTER;
    const d = Math.hypot(lumaWeight * dy, ycc[1] - local[1], ycc[2] - local[2]);
    return d / Math.max(NOISE_FLOOR, local[3]);
}

// Local backdrop colour and spread on a small grid: per cell y, cb, cr, sigma,
// weight. `keep` (optional) drops pixels that don't fit an earlier estimate.
// Returns the near estimate (with the wide one filling cells where little
// backdrop is in reach, such as the inside of a ribbon loop) and the wide one.
function backdropGrid(rgba, excluded, width, height, keep) {
    const factor = Math.max(1, Math.ceil(Math.max(width, height) / STATS_MAX_SIDE));
    const lw = Math.ceil(width / factor);
    const lh = Math.ceil(height / factor);
    const step = Math.max(1, Math.floor(factor / 2));
    const acc = new Float32Array(lw * lh * 5);
    const ycc = [0, 0, 0];
    for (let y = 0; y < height; y += step) {
        const cellRow = Math.floor(y / factor) * lw;
        for (let x = 0; x < width; x += step) {
            const i = y * width + x;
            if (excluded[i]) continue;
            toYcc(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], ycc);
            const cell = cellRow + Math.floor(x / factor);
            if (keep && !keep(cell, ycc)) continue;
            const o = cell * 5;
            acc[o] += 1;
            acc[o + 1] += ycc[0];
            acc[o + 2] += ycc[1];
            acc[o + 3] += ycc[2];
            acc[o + 4] += (LUMA_BRIGHTER * ycc[0]) ** 2 + ycc[1] * ycc[1] + ycc[2] * ycc[2];
        }
    }
    const side = Math.max(lw, lh);
    const near = summarise(acc, lw, lh, Math.max(3, Math.round(STATS_RADIUS_FRACTION * side)));
    const wide = summarise(acc, lw, lh, Math.max(6, Math.round(STATS_WIDE_RADIUS_FRACTION * side)));
    // Deep inside a large subject even the wide neighbourhood may hold no
    // backdrop; the whole image's backdrop stands in there.
    const total = new Float32Array(5);
    for (let cell = 0; cell < lw * lh; cell++) {
        for (let k = 0; k < 5; k++) total[k] += acc[cell * 5 + k];
    }
    const global = summarise(total, 1, 1, 0);
    for (let cell = 0; cell < lw * lh; cell++) {
        const o = cell * 5;
        if (wide[o + 4] < STATS_MIN_WEIGHT && global[4] >= STATS_MIN_WEIGHT) wide.set(global, o);
        if (near[o + 4] < STATS_MIN_WEIGHT) near.set(wide.subarray(o, o + 5), o);
    }
    return { stats: near, wide, lw, lh, factor };
}

function summarise(acc, lw, lh, radius) {
    const sums = boxSum(acc, lw, lh, 5, radius);
    const stats = new Float32Array(lw * lh * 5);
    for (let cell = 0; cell < lw * lh; cell++) {
        const o = cell * 5;
        const weight = sums[o];
        if (weight < 1) continue;
        const my = sums[o + 1] / weight;
        const mb = sums[o + 2] / weight;
        const mr = sums[o + 3] / weight;
        const variance = sums[o + 4] / weight - ((LUMA_BRIGHTER * my) ** 2 + mb * mb + mr * mr);
        stats[o] = my;
        stats[o + 1] = mb;
        stats[o + 2] = mr;
        stats[o + 3] = Math.sqrt(Math.max(0, variance) / 3);
        stats[o + 4] = weight;
    }
    return stats;
}

// Per cell: y, cb, cr, sigma, then how plain the backdrop is (0-1).
function backdropStats(rgba, mask, width, height) {
    const excluded = notBackdrop(mask, width, height);
    const untrimmed = backdropGrid(rgba, excluded, width, height);
    // Sigma-clip: stray bits of subject the model wrote off as background
    // would otherwise make a plain backdrop look busy, or take over a small
    // neighbourhood entirely. The first pass judges against the wide
    // estimate, which a patch of subject can't dominate.
    let reference = untrimmed.wide;
    let grid = untrimmed;
    for (let pass = 0; pass < STATS_PASSES; pass++) {
        const stats = reference;
        const local = [0, 0, 0, 0];
        grid = backdropGrid(rgba, excluded, width, height, (cell, ycc) => {
            const o = cell * 5;
            if (stats[o + 4] <= 0) return true;
            local[0] = stats[o];
            local[1] = stats[o + 1];
            local[2] = stats[o + 2];
            local[3] = stats[o + 3];
            return backdropDistance(ycc, local) <= Z_LOW;
        });
        reference = grid.stats;
    }
    // Plain means a small spread that trimming barely had to touch. A busy
    // backdrop (foliage, a room) loses a lot to trimming even when what's left
    // looks uniform, so it stays busy.
    const { stats } = grid;
    for (let cell = 0; cell < grid.lw * grid.lh; cell++) {
        const o = cell * 5;
        const before = untrimmed.stats[o + 4];
        if (stats[o + 4] <= 0 || before <= 0) {
            stats[o + 4] = 0;
            continue;
        }
        const kept = Math.min(1, stats[o + 4] / before);
        stats[o + 4] = (1 - smoothstep(PLAIN_SIGMA, BUSY_SIGMA, stats[o + 3])) * smoothstep(KEEP_BUSY, KEEP_PLAIN, kept);
    }
    return grid;
}

// Bilinear lookup of the grid at a full-size pixel; false where no backdrop
// was seen nearby.
function lookup(grid, x, y, out) {
    const { stats, lw, lh, factor } = grid;
    const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / factor - 0.5));
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(lw - 1, x0 + 1);
    const y1 = Math.min(lh - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    out[0] = out[1] = out[2] = out[3] = out[4] = 0;
    let total = 0;
    const add = (cx, cy, w) => {
        const o = (cy * lw + cx) * 5;
        if (w === 0 || stats[o + 4] <= 0) return;
        for (let k = 0; k < 5; k++) out[k] += stats[o + k] * w;
        total += w;
    };
    add(x0, y0, (1 - tx) * (1 - ty));
    add(x1, y0, tx * (1 - ty));
    add(x0, y1, (1 - tx) * ty);
    add(x1, y1, tx * ty);
    if (total === 0) return false;
    for (let k = 0; k < 5; k++) out[k] /= total;
    // Cells next to ones with no plain backdrop shouldn't borrow plainness.
    out[4] *= total;
    return true;
}

export function refineAlpha(rgba, width, height, mask) {
    const n = width * height;
    const grid = backdropStats(rgba, mask, width, height);
    const alpha = new Uint8Array(n);
    const ycc = [0, 0, 0];
    const local = [0, 0, 0, 0, 0];

    // How strongly a pixel stands out from a plain backdrop, 0-1.
    const standsOut = (i) => {
        const x = i % width;
        const y = (i - x) / width;
        if (!lookup(grid, x, y, local)) return 0;
        const plain = local[4];
        if (plain === 0) return 0;
        toYcc(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], ycc);
        return plain * smoothstep(Z_LOW, Z_HIGH, backdropDistance(ycc, local));
    };

    for (let i = 0; i < n; i++) {
        const m = mask[i];
        let a = smoothstep(CURVE_LOW, CURVE_HIGH, m);
        if (m > SURE_BG && a < 1) a = Math.max(a, standsOut(i));
        alpha[i] = Math.round(a * 255);
    }

    // Pixels the model wrote off entirely can still be subject where they
    // touch what was kept and clearly aren't backdrop (the tip of a ribbon).
    const reach = Math.max(4, Math.round(GROW_REACH_FRACTION * Math.max(width, height)));
    const kept = new Uint8Array(n);
    for (let step = 0; step < GROW_STEPS; step++) {
        for (let i = 0; i < n; i++) kept[i] = alpha[i] >= 128 ? 1 : 0;
        const near = dilate(kept, width, height, reach);
        let grew = false;
        for (let i = 0; i < n; i++) {
            if (!near[i] || mask[i] > SURE_BG || alpha[i] >= 128) continue;
            const a = Math.round(standsOut(i) * 255);
            if (a > alpha[i]) {
                alpha[i] = a;
                if (a >= 128) grew = true;
            }
        }
        if (!grew) break;
    }
    return alpha;
}

// Local foreground and background colours, estimated on a small copy of the
// image (they are wide averages, so full resolution adds nothing).
function estimateColours(rgba, alpha, width, height) {
    const factor = Math.max(1, Math.ceil(Math.max(width, height) / ESTIMATE_MAX_SIDE));
    const lw = Math.ceil(width / factor);
    const lh = Math.ceil(height / factor);
    const sums = new Float32Array(lw * lh * 8);
    for (let y = 0; y < height; y++) {
        const cellRow = Math.floor(y / factor) * lw;
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const o = (cellRow + Math.floor(x / factor)) * 8;
            const a = alpha[i] / 255;
            const b = 1 - a;
            const p = i * 4;
            sums[o] += a;
            sums[o + 1] += a * rgba[p];
            sums[o + 2] += a * rgba[p + 1];
            sums[o + 3] += a * rgba[p + 2];
            sums[o + 4] += b;
            sums[o + 5] += b * rgba[p];
            sums[o + 6] += b * rgba[p + 1];
            sums[o + 7] += b * rgba[p + 2];
        }
    }
    const blurred = boxSum(sums, lw, lh, 8, ESTIMATE_RADIUS);
    const fore = new Float32Array(lw * lh * 3);
    const back = new Float32Array(lw * lh * 3);
    for (let cell = 0; cell < lw * lh; cell++) {
        const o = cell * 8;
        const wa = blurred[o] + 1e-5;
        const wb = blurred[o + 4] + 1e-5;
        for (let c = 0; c < 3; c++) {
            fore[cell * 3 + c] = blurred[o + 1 + c] / wa;
            back[cell * 3 + c] = blurred[o + 5 + c] / wb;
        }
    }
    return { fore, back, lw, lh, factor };
}

function sample(map, lw, lh, factor, x, y, out) {
    const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / factor - 0.5));
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(lw - 1, x0 + 1);
    const y1 = Math.min(lh - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    for (let c = 0; c < 3; c++) {
        const top = map[(y0 * lw + x0) * 3 + c] * (1 - tx) + map[(y0 * lw + x1) * 3 + c] * tx;
        const bottom = map[(y1 * lw + x0) * 3 + c] * (1 - tx) + map[(y1 * lw + x1) * 3 + c] * tx;
        out[c] = top * (1 - ty) + bottom * ty;
    }
}

// mask: the model's full-size mask (0-255). Returns the refined alpha and the
// RGBA cutout (pixels that were already transparent stay transparent).
export function refineCutout(rgba, width, height, mask) {
    const n = width * height;
    const alpha = refineAlpha(rgba, width, height, mask);
    const { fore, back, lw, lh, factor } = estimateColours(rgba, alpha, width, height);
    const cutout = new Uint8ClampedArray(n * 4);
    const f = [0, 0, 0];
    const b = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const a = alpha[i];
        if (a === 0 || a === 255) {
            cutout[p] = rgba[p];
            cutout[p + 1] = rgba[p + 1];
            cutout[p + 2] = rgba[p + 2];
        } else {
            const x = i % width;
            const y = (i - x) / width;
            sample(fore, lw, lh, factor, x, y, f);
            sample(back, lw, lh, factor, x, y, b);
            const t = a / 255;
            for (let c = 0; c < 3; c++) {
                cutout[p + c] = f[c] + t * (rgba[p + c] - t * f[c] - (1 - t) * b[c]);
            }
        }
        cutout[p + 3] = Math.round((a * rgba[p + 3]) / 255);
    }
    return { alpha, cutout };
}
