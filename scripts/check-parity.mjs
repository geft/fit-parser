import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aerolab = process.argv[2] ?? path.resolve(root, '../run-progress');
const left = fs.readFileSync(path.join(root, 'lib/fit-core.mjs'));
const right = fs.readFileSync(path.join(aerolab, 'src/backend/ingestion/fit-core.mjs'));
if (!left.equals(right)) throw new Error('FIT core differs from AEROLAB');
console.log('FIT decoding and export core match AEROLAB byte-for-byte.');
