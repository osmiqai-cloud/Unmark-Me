import test from 'node:test';
import assert from 'node:assert/strict';

import { dilate, refineAlpha, refineCutout } from '../../src/background/matteRefine.js';

const W = 120;
const H = 80;

const NAVY = [23, 39, 55];
const RED = [150, 30, 45];
const GREEN = [40, 60, 30];

// A photo filled with `colour`, plus a matching model mask.
function scene(colour, maskValue = 0) {
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([...colour, 255], i * 4);
    return { rgba, mask: new Uint8Array(W * H).fill(maskValue) };
}

function paint({ rgba, mask }, x0, y0, x1, y1, colour, maskValue) {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = y * W + x;
            if (colour) rgba.set([...colour, 255], i * 4);
            if (maskValue !== undefined) mask[i] = maskValue;
        }
    }
}

// Deterministic speckle so a backdrop is busy rather than plain.
function speckle({ rgba }, amount) {
    let seed = 7;
    for (let i = 0; i < W * H; i++) {
        for (let c = 0; c < 3; c++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const v = rgba[i * 4 + c] + ((seed % (2 * amount + 1)) - amount);
            rgba[i * 4 + c] = Math.max(0, Math.min(255, v));
        }
    }
}

const at = (alpha, x, y) => alpha[y * W + x];

test('a half-sure subject becomes solid and a faint smear beside it disappears', () => {
    const s = scene(NAVY);
    paint(s, 20, 20, 50, 60, GREEN, 215); // dark bottle the model was 85% sure of
    paint(s, 50, 20, 80, 60, null, 50); // a smear of backdrop at 20%
    const alpha = refineAlpha(s.rgba, W, H, s.mask);
    assert.equal(at(alpha, 35, 40), 255);
    assert.equal(at(alpha, 65, 40), 0);
    assert.equal(at(alpha, 5, 5), 0);
});

test('on a plain backdrop, subject the model was unsure of is kept solid', () => {
    const s = scene(NAVY);
    paint(s, 20, 20, 50, 60, GREEN, 255); // the bottle
    paint(s, 50, 40, 100, 50, RED, 45); // ribbon on the floor at 18%
    paint(s, 100, 40, 110, 50, RED, 0); // its tip, which the model missed
    const alpha = refineAlpha(s.rgba, W, H, s.mask);
    assert.equal(at(alpha, 75, 45), 255, 'ribbon');
    assert.equal(at(alpha, 105, 45), 255, 'ribbon tip');
    assert.equal(at(alpha, 75, 20), 0, 'backdrop beside it');
});

test('shadows on a plain backdrop stay out', () => {
    const LIGHT = [235, 235, 238];
    const SHADOW = [150, 150, 153];
    const s = scene(LIGHT);
    paint(s, 20, 10, 60, 50, RED, 255);
    paint(s, 20, 50, 90, 65, SHADOW, 60); // a cast shadow the model half-believed
    const alpha = refineAlpha(s.rgba, W, H, s.mask);
    assert.ok(at(alpha, 70, 58) < 40, `shadow alpha ${at(alpha, 70, 58)}`);
});

test('on a busy backdrop the colours are not trusted', () => {
    const s = scene([90, 110, 80]);
    speckle(s, 60);
    paint(s, 20, 20, 50, 60, GREEN, 255);
    paint(s, 50, 40, 100, 50, RED, 45);
    const alpha = refineAlpha(s.rgba, W, H, s.mask);
    assert.ok(at(alpha, 75, 45) < 40, `kept ${at(alpha, 75, 45)} on a busy backdrop`);
});

test('a hole the model missed inside the subject is filled, a real hole stays open', () => {
    const s = scene(NAVY);
    paint(s, 20, 10, 100, 70, RED, 255);
    paint(s, 30, 30, 40, 40, RED, 0); // part of the ribbon the model wrote off
    paint(s, 70, 30, 85, 45, NAVY, 0); // backdrop seen through a loop
    const alpha = refineAlpha(s.rgba, W, H, s.mask);
    assert.equal(at(alpha, 35, 35), 255);
    assert.equal(at(alpha, 77, 37), 0);
});

test('the edge ramp stays smooth', () => {
    const s = scene(NAVY);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            s.mask[y * W + x] = Math.max(0, Math.min(255, Math.round((x - 54) * 25.5)));
        }
    }
    paint(s, 60, 0, W, H, GREEN);
    const alpha = refineAlpha(s.rgba, W, H, s.mask);
    const row = [...alpha.subarray(40 * W, 41 * W)];
    for (let x = 1; x < W; x++) assert.ok(row[x] >= row[x - 1], `x=${x} rises`);
    assert.equal(row[0], 0);
    assert.equal(row[W - 1], 255);
});

test('edge pixels lose the old backdrop colour', () => {
    const { rgba, mask } = scene([0, 0, 255]);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const a = Math.max(0, Math.min(1, (x - 50) / 12));
            mask[y * W + x] = Math.round(a * 255);
            rgba.set([Math.round(255 * a), 0, Math.round(255 * (1 - a)), 255], (y * W + x) * 4);
        }
    }
    const { alpha, cutout } = refineCutout(rgba, W, H, mask);
    let checked = 0;
    for (let x = 0; x < W; x++) {
        const i = 40 * W + x;
        if (alpha[i] === 0 || alpha[i] === 255) continue;
        checked++;
        assert.ok(cutout[i * 4 + 2] <= rgba[i * 4 + 2], `x=${x}: no bluer than before`);
    }
    assert.ok(checked > 0);
});

test('pixels that were already transparent stay transparent', () => {
    const s = scene(RED, 255);
    s.rgba[3] = 0;
    s.rgba[7] = 128;
    const { cutout } = refineCutout(s.rgba, W, H, s.mask);
    assert.equal(cutout[3], 0);
    assert.equal(cutout[7], 128);
    assert.equal(cutout[11], 255);
});

test('dilate marks everything within the radius', () => {
    const set = new Uint8Array(9 * 3);
    set[1 * 9 + 4] = 1;
    const out = dilate(set, 9, 3, 2);
    assert.deepEqual([...out.subarray(9, 18)], [0, 0, 1, 1, 1, 1, 1, 0, 0]);
});
