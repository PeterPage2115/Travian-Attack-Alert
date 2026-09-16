'use strict';

// Extracted storage domain: settings (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const SETTINGS_STORAGE_KEY = kernel.SETTINGS_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
  const DEFAULT_SETTINGS = {
    attackThreshold: 1,
    raidThreshold: 1,
    normalMax: 2,
    highMax: 5
  };
  function getDefaultSettings() {
    return {
      attackThreshold: DEFAULT_SETTINGS.attackThreshold,
      raidThreshold: DEFAULT_SETTINGS.raidThreshold,
      normalMax: DEFAULT_SETTINGS.normalMax,
      highMax: DEFAULT_SETTINGS.highMax
    };
  }
  function validateSettings(raw) {
    const defaults = getDefaultSettings();
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const readThreshold = (value, fallback) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
      }
      return Math.min(
        999,
        Math.max(1, Math.floor(value))
      );
    };
    const readBand = (value, fallback) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
      }
      return Math.max(1, Math.floor(value));
    };
    const settings = {
      attackThreshold: readThreshold(
        source.attackThreshold,
        defaults.attackThreshold
      ),
      raidThreshold: readThreshold(
        source.raidThreshold,
        defaults.raidThreshold
      ),
      normalMax: readBand(
        source.normalMax,
        defaults.normalMax
      ),
      highMax: readBand(
        source.highMax,
        defaults.highMax
      )
    };
    if (settings.normalMax >= settings.highMax) {
      settings.normalMax = defaults.normalMax;
      settings.highMax = defaults.highMax;
    }
    return settings;
  }
  function loadSettings(hostname) {
    if (keyValueStore() === null) {
      return getDefaultSettings();
    }
    try {
      const saved = keyValueStore().getItem(
        SETTINGS_STORAGE_KEY
      );
      const map = saved ? JSON.parse(saved) : {};
      const world = map && typeof map === "object" && !Array.isArray(map) ? map[normalizeHostname(hostname)] : null;
      return validateSettings(world);
    } catch (error) {
      console.error(
        "[Alliance Discord] Settings read error:",
        error
      );
      return getDefaultSettings();
    }
  }
  function saveSettings(settings, hostname) {
    if (keyValueStore() === null) {
      return;
    }
    try {
      const saved = keyValueStore().getItem(
        SETTINGS_STORAGE_KEY
      );
      let map = {};
      if (saved) {
        try {
          map = JSON.parse(saved);
        } catch (error) {
          map = {};
        }
      }
      const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
      const worldKey = normalizeHostname(hostname);
      const nextMap = Object.assign({}, base);
      nextMap[worldKey] = validateSettings(settings);
      keyValueStore().setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Settings save error:",
        error
      );
    }
  }
module.exports = { getDefaultSettings, validateSettings, loadSettings, saveSettings };
