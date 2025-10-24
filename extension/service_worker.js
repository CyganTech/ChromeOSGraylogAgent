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

  ensureLogCollectionAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureLogCollectionAlarm();
});

function ensureLogCollectionAlarm() {
  chrome.alarms.get('log-collector', (existingAlarm) => {
    if (chrome.runtime.lastError) {
      console.warn('[ChromeOS Graylog Agent] Failed to inspect alarms', chrome.runtime.lastError);
      return;
    }

    if (existingAlarm) {
      return;
    }

    chrome.alarms.create('log-collector', {
      delayInMinutes: 1,
      periodInMinutes: DEFAULT_POLL_INTERVAL_MINUTES
    });
  });
}

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

    if (typeof self?.navigator?.onLine === 'boolean' && !self.navigator.onLine) {
      console.warn('[ChromeOS Graylog Agent] Device appears to be offline; skipping harvest.');
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
      if (chrome.runtime.lastError) {
        console.warn('[ChromeOS Graylog Agent] Failed to read endpoint configuration', chrome.runtime.lastError);
      }

      const stored = data?.[GRAYLOG_ENDPOINT_STORAGE_KEY];
      resolve(
        stored && typeof stored === 'object'
          ? stored
          : { host: '', port: 12201, protocol: 'udp' }
      );
    });
  });
}

async function collectLogBundle() {
  const collectionErrors = [];

  const [deviceAttributes, runtimeContext, diagnostics, logArtifacts] = await Promise.all([
    getDeviceAttributes(collectionErrors),
    getRuntimeContext(collectionErrors),
    getSystemDiagnostics(collectionErrors),
    collectLogPrivateArtifacts(collectionErrors)
  ]);

  const payload = {
    timestamp: new Date().toISOString(),
    deviceAttributes,
    runtimeContext,
    diagnostics,
    logArtifacts
  };

  if (collectionErrors.length > 0) {
    payload.collectionErrors = collectionErrors;
  }

  return payload;
}

async function getDeviceAttributes(errorLog) {
  const attributesApi = chrome.enterprise?.deviceAttributes;
  if (!attributesApi) {
    return null;
  }

  const attributes = {};

  if (typeof attributesApi.getDeviceSerialNumber === 'function') {
    attributes.serialNumber = await safeInvoke(
      'enterprise.deviceAttributes.getDeviceSerialNumber',
      () => callChromeApi(attributesApi.getDeviceSerialNumber, attributesApi),
      errorLog
    );
  }

  if (typeof attributesApi.getDeviceAssetId === 'function') {
    attributes.assetId = await safeInvoke(
      'enterprise.deviceAttributes.getDeviceAssetId',
      () => callChromeApi(attributesApi.getDeviceAssetId, attributesApi),
      errorLog
    );
  }

  if (typeof attributesApi.getDeviceAnnotatedLocation === 'function') {
    attributes.annotatedLocation = await safeInvoke(
      'enterprise.deviceAttributes.getDeviceAnnotatedLocation',
      () => callChromeApi(attributesApi.getDeviceAnnotatedLocation, attributesApi),
      errorLog
    );
  }

  if (typeof attributesApi.getDirectoryDeviceId === 'function') {
    attributes.directoryDeviceId = await safeInvoke(
      'enterprise.deviceAttributes.getDirectoryDeviceId',
      () => callChromeApi(attributesApi.getDirectoryDeviceId, attributesApi),
      errorLog
    );
  }

  if (typeof attributesApi.getDeviceHostname === 'function') {
    attributes.hostname = await safeInvoke(
      'enterprise.deviceAttributes.getDeviceHostname',
      () => callChromeApi(attributesApi.getDeviceHostname, attributesApi),
      errorLog
    );
  }

  return Object.keys(attributes).length > 0 ? attributes : null;
}

async function getRuntimeContext(errorLog) {
  const manifest = chrome.runtime.getManifest();
  const platformInfo = await safeInvoke(
    'runtime.getPlatformInfo',
    () => callChromeApi(chrome.runtime.getPlatformInfo, chrome.runtime),
    errorLog
  );

  return {
    extension: {
      id: chrome.runtime.id,
      version: manifest?.version,
      manifestVersion: manifest?.manifest_version,
      name: manifest?.name
    },
    platform: platformInfo,
    userAgent: self?.navigator?.userAgent ?? null
  };
}

async function getSystemDiagnostics(errorLog) {
  const diagnostics = {};

  if (chrome.system?.memory?.getInfo) {
    diagnostics.memory = await safeInvoke(
      'system.memory.getInfo',
      () => callChromeApi(chrome.system.memory.getInfo, chrome.system.memory),
      errorLog
    );
  }

  if (chrome.system?.cpu?.getInfo) {
    diagnostics.cpu = await safeInvoke(
      'system.cpu.getInfo',
      () => callChromeApi(chrome.system.cpu.getInfo, chrome.system.cpu),
      errorLog
    );
  }

  if (chrome.system?.storage?.getInfo) {
    const storageInfo = await safeInvoke(
      'system.storage.getInfo',
      () => callChromeApi(chrome.system.storage.getInfo, chrome.system.storage),
      errorLog,
      []
    );

    diagnostics.storage = [];

    if (Array.isArray(storageInfo)) {
      for (const unit of storageInfo) {
        const capacity = await safeInvoke(
          `system.storage.getAvailableCapacity(${unit.id})`,
          () => callChromeApi(
            chrome.system.storage.getAvailableCapacity,
            chrome.system.storage,
            unit.id
          ),
          errorLog
        );

        diagnostics.storage.push({
          id: unit.id,
          name: unit.name,
          type: unit.type,
          capacity: unit.capacity,
          availableCapacity: capacity?.availableCapacity ?? null
        });
      }
    }
  }

  return Object.keys(diagnostics).length > 0 ? diagnostics : null;
}

async function collectLogPrivateArtifacts(errorLog) {
  const logPrivate = chrome.logPrivate;
  if (!logPrivate) {
    return null;
  }

  const artifacts = {};

  if (typeof logPrivate.getSystemLogs === 'function') {
    artifacts.systemLogs = await safeInvoke(
      'logPrivate.getSystemLogs',
      () => callChromeApi(logPrivate.getSystemLogs, logPrivate),
      errorLog,
      []
    );
  }

  if (typeof logPrivate.getSystemInfo === 'function') {
    artifacts.systemInfo = await safeInvoke(
      'logPrivate.getSystemInfo',
      () => callChromeApi(logPrivate.getSystemInfo, logPrivate),
      errorLog
    );
  }

  if (typeof logPrivate.getLogEvents === 'function') {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const logEventFilter = { startTime: oneHourAgo };
    artifacts.logEvents = await safeInvoke(
      'logPrivate.getLogEvents',
      () => callChromeApi(logPrivate.getLogEvents, logPrivate, logEventFilter),
      errorLog,
      []
    );
  }

  return Object.keys(artifacts).length > 0 ? artifacts : null;
}

function callChromeApi(fn, thisArg, ...args) {
  return new Promise((resolve, reject) => {
    if (typeof fn !== 'function') {
      reject(new Error('API not available'));
      return;
    }

    const callback = (...callbackArgs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (callbackArgs.length === 0) {
        resolve();
        return;
      }

      if (callbackArgs.length === 1) {
        resolve(callbackArgs[0]);
        return;
      }

      resolve(callbackArgs);
    };

    try {
      fn.call(thisArg, ...args, callback);
    } catch (error) {
      reject(error);
    }
  });
}

async function safeInvoke(description, fn, errorLog, defaultValue = null) {
  try {
    const result = await fn();
    return result ?? defaultValue;
  } catch (error) {
    const message = `[ChromeOS Graylog Agent] ${description} failed`;
    console.warn(message, error);
    if (Array.isArray(errorLog)) {
      errorLog.push({ description, message: error.message });
    }
    return defaultValue;
  }
}

async function forwardToGraylog(endpoint, payload) {
  // Placeholder implementation for Graylog GELF HTTP input.
  const url = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}/gelf`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const message =
      error?.name === 'AbortError'
        ? 'Forwarding timed out while contacting Graylog.'
        : 'Failed to forward logs to Graylog.';
    console.warn(`[ChromeOS Graylog Agent] ${message}`, error);
  }
  clearTimeout(timeoutId);
}
