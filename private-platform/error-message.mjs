function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function extractErrorMessage(value, fallback = '') {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object') return fallback;

  for (const key of ['error', 'reason', 'message', 'detail', 'description']) {
    const message = nonEmptyString(value[key]);
    if (message) return message;
  }

  for (const key of ['errors', 'cause', 'response']) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const message = extractErrorMessage(item);
        if (message) return message;
      }
    } else {
      const message = extractErrorMessage(nested);
      if (message) return message;
    }
  }

  return fallback;
}

export function readErrorMessage(body, fallback = '') {
  const text = nonEmptyString(body);
  if (!text) return fallback;
  try {
    return extractErrorMessage(JSON.parse(text), fallback);
  } catch {
    return text;
  }
}
