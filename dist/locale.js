import { LOCAL_DATA, GitHubDownloader, webdl } from './pkgman.js';
import { LeakWarning } from './warnings.js';
import { InvalidLocale, MissingRelease, NotInstalledGeoIPExtra, UnknownIPLocation, UnknownLanguage, UnknownTerritory, } from './exceptions.js';
import { validateIP } from './ip.js';
import tags from 'language-tags';
import * as fs from 'fs';
import * as path from 'path';
import maxmind from 'maxmind';
import xml2js from 'xml2js';
import { getAsBooleanFromENV } from './utils.js';
export const ALLOW_GEOIP = true;
class Locale {
    language;
    region;
    script;
    constructor(language, region, script) {
        this.language = language;
        this.region = region;
        this.script = script;
    }
    asString() {
        if (this.region) {
            return `${this.language}-${this.region}`;
        }
        return this.language;
    }
    asConfig() {
        if (!this.region) {
            throw new Error("Region is required for config");
        }
        const data = {
            'locale:region': this.region,
            'locale:language': this.language,
        };
        if (this.script) {
            data['locale:script'] = this.script;
        }
        return data;
    }
}
class Geolocation {
    locale;
    longitude;
    latitude;
    timezone;
    accuracy;
    constructor(locale, longitude, latitude, timezone, accuracy) {
        this.locale = locale;
        this.longitude = longitude;
        this.latitude = latitude;
        this.timezone = timezone;
        this.accuracy = accuracy;
    }
    asConfig() {
        const data = {
            'geolocation:longitude': this.longitude,
            'geolocation:latitude': this.latitude,
            'timezone': this.timezone,
            ...this.locale.asConfig(),
        };
        if (this.accuracy !== undefined) {
            data['geolocation:accuracy'] = this.accuracy;
        }
        return data;
    }
}
function verifyLocale(loc) {
    if (tags.check(loc)) {
        return;
    }
    throw InvalidLocale.invalidInput(loc);
}
export function normalizeLocale(locale) {
    verifyLocale(locale);
    const parser = tags(locale);
    if (!parser.region) {
        throw InvalidLocale.invalidInput(locale);
    }
    return new Locale(parser.language()?.format() ?? 'en', parser.region()?.format(), parser.language()?.script()?.format());
}
export function handleLocale(locale, ignoreRegion = false) {
    if (locale.length > 3) {
        return normalizeLocale(locale);
    }
    try {
        return SELECTOR.fromRegion(locale);
    }
    catch (e) {
        if (e instanceof UnknownTerritory) {
        }
        else {
            throw e;
        }
    }
    if (ignoreRegion) {
        verifyLocale(locale);
        return new Locale(locale);
    }
    try {
        const language = SELECTOR.fromLanguage(locale);
        LeakWarning.warn('no_region');
        return language;
    }
    catch (e) {
        if (e instanceof UnknownLanguage) {
        }
        else {
            throw e;
        }
    }
    throw InvalidLocale.invalidInput(locale);
}
export function handleLocales(locales, config) {
    if (typeof locales === 'string') {
        locales = locales.split(',').map(loc => loc.trim());
    }
    const intlLocale = handleLocale(locales[0]);
    config = { ...config, ...intlLocale.asConfig() };
    if (locales.length < 2) {
        return;
    }
    config['locale:all'] = joinUnique(locales.map(locale => handleLocale(locale, true).asString()));
}
function joinUnique(seq) {
    const seen = new Set();
    return seq.filter(x => !seen.has(x) && seen.add(x)).join(', ');
}
const MMDB_FILE = path.join(LOCAL_DATA.toString(), 'GeoLite2-City.mmdb');
const MMDB_REPO = "P3TERX/GeoLite.mmdb";
class MaxMindDownloader extends GitHubDownloader {
    checkAsset(asset) {
        if (asset['name'].endsWith('-City.mmdb')) {
            return asset['browser_download_url'];
        }
        return null;
    }
    missingAssetError() {
        throw new MissingRelease('Failed to find GeoIP database release asset');
    }
}
export function geoipAllowed() {
    if (!ALLOW_GEOIP) {
        throw new NotInstalledGeoIPExtra('Please install the geoip extra to use this feature: pip install camoufox[geoip]');
    }
}
export async function downloadMMDB() {
    geoipAllowed();
    if (getAsBooleanFromENV('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', false)) {
        console.log("Skipping GeoIP database download due to PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set!");
        return;
    }
    const assetUrl = await (new MaxMindDownloader(MMDB_REPO).getAsset());
    const fileStream = fs.createWriteStream(MMDB_FILE);
    await webdl(assetUrl, 'Downloading GeoIP database', true, fileStream);
}
export function removeMMDB() {
    if (!fs.existsSync(MMDB_FILE)) {
        console.log("GeoIP database not found.");
        return;
    }
    fs.unlinkSync(MMDB_FILE);
    console.log("GeoIP database removed.");
}
export async function getGeolocation(ip) {
    if (!fs.existsSync(MMDB_FILE)) {
        await downloadMMDB();
    }
    validateIP(ip);
    const reader = await maxmind.open(MMDB_FILE);
    const resp = reader.get(ip);
    const isoCode = resp.country?.iso_code.toUpperCase();
    const location = resp.location;
    if (!location?.longitude || !location?.latitude || !location?.time_zone || !isoCode) {
        throw new UnknownIPLocation(`Unknown IP location: ${ip}`);
    }
    const locale = SELECTOR.fromRegion(isoCode);
    return new Geolocation(locale, location.longitude, location.latitude, location.time_zone);
}
async function getUnicodeInfo() {
    const data = await fs.promises.readFile(path.join(import.meta.dirname, 'data-files', 'territoryInfo.xml'));
    const parser = new xml2js.Parser();
    return parser.parseStringPromise(data);
}
function asFloat(element, attr) {
    return parseFloat(element[attr] || '0');
}
class StatisticalLocaleSelector {
    root;
    constructor() {
        this.loadUnicodeInfo();
    }
    async loadUnicodeInfo() {
        this.root = await getUnicodeInfo();
    }
    loadTerritoryData(isoCode) {
        const territory = this.root.territoryInfo.territory.find((t) => t.$.type === isoCode);
        if (!territory) {
            throw new UnknownTerritory(`Unknown territory: ${isoCode}`);
        }
        const langPopulations = territory.languagePopulation;
        if (!langPopulations) {
            throw new Error(`No language data found for region: ${isoCode}`);
        }
        const languages = langPopulations.map((lang) => lang.$.type);
        const percentages = langPopulations.map((lang) => asFloat(lang.$, 'populationPercent'));
        return this.normalizeProbabilities(languages, percentages);
    }
    loadLanguageData(language) {
        const territories = this.root.territory.filter((t) => t.languagePopulation.some((lp) => lp.$.type === language));
        if (!territories.length) {
            throw new UnknownLanguage(`No region data found for language: ${language}`);
        }
        const regions = [];
        const percentages = [];
        for (const terr of territories) {
            const region = terr.$.type;
            const langPop = terr.languagePopulation.find((lp) => lp.$.type === language);
            if (region && langPop) {
                regions.push(region);
                percentages.push(asFloat(langPop.$, 'populationPercent') *
                    asFloat(terr.$, 'literacyPercent') / 10000 *
                    asFloat(terr.$, 'population'));
            }
        }
        if (!regions.length) {
            throw new Error(`No valid region data found for language: ${language}`);
        }
        return this.normalizeProbabilities(regions, percentages);
    }
    normalizeProbabilities(languages, freq) {
        const total = freq.reduce((a, b) => a + b, 0);
        return [languages, freq.map(f => f / total)];
    }
    weightedRandomChoice(items, weights) {
        const cumulativeWeights = weights.map((sum => (value) => sum += value)(0));
        const random = Math.random() * cumulativeWeights[cumulativeWeights.length - 1];
        return items[cumulativeWeights.findIndex(weight => weight > random)];
    }
    fromRegion(region) {
        const [languages, probabilities] = this.loadTerritoryData(region);
        const language = this.weightedRandomChoice(languages, probabilities).replace('_', '-');
        return normalizeLocale(`${language}-${region}`);
    }
    fromLanguage(language) {
        const [regions, probabilities] = this.loadLanguageData(language);
        const region = this.weightedRandomChoice(regions, probabilities);
        return normalizeLocale(`${language}-${region}`);
    }
}
const SELECTOR = new StatisticalLocaleSelector();
