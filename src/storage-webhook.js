'use strict';

// Extracted storage domain: webhook secret persistence (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const WEBHOOK_STORAGE_KEY = kernel.WEBHOOK_STORAGE_KEY;
const validateWebhookUrl = kernel.validateWebhookUrl;
  function loadWebhookUrl() {
    if (gmStore() === null) {
      return null;
    }
    try {
      return validateWebhookUrl(
        gmStore().getValue(WEBHOOK_STORAGE_KEY, null)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Webhook URL read error:",
        error
      );
      return null;
    }
  }
  function saveWebhookUrl(url) {
    if (gmStore() === null) {
      return false;
    }
    const validated = validateWebhookUrl(url);
    if (validated === null) {
      return false;
    }
    try {
      gmStore().setValue(WEBHOOK_STORAGE_KEY, validated);
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Webhook URL save error:",
        error
      );
      return false;
    }
  }
  function clearWebhookUrl() {
    if (gmStore() === null) {
      return false;
    }
    try {
      gmStore().deleteValue(WEBHOOK_STORAGE_KEY);
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Webhook URL clear error:",
        error
      );
      return false;
    }
  }
module.exports = { loadWebhookUrl, saveWebhookUrl, clearWebhookUrl };
