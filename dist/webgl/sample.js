import { OS_ARCH_MATRIX } from '../pkgman.js';
import path from 'node:path';
import sqlite from 'sqlite3';
const { Database } = sqlite;
// Get database path relative to this file
const DB_PATH = path.join(import.meta.dirname, '..', 'data-files', 'webgl_data.db');
export async function sampleWebGL(os, vendor, renderer) {
    if (!OS_ARCH_MATRIX[os]) {
        throw new Error(`Invalid OS: ${os}. Must be one of: win, mac, lin`);
    }
    const db = new Database(DB_PATH);
    let query = '';
    let params = [];
    if (vendor && renderer) {
        query = `SELECT vendor, renderer, data, ${os} FROM webgl_fingerprints WHERE vendor = ? AND renderer = ?`;
        params = [vendor, renderer];
    }
    else {
        query = `SELECT vendor, renderer, data, ${os} FROM webgl_fingerprints WHERE ${os} > 0`;
    }
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }
            if (rows.length === 0) {
                reject(new Error(`No WebGL data found for OS: ${os}`));
                return;
            }
            if (vendor && renderer) {
                const result = rows[0];
                if (result[os] <= 0) {
                    db.all(`SELECT DISTINCT vendor, renderer FROM webgl_fingerprints WHERE ${os} > 0`, [], (err, pairs) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        reject(new Error(`Vendor "${vendor}" and renderer "${renderer}" combination not valid for ${os}. Possible pairs: ${pairs.map(pair => `${pair.vendor}, ${pair.renderer}`).join(', ')}`));
                    });
                    return;
                }
                resolve(JSON.parse(result.data));
            }
            else {
                const dataStrs = rows.map(row => row.data);
                const probs = rows.map(row => row[os]);
                const probsArray = probs.map(p => p / probs.reduce((a, b) => a + b, 0));
                function weightedRandomChoice(weights) {
                    const sum = weights.reduce((acc, weight) => acc + weight, 0);
                    const threshold = Math.random() * sum;
                    let cumulativeSum = 0;
                    for (let i = 0; i < weights.length; i++) {
                        cumulativeSum += weights[i];
                        if (cumulativeSum >= threshold) {
                            return i;
                        }
                    }
                    return weights.length - 1; // Fallback in case of rounding errors
                }
                const idx = weightedRandomChoice(probsArray);
                resolve(JSON.parse(dataStrs[idx]));
            }
        });
    }).finally(() => {
        db.close();
    });
}
export async function getPossiblePairs() {
    const db = new Database(DB_PATH);
    const result = {};
    return new Promise((resolve, reject) => {
        const osTypes = Object.keys(OS_ARCH_MATRIX);
        let remaining = osTypes.length;
        osTypes.forEach(os_type => {
            db.all(`SELECT DISTINCT vendor, renderer FROM webgl_fingerprints WHERE ${os_type} > 0 ORDER BY ${os_type} DESC`, [], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                result[os_type] = rows;
                remaining--;
                if (remaining === 0) {
                    resolve(result);
                }
            });
        });
    }).finally(() => {
        db.close();
    });
}
