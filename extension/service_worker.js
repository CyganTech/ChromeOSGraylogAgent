// ChromeOS Graylog Agent Service Worker
// Responsible for collecting device logs and forwarding them to Graylog.

const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const GRAYLOG_ENDPOINT_STORAGE_KEY = 'graylogEndpoint';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      [GRAYLOG_ENDPOINT_STORAGE_KEY]: {
        host: '',
        port: 12201,
        protocol: 'udp'
      }
    });
  }

  chrome.alarms.create('log-collector', {
    delayInMinutes: 1,
    periodInMinutes: DEFAULT_POLL_INTERVAL_MINUTES
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'log-collector') {
    return;
  }

  scheduleLogHarvest();
});

async function scheduleLogHarvest() {
  try {
    const endpoint = await getGraylogEndpoint();
    if (!endpoint.host) {
      console.warn('[ChromeOS Graylog Agent] Graylog endpoint not configured.');
      return;
    }

    const payload = await collectLogBundle();
    if (!payload) {
      console.warn('[ChromeOS Graylog Agent] No payload collected.');
      return;
    }

    await forwardToGraylog(endpoint, payload);
  } catch (error) {
    console.error('[ChromeOS Graylog Agent] Failed to harvest logs', error);
  }
}

function getGraylogEndpoint() {
  return new Promise((resolve) => {
    chrome.storage.local.get(GRAYLOG_ENDPOINT_STORAGE_KEY, (data) => {
      resolve(data[GRAYLOG_ENDPOINT_STORAGE_KEY]);
    });
  });
}

async function collectLogBundle() {
  // TODO: Implement logPrivate and diagnostics APIs to gather relevant logs.
  return {
    timestamp: new Date().toISOString(),
    deviceAttributes: await getDeviceAttributes(),
    logs: []
  };
}

function getDeviceAttributes() {
  return new Promise((resolve) => {
    chrome.enterprise.deviceAttributes.getDeviceSerialNumber((serialNumber) => {
      resolve({
        serialNumber
      });
    });
  });
}

async function forwardToGraylog(endpoint, payload) {
  // Placeholder implementation for Graylog GELF HTTP input.
  const url = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}/gelf`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error('[ChromeOS Graylog Agent] Failed to forward logs', error);
  }
}
