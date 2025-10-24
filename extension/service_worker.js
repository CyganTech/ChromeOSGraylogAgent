// ChromeOS Graylog Agent Service Worker
// Responsible for collecting device logs and forwarding them to Graylog with
// policy-aware configuration, delivery retries, and diagnostics telemetry.

const HARVEST_ALARM_NAME = 'log-collector';
const RETRY_ALARM_NAME = 'log-delivery-retry';
const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const DEFAULT_GUARD_THRESHOLD_MINUTES = 10;
const DEFAULT_ENDPOINT = Object.freeze({ host: '', port: 12201, protocol: 'https' });
const GRAYLOG_SETTINGS_STORAGE_KEY = 'graylogSettings';
const GRAYLOG_ENDPOINT_STORAGE_KEY = 'graylogEndpoint'; // Legacy key retained for backwards compatibility.
const GRAYLOG_DELIVERY_QUEUE_STORAGE_KEY = 'graylogDeliveryQueue';
const DIAGNOSTICS_STORAGE_KEY = 'graylogDiagnostics';
const MAX_DIAGNOSTIC_ENTRIES = 100;
const DIAGNOSTIC_RETENTION_DAYS = 30;
const MAX_DELIVERY_QUEUE_LENGTH = 6;
const MAX_DELIVERY_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30 * 1000;
const MAX_BACKOFF_DELAY_MS = 60 * 60 * 1000;
const PAYLOAD_SIZE_LIMIT_BYTES = 512 * 1024;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9.-]+$/;
const MAX_STORAGE_BUDGET_BYTES = 4 * 1024 * 1024; // Safety margin below Chrome's 5 MiB quota.
const DIAGNOSTIC_RETENTION_WINDOW_MS = DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const transientDiagnostics = [];
const manifestHostPermissionMatchers = buildManifestHostPermissionMatchers();

enforceDiagnosticRetention().catch((error) => {
  console.warn('[ChromeOS Graylog Agent] Failed to enforce diagnostic retention on startup', error);
});

let harvestInProgress = false;
let harvestGuardTimer = null;
let deliveryFlushInProgress = false;
let runtimeConfiguration = null;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await initializeDefaultSettings();
  }

  runtimeConfiguration = null;
  await ensureLogCollectionAlarm(true);
  await flushDeliveryQueue();
});

chrome.runtime.onStartup.addListener(async () => {
  runtimeConfiguration = null;
  await ensureLogCollectionAlarm(true);
  await flushDeliveryQueue();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  const managedUpdated =
    areaName === 'managed' && Object.prototype.hasOwnProperty.call(changes, 'graylogConfig');
  const localUpdated =
    areaName === 'local' &&
    (Object.prototype.hasOwnProperty.call(changes, GRAYLOG_SETTINGS_STORAGE_KEY) ||
      Object.prototype.hasOwnProperty.call(changes, GRAYLOG_ENDPOINT_STORAGE_KEY));

  if (!managedUpdated && !localUpdated) {
    return;
  }

  runtimeConfiguration = null;
  await ensureLogCollectionAlarm(true);

  if (managedUpdated) {
    await recordDiagnostic('policy-configuration-updated');
  }

  if (managedUpdated || localUpdated) {
    await flushDeliveryQueue();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HARVEST_ALARM_NAME) {
    await scheduleLogHarvest();
    return;
  }

  if (alarm.name === RETRY_ALARM_NAME) {
    await flushDeliveryQueue();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const responsePromise = handleAdministrativeMessage(message, sender);
  if (!responsePromise) {
    return false;
  }

  responsePromise
    .then((payload) => {
      sendResponse({ success: true, ...payload });
    })
    .catch((error) => {
      console.warn('[ChromeOS Graylog Agent] Administrative request failed', error);
      sendResponse({ success: false, message: error?.message ?? String(error) });
    });

  return true;
});

async function initializeDefaultSettings() {
  const settings = {
    endpoint: { ...DEFAULT_ENDPOINT },
    pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
    guardThresholdMinutes: DEFAULT_GUARD_THRESHOLD_MINUTES,
    allowHttpForTesting: false,
    allowedHosts: []
  };

  await setStorageLocal({
    [GRAYLOG_SETTINGS_STORAGE_KEY]: settings,
    [GRAYLOG_ENDPOINT_STORAGE_KEY]: { ...DEFAULT_ENDPOINT }
  });
}

async function ensureLogCollectionAlarm(forceUpdate = false) {
  const config = await getRuntimeConfiguration();
  const pollIntervalMinutes = sanitizePollInterval(config.pollIntervalMinutes);

  await new Promise((resolve) => {
    chrome.alarms.get(HARVEST_ALARM_NAME, (existingAlarm) => {
      if (chrome.runtime.lastError) {
        console.warn('[ChromeOS Graylog Agent] Failed to inspect alarms', chrome.runtime.lastError);
        resolve();
        return;
      }

      if (
        !forceUpdate &&
        existingAlarm &&
        typeof existingAlarm.periodInMinutes === 'number' &&
        Math.abs(existingAlarm.periodInMinutes - pollIntervalMinutes) < 0.01
      ) {
        resolve();
        return;
      }

      chrome.alarms.create(HARVEST_ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: pollIntervalMinutes
      });
      resolve();
    });
  });
}

async function scheduleLogHarvest() {
  if (harvestInProgress) {
    console.warn(
      '[ChromeOS Graylog Agent] Previous harvest still in progress; skipping this cycle to avoid overlap.'
    );
    return;
  }

  harvestInProgress = true;

  try {
    const config = await getRuntimeConfiguration();
    const guardThresholdMs = computeGuardThresholdMs(config);

    clearTimeout(harvestGuardTimer);
    harvestGuardTimer = setTimeout(() => {
      console.warn(
        '[ChromeOS Graylog Agent] Harvest exceeded expected duration; allowing future cycles to proceed.'
      );
      harvestInProgress = false;
      harvestGuardTimer = null;
    }, guardThresholdMs);

    const endpoint = config.endpoint;
    if (!endpoint.host) {
      console.warn('[ChromeOS Graylog Agent] Graylog endpoint not configured.');
      await recordDiagnostic('endpoint-missing');
      return;
    }

    await flushDeliveryQueue({ allowDuringHarvest: true });

    if (typeof self?.navigator?.onLine === 'boolean' && !self.navigator.onLine) {
      console.warn('[ChromeOS Graylog Agent] Device appears to be offline; skipping harvest.');
      await recordDiagnostic('device-offline');
      return;
    }

    const payload = await collectLogBundle();
    if (!payload) {
      console.warn('[ChromeOS Graylog Agent] No payload collected.');
      return;
    }

    const compactPayload = pruneEmptySections(payload);
    if (!compactPayload) {
      console.warn('[ChromeOS Graylog Agent] Payload contained no actionable data after pruning.');
      return;
    }

    const boundedPayload = await enforcePayloadConstraints(compactPayload);

    const delivered = await forwardToGraylog(endpoint, boundedPayload);
    if (!delivered) {
      await enqueuePayloadForRetry(endpoint, boundedPayload, 0);
    }
  } catch (error) {
    console.error('[ChromeOS Graylog Agent] Failed to harvest logs', error);
    await recordDiagnostic('harvest-failed', { message: error?.message ?? String(error) });
  } finally {
    harvestInProgress = false;
    clearTimeout(harvestGuardTimer);
    harvestGuardTimer = null;
  }
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

function pruneEmptySections(value) {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value)) {
    const prunedArray = value
      .map((entry) => pruneEmptySections(entry))
      .filter((entry) => entry !== null);

    return prunedArray.length > 0 ? prunedArray : null;
  }

  if (typeof value === 'object') {
    const prunedObject = Object.entries(value).reduce((acc, [key, entry]) => {
      const prunedEntry = pruneEmptySections(entry);
      if (prunedEntry !== null) {
        acc[key] = prunedEntry;
      }
      return acc;
    }, {});

    return Object.keys(prunedObject).length > 0 ? prunedObject : null;
  }

  return value;
}

async function getDeviceAttributes(errorLog) {
  const attributesApi = chrome.enterprise?.deviceAttributes;
  if (!attributesApi) {
    await recordDiagnostic('device-attributes-unavailable');
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

  const attributeKeys = Object.keys(attributes);
  if (attributeKeys.length === 0) {
    await recordDiagnostic('device-attributes-empty');
    return null;
  }

  return attributes;
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
          () => callChromeApi(chrome.system.storage.getAvailableCapacity, chrome.system.storage, unit.id),
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
    await recordDiagnostic('log-private-unavailable');
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
    await recordDiagnostic('api-error', { description, message: error.message });
    return defaultValue;
  }
}

async function forwardToGraylog(endpoint, payload) {
  if (!endpoint?.host) {
    return false;
  }

  if (typeof self?.navigator?.onLine === 'boolean' && !self.navigator.onLine) {
    await recordDiagnostic('delivery-aborted-offline', { host: endpoint.host });
    return false;
  }

  let body;
  try {
    body = JSON.stringify(payload);
  } catch (error) {
    await recordDiagnostic('serialization-failed', { message: error?.message ?? String(error) });
    return false;
  }

  const url = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}/gelf`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body,
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return true;
  } catch (error) {
    const message =
      error?.name === 'AbortError'
        ? 'Forwarding timed out while contacting Graylog.'
        : 'Failed to forward logs to Graylog.';
    console.warn(`[ChromeOS Graylog Agent] ${message}`, error);
    await recordDiagnostic('delivery-failed', {
      host: endpoint.host,
      port: endpoint.port,
      protocol: endpoint.protocol,
      message: error?.message ?? String(error)
    });
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function enqueuePayloadForRetry(endpoint, payload, attempt) {
  const queue = await loadDeliveryQueue();
  const entry = createRetryEntry(endpoint, payload, attempt);
  queue.push(entry);

  const budget = enforceQueueBudget(queue);
  if (budget.removed > 0) {
    await recordDiagnostic('delivery-queue-trimmed', {
      removed: budget.removed,
      trimmedByCount: budget.trimmedByCount,
      trimmedBySize: budget.trimmedBySize,
      remaining: budget.queue.length
    });
  }

  await saveDeliveryQueue(budget.queue);
  await scheduleRetryAlarm(budget.queue);
  await recordDiagnostic('delivery-queued', {
    host: endpoint.host,
    attempt
  });
}

async function flushDeliveryQueue(options = {}) {
  const allowDuringHarvest = options.allowDuringHarvest === true;

  if (deliveryFlushInProgress) {
    return;
  }

  if (harvestInProgress && !allowDuringHarvest) {
    return;
  }

  deliveryFlushInProgress = true;

  try {
    await processDeliveryQueue();
  } finally {
    deliveryFlushInProgress = false;
  }
}

async function processDeliveryQueue() {
  const queue = await loadDeliveryQueue();

  if (queue.length === 0) {
    await clearRetryAlarm();
    return;
  }

  const now = Date.now();
  let nextQueue = [];
  let mutated = false;

  for (const entry of queue) {
    if (!entry || typeof entry !== 'object') {
      mutated = true;
      continue;
    }

    const nextAttemptTime = typeof entry.nextAttemptTime === 'number' ? entry.nextAttemptTime : now;
    if (nextAttemptTime > now) {
      nextQueue.push(entry);
      continue;
    }

    const delivered = await forwardToGraylog(entry.endpoint, entry.payload);
    if (delivered) {
      mutated = true;
      continue;
    }

    const nextAttempt = (Number(entry.attempt) || 0) + 1;
    if (nextAttempt >= MAX_DELIVERY_ATTEMPTS) {
      mutated = true;
      await recordDiagnostic('delivery-abandoned', {
        host: entry.endpoint?.host ?? 'unknown',
        attempts: nextAttempt
      });
      continue;
    }

    const updatedEntry = createRetryEntry(entry.endpoint, entry.payload, nextAttempt);
    updatedEntry.attempt = nextAttempt;
    nextQueue.push(updatedEntry);
    mutated = true;
  }

  let finalQueue = nextQueue;
  if (mutated) {
    const budget = enforceQueueBudget(nextQueue);
    finalQueue = budget.queue;
    if (budget.removed > 0) {
      await recordDiagnostic('delivery-queue-trimmed', {
        removed: budget.removed,
        trimmedByCount: budget.trimmedByCount,
        trimmedBySize: budget.trimmedBySize,
        remaining: finalQueue.length
      });
    }
    await saveDeliveryQueue(finalQueue);
  } else {
    finalQueue = queue;
  }

  await scheduleRetryAlarm(finalQueue);
}

async function loadDeliveryQueue() {
  const { data } = await getStorageLocal(GRAYLOG_DELIVERY_QUEUE_STORAGE_KEY);
  const queue = data?.[GRAYLOG_DELIVERY_QUEUE_STORAGE_KEY];

  if (!Array.isArray(queue)) {
    return [];
  }

  const normalized = queue
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const attempt = Number(entry.attempt) || 0;
      const nextAttemptTime =
        typeof entry.nextAttemptTime === 'number' ? entry.nextAttemptTime : Date.now();

      return {
        endpoint: entry.endpoint,
        payload: entry.payload,
        attempt,
        nextAttemptTime
      };
    })
    .filter(Boolean);

  const budget = enforceQueueBudget(normalized);
  if (budget.removed > 0) {
    await recordDiagnostic('delivery-queue-trimmed', {
      removed: budget.removed,
      trimmedByCount: budget.trimmedByCount,
      trimmedBySize: budget.trimmedBySize,
      remaining: budget.queue.length
    });
    await saveDeliveryQueue(budget.queue);
    return budget.queue;
  }

  return normalized;
}

async function saveDeliveryQueue(queue) {
  await setStorageLocal({ [GRAYLOG_DELIVERY_QUEUE_STORAGE_KEY]: queue });
}

async function scheduleRetryAlarm(queue) {
  if (!Array.isArray(queue) || queue.length === 0) {
    await clearRetryAlarm();
    return;
  }

  const nextAttemptTime = queue.reduce((earliest, entry) => {
    if (!entry || typeof entry.nextAttemptTime !== 'number') {
      return earliest;
    }
    return Math.min(earliest, entry.nextAttemptTime);
  }, Number.POSITIVE_INFINITY);

  if (!Number.isFinite(nextAttemptTime)) {
    await clearRetryAlarm();
    return;
  }

  await new Promise((resolve) => {
    chrome.alarms.create(RETRY_ALARM_NAME, { when: nextAttemptTime });
    resolve();
  });
}

async function clearRetryAlarm() {
  await new Promise((resolve) => {
    chrome.alarms.clear(RETRY_ALARM_NAME, () => resolve());
  });
}

function computeBackoffDelay(attempt) {
  const exponent = Math.max(0, Math.min(attempt, 10));
  const base = BACKOFF_BASE_MS * Math.pow(2, exponent);
  const jitter = Math.random() * base * 0.25;
  return Math.min(base + jitter, MAX_BACKOFF_DELAY_MS);
}

function createRetryEntry(endpoint, payload, attempt) {
  const delay = computeBackoffDelay(attempt);
  return {
    endpoint: cloneSerializable(endpoint),
    payload: cloneSerializable(payload),
    attempt,
    nextAttemptTime: Date.now() + delay
  };
}

function enforceQueueBudget(queue) {
  const working = Array.isArray(queue) ? [...queue] : [];
  let trimmedByCount = 0;
  while (working.length > MAX_DELIVERY_QUEUE_LENGTH) {
    working.shift();
    trimmedByCount += 1;
  }

  let trimmedBySize = 0;
  let estimatedSize = estimateQueueSizeBytes(working);
  while (estimatedSize > MAX_STORAGE_BUDGET_BYTES && working.length > 0) {
    working.shift();
    trimmedBySize += 1;
    estimatedSize = estimateQueueSizeBytes(working);
  }

  return {
    queue: working,
    removed: trimmedByCount + trimmedBySize,
    trimmedByCount,
    trimmedBySize,
    estimatedSize
  };
}

function estimateQueueSizeBytes(entries) {
  try {
    const serialized = JSON.stringify(entries ?? []);
    if (typeof serialized !== 'string') {
      return 0;
    }
    return new TextEncoder().encode(serialized).length;
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to estimate queue size', error);
    return Number.MAX_SAFE_INTEGER;
  }
}

function diagnosticsEntriesMatch(a, b) {
  if (!a || !b) {
    return false;
  }

  if (a.code !== b.code) {
    return false;
  }

  try {
    const aDetails = JSON.stringify(a.details ?? {});
    const bDetails = JSON.stringify(b.details ?? {});
    return aDetails === bDetails;
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to compare diagnostic entries', error);
    return false;
  }
}

function filterHostsAgainstManifest(hosts, allowHttpForTesting) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    return { hosts: [], removed: [] };
  }

  const sanitized = [];
  const removed = [];

  for (const host of hosts) {
    const httpsAllowed = manifestHostPermissionMatchers.some((matcher) => matcher('https', host));
    const httpAllowed = allowHttpForTesting
      ? manifestHostPermissionMatchers.some((matcher) => matcher('http', host))
      : true;

    if (httpsAllowed && httpAllowed) {
      sanitized.push(host);
    } else {
      removed.push({
        host,
        missingHttps: !httpsAllowed,
        missingHttp: allowHttpForTesting && !httpAllowed
      });
    }
  }

  return { hosts: sanitized, removed };
}

function buildManifestHostPermissionMatchers() {
  if (!chrome?.runtime?.getManifest) {
    return [];
  }

  try {
    const manifest = chrome.runtime.getManifest();
    const patterns = Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : [];
    return patterns
      .map((pattern) => createManifestHostMatcher(pattern))
      .filter(Boolean);
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to inspect manifest host permissions', error);
    return [];
  }
}

function createManifestHostMatcher(pattern) {
  if (pattern === '<all_urls>') {
    return () => true;
  }

  if (typeof pattern !== 'string') {
    return null;
  }

  const trimmed = pattern.trim();
  const schemeSplit = trimmed.split('://');
  if (schemeSplit.length !== 2) {
    return null;
  }

  const scheme = schemeSplit[0].toLowerCase();
  const remainder = schemeSplit[1];
  const slashIndex = remainder.indexOf('/');
  const hostPattern = (slashIndex === -1 ? remainder : remainder.slice(0, slashIndex)).toLowerCase();

  return (protocol, host) => {
    if (!protocol || !host) {
      return false;
    }

    const normalizedProtocol = protocol.toLowerCase();
    const normalizedHost = host.toLowerCase();

    if (scheme !== '*' && scheme !== '<all_urls>' && scheme !== normalizedProtocol) {
      return false;
    }

    if (hostPattern === '*') {
      return true;
    }

    if (hostPattern.startsWith('*.')) {
      const suffix = hostPattern.slice(2);
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    }

    return hostPattern === normalizedHost;
  };
}

async function handleAdministrativeMessage(message, sender) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  if (sender?.id && sender.id !== chrome.runtime.id) {
    return null;
  }

  const action = typeof message.type === 'string' ? message.type : message.action;

  switch (action) {
    case 'graylog:exportDiagnostics':
      return (async () => ({ diagnostics: await collectDiagnosticsSnapshot() }))();
    case 'graylog:clearRetryQueue':
      return (async () => {
        await saveDeliveryQueue([]);
        await clearRetryAlarm();
        await recordDiagnostic('delivery-queue-cleared', { source: 'admin-request' });
        return { cleared: true };
      })();
    case 'graylog:flushRetryQueue':
      return (async () => {
        await flushDeliveryQueue({ allowDuringHarvest: true });
        const queue = await loadDeliveryQueue();
        await recordDiagnostic('delivery-queue-flush-requested', {
          source: 'admin-request',
          remaining: queue.length
        });
        return { remaining: queue.length };
      })();
    case 'graylog:clearDiagnostics':
      return (async () => {
        transientDiagnostics.length = 0;
        await setStorageLocal({ [DIAGNOSTICS_STORAGE_KEY]: [] });
        return { cleared: true };
      })();
    default:
      return null;
  }
}

async function collectDiagnosticsSnapshot() {
  const { data, success } = await getStorageLocal(DIAGNOSTICS_STORAGE_KEY);
  const persisted = success && Array.isArray(data?.[DIAGNOSTICS_STORAGE_KEY])
    ? data[DIAGNOSTICS_STORAGE_KEY]
    : [];

  const merged = mergeDiagnostics(persisted, transientDiagnostics);
  return merged;
}

function mergeDiagnostics(persisted, transient) {
  const combined = [];
  const seen = new Set();

  const append = (entry) => {
    if (!entry) {
      return;
    }
    const key = buildDiagnosticIdentity(entry);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    combined.push(entry);
  };

  persisted.forEach(append);
  transient.forEach(append);

  combined.sort((a, b) => {
    const aTime = Date.parse(a?.timestamp ?? '') || 0;
    const bTime = Date.parse(b?.timestamp ?? '') || 0;
    return aTime - bTime;
  });

  return combined.slice(-MAX_DIAGNOSTIC_ENTRIES);
}

function buildDiagnosticIdentity(entry) {
  try {
    return [entry?.code ?? 'unknown', JSON.stringify(entry?.details ?? {}), entry?.timestamp ?? ''].join('|');
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to build diagnostic identity', error);
    return `${entry?.code ?? 'unknown'}|${entry?.timestamp ?? ''}`;
  }
}

function computeGuardThresholdMs(config) {
  const pollInterval = sanitizePollInterval(config.pollIntervalMinutes);
  const guardMinutes = Math.max(
    sanitizeOptionalNumber(config.guardThresholdMinutes) ?? DEFAULT_GUARD_THRESHOLD_MINUTES,
    pollInterval
  );

  return guardMinutes * 60 * 1000;
}

function sanitizePollInterval(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.min(parsed, 24 * 60);
  }
  return DEFAULT_POLL_INTERVAL_MINUTES;
}

function sanitizeOptionalNumber(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

async function enforcePayloadConstraints(payload) {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    await recordDiagnostic('serialization-failed', { message: error?.message ?? String(error) });
    return payload;
  }

  const originalSize = serialized.length;
  const originalSystemLogCount = Array.isArray(payload?.logArtifacts?.systemLogs)
    ? payload.logArtifacts.systemLogs.length
    : 0;

  if (serialized.length <= PAYLOAD_SIZE_LIMIT_BYTES) {
    return payload;
  }

  const trimmed = cloneSerializable(payload);
  let truncated = false;
  let systemLogTruncations = 0;
  let systemLogsRemoved = false;
  let logArtifactsRemoved = false;

  if (trimmed?.logArtifacts?.systemLogs) {
    const logs = Array.isArray(trimmed.logArtifacts.systemLogs)
      ? trimmed.logArtifacts.systemLogs
      : [];
    const normalizedLogs = logs.slice(0, 10).map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }

      if (typeof entry.log === 'string' && entry.log.length > 4096) {
        truncated = true;
        systemLogTruncations += 1;
        return { ...entry, log: entry.log.slice(-4096), truncated: true };
      }

      return entry;
    });

    trimmed.logArtifacts.systemLogs = normalizedLogs;
    truncated = true;
  }

  serialized = JSON.stringify(trimmed);
  if (serialized.length > PAYLOAD_SIZE_LIMIT_BYTES && trimmed?.logArtifacts) {
    delete trimmed.logArtifacts.systemLogs;
    trimmed.logArtifactsTruncated = true;
    serialized = JSON.stringify(trimmed);
    truncated = true;
    systemLogsRemoved = true;
  }

  if (serialized.length > PAYLOAD_SIZE_LIMIT_BYTES && trimmed.logArtifacts) {
    delete trimmed.logArtifacts;
    trimmed.payloadTruncated = true;
    truncated = true;
    logArtifactsRemoved = true;
  }

  if (truncated) {
    const remainingSystemLogCount = Array.isArray(trimmed?.logArtifacts?.systemLogs)
      ? trimmed.logArtifacts.systemLogs.length
      : 0;

    await recordDiagnostic('payload-truncated', {
      originalSize,
      finalSize: serialized.length,
      logArtifactsTruncated: trimmed?.logArtifactsTruncated === true,
      payloadTruncated: trimmed?.payloadTruncated === true,
      systemLogEntriesBefore: originalSystemLogCount,
      systemLogEntriesAfter: remainingSystemLogCount,
      systemLogTruncations,
      systemLogsRemoved,
      logArtifactsRemoved
    });
  }

  return trimmed;
}

function cloneSerializable(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to clone payload', error);
    return value;
  }
}

async function getRuntimeConfiguration() {
  if (runtimeConfiguration) {
    return runtimeConfiguration;
  }

  runtimeConfiguration = await loadConfiguration();
  return runtimeConfiguration;
}

async function loadConfiguration() {
  const [managedConfig, localConfig] = await Promise.all([
    readManagedConfiguration(),
    readLocalConfiguration()
  ]);

  if (managedConfig?.endpointErrors?.length) {
    await recordDiagnostic('managed-endpoint-invalid', { errors: managedConfig.endpointErrors });
  }

  if (localConfig?.endpointErrors?.length) {
    await recordDiagnostic('local-endpoint-invalid', { errors: localConfig.endpointErrors });
  }

  const merged = mergeConfigurations(localConfig, managedConfig);
  return merged;
}

async function readManagedConfiguration() {
  const data = await getStorageManaged('graylogConfig');
  const rawConfig = data?.graylogConfig;
  return normalizeConfigurationSource(rawConfig);
}

async function readLocalConfiguration() {
  const { data } = await getStorageLocal([GRAYLOG_SETTINGS_STORAGE_KEY, GRAYLOG_ENDPOINT_STORAGE_KEY]);
  const settings = data?.[GRAYLOG_SETTINGS_STORAGE_KEY];
  const legacyEndpoint = data?.[GRAYLOG_ENDPOINT_STORAGE_KEY];

  if (settings && typeof settings === 'object') {
    return normalizeConfigurationSource({ ...settings });
  }

  if (legacyEndpoint && typeof legacyEndpoint === 'object') {
    return normalizeConfigurationSource({ endpoint: legacyEndpoint });
  }

  return null;
}

function normalizeConfigurationSource(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const allowHttpForTesting = raw.allowHttpForTesting === true;
  const allowedHosts = Array.isArray(raw.allowedHosts)
    ? raw.allowedHosts
        .map((host) => (typeof host === 'string' ? host.trim() : ''))
        .filter((host) => host && HOSTNAME_PATTERN.test(host))
    : [];

  const hostPermissionCheck = filterHostsAgainstManifest(allowedHosts, allowHttpForTesting);
  const sanitizedAllowedHosts = hostPermissionCheck.hosts;
  hostPermissionCheck.removed.forEach((item) => {
    recordDiagnostic('host-permission-mismatch', {
      host: item.host,
      missingHttps: item.missingHttps === true,
      missingHttp: item.missingHttp === true
    }).catch((error) => {
      console.warn('[ChromeOS Graylog Agent] Failed to report host permission mismatch', error);
    });
  });

  const endpointCandidate =
    raw.endpoint && typeof raw.endpoint === 'object' ? raw.endpoint : raw;

  const endpointResult = normalizeEndpoint(endpointCandidate, {
    allowHttpForTesting,
    allowedHosts: sanitizedAllowedHosts
  });

  return {
    endpoint: endpointResult.endpoint,
    endpointValid: endpointResult.valid,
    endpointErrors: endpointResult.errors,
    pollIntervalMinutes: sanitizeOptionalNumber(raw.pollIntervalMinutes),
    guardThresholdMinutes: sanitizeOptionalNumber(raw.guardThresholdMinutes),
    allowHttpForTesting,
    allowedHosts: sanitizedAllowedHosts
  };
}

function mergeConfigurations(localConfig, managedConfig) {
  const merged = {
    endpoint: { ...DEFAULT_ENDPOINT },
    pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
    guardThresholdMinutes: DEFAULT_GUARD_THRESHOLD_MINUTES,
    allowHttpForTesting: false,
    allowedHosts: []
  };

  const apply = (source) => {
    if (!source) {
      return;
    }

    if (Array.isArray(source.allowedHosts) && source.allowedHosts.length > 0) {
      merged.allowedHosts = source.allowedHosts;
    }

    if (typeof source.allowHttpForTesting === 'boolean') {
      merged.allowHttpForTesting = source.allowHttpForTesting;
    }

    if (typeof source.pollIntervalMinutes === 'number') {
      merged.pollIntervalMinutes = source.pollIntervalMinutes;
    }

    if (typeof source.guardThresholdMinutes === 'number') {
      merged.guardThresholdMinutes = source.guardThresholdMinutes;
    }

    if (source.endpoint && source.endpoint.host) {
      merged.endpoint = source.endpoint;
    }
  };

  apply(localConfig);
  apply(managedConfig);

  const endpointCheck = normalizeEndpoint(merged.endpoint, {
    allowHttpForTesting: merged.allowHttpForTesting,
    allowedHosts: merged.allowedHosts
  });

  if (endpointCheck.valid) {
    merged.endpoint = endpointCheck.endpoint;
  } else {
    merged.endpoint = { ...DEFAULT_ENDPOINT };
  }

  merged.pollIntervalMinutes = sanitizePollInterval(merged.pollIntervalMinutes);
  merged.guardThresholdMinutes = Math.max(
    sanitizeOptionalNumber(merged.guardThresholdMinutes) ?? DEFAULT_GUARD_THRESHOLD_MINUTES,
    merged.pollIntervalMinutes
  );

  return merged;
}

function normalizeEndpoint(rawEndpoint, options = {}) {
  const allowHttpForTesting = options.allowHttpForTesting === true;
  const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : [];
  const endpoint = { ...DEFAULT_ENDPOINT };
  const errors = [];

  if (!rawEndpoint || typeof rawEndpoint !== 'object') {
    return { endpoint, valid: false, errors };
  }

  if (Object.prototype.hasOwnProperty.call(rawEndpoint, 'host')) {
    const hostCandidate = typeof rawEndpoint.host === 'string' ? rawEndpoint.host.trim() : '';
    if (hostCandidate && HOSTNAME_PATTERN.test(hostCandidate)) {
      endpoint.host = hostCandidate;
    } else if (hostCandidate) {
      errors.push('invalid-host');
    }
  }

  if (Object.prototype.hasOwnProperty.call(rawEndpoint, 'port')) {
    const portCandidate = Number(rawEndpoint.port);
    if (Number.isFinite(portCandidate) && portCandidate > 0 && portCandidate <= 65535) {
      endpoint.port = Math.round(portCandidate);
    } else {
      errors.push('invalid-port');
    }
  }

  if (Object.prototype.hasOwnProperty.call(rawEndpoint, 'protocol')) {
    const protocolCandidate =
      typeof rawEndpoint.protocol === 'string' ? rawEndpoint.protocol.toLowerCase() : '';
    if (protocolCandidate === 'https') {
      endpoint.protocol = 'https';
    } else if (protocolCandidate === 'http' && allowHttpForTesting) {
      endpoint.protocol = 'http';
    } else if (protocolCandidate) {
      errors.push('invalid-protocol');
    }
  }

  if (endpoint.protocol === 'http' && !allowHttpForTesting) {
    errors.push('http-not-allowed');
    endpoint.protocol = 'https';
  }

  if (allowedHosts.length > 0 && endpoint.host && !allowedHosts.includes(endpoint.host)) {
    errors.push('host-not-allowed');
  }

  const valid = errors.length === 0 && endpoint.host !== '';
  if (!valid) {
    endpoint.host = '';
  }

  return { endpoint, valid, errors };
}

async function recordDiagnostic(code, details = {}, options = {}) {
  const now = Date.now();
  pruneTransientDiagnostics(now);

  const entry = {
    code,
    details,
    timestamp: new Date().toISOString()
  };

  const lastTransient = transientDiagnostics[transientDiagnostics.length - 1];
  if (lastTransient && diagnosticsEntriesMatch(lastTransient, entry)) {
    return;
  }

  transientDiagnostics.push(entry);
  if (transientDiagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
    transientDiagnostics.splice(0, transientDiagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
  }

  if (options.skipStorage === true) {
    return;
  }

  try {
    const { data, success } = await getStorageLocal(DIAGNOSTICS_STORAGE_KEY);
    if (!success) {
      return;
    }

    let existing = Array.isArray(data?.[DIAGNOSTICS_STORAGE_KEY]) ? data[DIAGNOSTICS_STORAGE_KEY] : [];

    const retention = applyDiagnosticRetention(existing, now);
    if (retention.pruned > 0) {
      await recordDiagnostic(
        'diagnostics-retention-pruned',
        { count: retention.pruned },
        { skipStorage: true }
      );
    }

    existing = retention.kept;

    const lastStored = existing[existing.length - 1];
    if (lastStored && diagnosticsEntriesMatch(lastStored, entry)) {
      return;
    }

    existing.push(entry);
    const trimmed = existing.slice(-MAX_DIAGNOSTIC_ENTRIES);
    await setStorageLocal({ [DIAGNOSTICS_STORAGE_KEY]: trimmed });
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to record diagnostic event', error);
  }
}

async function enforceDiagnosticRetention() {
  if (!Number.isFinite(DIAGNOSTIC_RETENTION_WINDOW_MS) || DIAGNOSTIC_RETENTION_WINDOW_MS <= 0) {
    return;
  }

  const now = Date.now();

  try {
    const { data, success } = await getStorageLocal(DIAGNOSTICS_STORAGE_KEY);
    if (!success) {
      return;
    }

    const existing = Array.isArray(data?.[DIAGNOSTICS_STORAGE_KEY]) ? data[DIAGNOSTICS_STORAGE_KEY] : [];
    const { kept, pruned } = applyDiagnosticRetention(existing, now);
    if (pruned === 0 && kept.length === existing.length) {
      return;
    }

    const trimmed = kept.slice(-MAX_DIAGNOSTIC_ENTRIES);
    await setStorageLocal({ [DIAGNOSTICS_STORAGE_KEY]: trimmed });

    if (pruned > 0) {
      await recordDiagnostic(
        'diagnostics-retention-pruned',
        { count: pruned },
        { skipStorage: true }
      );
    }
  } catch (error) {
    console.warn('[ChromeOS Graylog Agent] Failed to enforce diagnostic retention', error);
  }
}

function applyDiagnosticRetention(entries, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { kept: [], pruned: 0 };
  }

  if (!Number.isFinite(DIAGNOSTIC_RETENTION_WINDOW_MS) || DIAGNOSTIC_RETENTION_WINDOW_MS <= 0) {
    return { kept: entries.slice(), pruned: 0 };
  }

  const cutoff = now - DIAGNOSTIC_RETENTION_WINDOW_MS;
  const kept = [];
  let pruned = 0;

  for (const entry of entries) {
    const timestamp = Date.parse(entry?.timestamp ?? '');
    if (Number.isFinite(timestamp) && timestamp < cutoff) {
      pruned += 1;
      continue;
    }

    kept.push(entry);
  }

  return { kept, pruned };
}

function pruneTransientDiagnostics(now = Date.now()) {
  if (transientDiagnostics.length === 0) {
    return;
  }

  const { kept } = applyDiagnosticRetention(transientDiagnostics, now);
  if (kept.length === transientDiagnostics.length) {
    return;
  }

  transientDiagnostics.length = 0;
  const trimmed = kept.slice(-MAX_DIAGNOSTIC_ENTRIES);
  transientDiagnostics.push(...trimmed);
}

function getStorageLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError;
        console.warn('[ChromeOS Graylog Agent] storage.local.get failed', error);
        recordDiagnostic(
          'storage-local-get-failed',
          {
            keys: Array.isArray(keys) ? keys : [keys],
            message: error?.message ?? String(error)
          },
          { skipStorage: true }
        ).catch(() => {});
        resolve({ data: {}, success: false, error });
        return;
      }

      resolve({ data, success: true });
    });
  });
}

function setStorageLocal(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError;
        console.warn('[ChromeOS Graylog Agent] storage.local.set failed', error);
        recordDiagnostic(
          'storage-local-set-failed',
          {
            keys: Object.keys(values ?? {}),
            message: error?.message ?? String(error)
          },
          { skipStorage: true }
        ).catch(() => {});
        resolve({ success: false, error });
        return;
      }

      resolve({ success: true });
    });
  });
}

function getStorageManaged(keys) {
  return new Promise((resolve) => {
    if (!chrome.storage?.managed?.get) {
      resolve({});
      return;
    }

    chrome.storage.managed.get(keys, (data) => {
      if (chrome.runtime.lastError) {
        console.warn('[ChromeOS Graylog Agent] storage.managed.get failed', chrome.runtime.lastError);
        resolve({});
        return;
      }

      resolve(data);
    });
  });
}
