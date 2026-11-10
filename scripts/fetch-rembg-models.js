#!/usr/bin/env node
// Downloads the background-removal models (see src/background/rembgModels.js),
// checks each against rembg's md5, and copies them to dist/models/rembg/ so the
// site serves them from its own origin.
//
//   node scripts/fetch-rembg-models.js            all models
//   node scripts/fetch-rembg-models.js fast       only the listed model ids
//
// Downloads are kept in .cache/rembg-models/ (git-ignored), so running it
// again only copies.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, copyFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { REMBG_MODELS } from '../src/background/rembgModels.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache', 'rembg-models');
const OUT_DIR = join(ROOT, 'dist', 'models', 'rembg');

async function md5Of(path) {
    const hash = createHash('md5');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

async function isValid(path, model) {
    return existsSync(path) &&
        statSync(path).size === model.bytes &&
        await md5Of(path) === model.md5;
}

async function download(model, target) {
    const partial = `${target}.partial`;
    const started = Date.now();
    process.stdout.write(`  downloading ${model.file} (${(model.bytes / 1e6).toFixed(1)} MB)…`);
    const response = await fetch(model.url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`${model.url} returned ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (!await isValid(partial, model)) {
        rmSync(partial, { force: true });
        throw new Error(`${model.file} failed its checksum (expected md5 ${model.md5})`);
    }
    renameSync(partial, target);
    process.stdout.write(` done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

async function main() {
    const wanted = process.argv.slice(2);
    const models = Object.values(REMBG_MODELS).filter((model) => wanted.length === 0 || wanted.includes(model.id));
    if (models.length === 0) {
        throw new Error(`No model matches ${wanted.join(', ')}. Known: ${Object.keys(REMBG_MODELS).join(', ')}`);
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });
    console.log('Background-removal models:');

    for (const model of models) {
        const cached = join(CACHE_DIR, model.file);
        if (await isValid(cached, model)) {
            console.log(`  ${model.file} is already downloaded`);
        } else {
            await download(model, cached);
        }
        const published = join(OUT_DIR, model.file);
        if (!existsSync(published) || statSync(published).size !== model.bytes) {
            copyFileSync(cached, published);
        }
        console.log(`  → dist/models/rembg/${model.file}`);
    }
}

main().catch((error) => {
    console.error(`\nCould not fetch the background-removal models: ${error.message}`);
    process.exit(1);
});
