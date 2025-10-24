const ACTION_BUTTON_SELECTOR = '[data-action]';
const diagnosticsContainer = document.querySelector('#diagnostics');
const statusElement = document.querySelector('#status');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

updateTheme(prefersDark.matches);
prefersDark.addEventListener('change', (event) => {
  updateTheme(event.matches);
});

document.querySelectorAll(ACTION_BUTTON_SELECTOR).forEach((button) => {
  button.addEventListener('click', async () => {
    await handleAction(button);
  });
});

async function handleAction(button) {
  const action = button.dataset.action;
  if (!action) {
    return;
  }

  setStatus('Working…');
  setButtonsDisabled(true);

  try {
    const response = await chrome.runtime.sendMessage({ type: action });
    if (!response || response.success === false) {
      const message = response?.message ?? 'Request failed';
      throw new Error(message);
    }

    switch (action) {
      case 'graylog:exportDiagnostics':
        renderDiagnostics(response.diagnostics ?? []);
        setStatus(`Loaded ${response.diagnostics?.length ?? 0} diagnostic entries.`);
        break;
      case 'graylog:flushRetryQueue':
        setStatus(`Delivery queue flushed. ${response.remaining ?? 0} entries remaining.`);
        break;
      case 'graylog:clearRetryQueue':
        setStatus('Delivery queue cleared.');
        renderDiagnostics([]);
        break;
      case 'graylog:clearDiagnostics':
        setStatus('Diagnostics cleared.');
        renderDiagnostics([]);
        break;
      default:
        setStatus('Action completed.');
        break;
    }
  } catch (error) {
    console.error('Administrative request failed', error);
    setStatus(`Failed: ${error?.message ?? error}`);
  } finally {
    setButtonsDisabled(false);
  }
}

function renderDiagnostics(entries) {
  diagnosticsContainer.replaceChildren();

  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No diagnostics available.';
    diagnosticsContainer.appendChild(empty);
    return;
  }

  entries
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a?.timestamp ?? '') || 0;
      const bTime = Date.parse(b?.timestamp ?? '') || 0;
      return bTime - aTime;
    })
    .forEach((entry) => diagnosticsContainer.appendChild(renderDiagnosticEntry(entry)));
}

function renderDiagnosticEntry(entry) {
  const element = document.createElement('li');
  element.className = 'diagnostic-entry';

  const header = document.createElement('div');
  header.className = 'diagnostic-entry__header';

  const code = document.createElement('span');
  code.className = 'diagnostic-entry__code';
  code.textContent = entry?.code ?? 'unknown';
  header.appendChild(code);

  const timestamp = document.createElement('span');
  timestamp.className = 'diagnostic-entry__timestamp';
  timestamp.textContent = formatTimestamp(entry?.timestamp);
  header.appendChild(timestamp);

  const details = document.createElement('pre');
  details.textContent = formatDetails(entry?.details ?? {});

  element.appendChild(header);
  element.appendChild(details);

  return element;
}

function formatTimestamp(value) {
  if (!value) {
    return 'unknown time';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatDetails(details) {
  try {
    return JSON.stringify(details ?? {}, null, 2);
  } catch (error) {
    return String(details ?? '');
  }
}

function setStatus(message) {
  statusElement.textContent = message;
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll(ACTION_BUTTON_SELECTOR).forEach((button) => {
    button.disabled = disabled;
  });
}

function updateTheme(isDark) {
  if (document.body) {
    document.body.classList.toggle('dark', isDark);
    return;
  }

  window.addEventListener(
    'DOMContentLoaded',
    () => {
      document.body.classList.toggle('dark', isDark);
    },
    { once: true }
  );
}
