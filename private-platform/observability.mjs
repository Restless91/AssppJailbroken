const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function createHealthModel(checks = {}) {
  return {
    async live() {
      return { ok: true, status: 'live' };
    },
    async ready() {
      const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
        try {
          const value = await check();
          return [name, normalizeCheck(value)];
        } catch (error) {
          return [name, { ok: false, reason: error instanceof Error ? error.message : String(error) }];
        }
      }));
      const results = Object.fromEntries(entries);
      const ok = entries.every(([, result]) => result.ok);
      return { ok, status: ok ? 'ready' : 'not_ready', checks: results };
    }
  };
}

export function createMetricsRegistry({ allowedLabels = [] } = {}) {
  const allowed = new Set(allowedLabels);
  const values = new Map();

  function record(kind, name, labels, value, operation) {
    if (!METRIC_NAME.test(name)) throw new TypeError('invalid metric name');
    if (!Number.isFinite(value)) throw new TypeError('metric value must be finite');
    const normalized = Object.entries(labels || {}).sort(([left], [right]) => left.localeCompare(right));
    for (const [label] of normalized) {
      if (!LABEL_NAME.test(label) || !allowed.has(label)) throw new TypeError(`metric label is not allowed: ${label}`);
    }
    const labelText = normalized.length
      ? `{${normalized.map(([key, item]) => `${key}="${escapeLabel(item)}"`).join(',')}}`
      : '';
    const key = `${name}${labelText}`;
    const previous = values.get(key)?.value || 0;
    values.set(key, { kind, value: operation === 'add' ? previous + value : value });
  }

  return {
    increment(name, labels = {}, amount = 1) {
      if (amount < 0) throw new TypeError('counter increment must not be negative');
      record('counter', name, labels, amount, 'add');
    },
    gauge(name, value, labels = {}) {
      record('gauge', name, labels, value, 'set');
    },
    render() {
      return `${Array.from(values.entries()).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, metric]) => `${key} ${metric.value}`)
        .join('\n')}\n`;
    }
  };
}

function normalizeCheck(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value;
  return { ok: Boolean(value) };
}

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
