export const STOREFRONTS = [
  { code: 'cn', label: '中国大陆', appleId: '143465', aliases: ['china', 'chn', 'zh-cn', '中国', '国区', '中国大陆'] },
  { code: 'us', label: '美国', appleId: '143441', aliases: ['usa', 'united states', 'america', '美区', '美国'] },
  { code: 'jp', label: '日本', appleId: '143462', aliases: ['japan', 'jpn', '日区', '日本'] },
  { code: 'hk', label: '香港', appleId: '143463', aliases: ['hong kong', 'hkg', '港区', '香港'] },
  { code: 'tw', label: '台湾', appleId: '143470', aliases: ['taiwan', 'twn', '台区', '台湾'] }
];

const byCode = new Map(STOREFRONTS.map((item) => [item.code, item]));
const byAlias = new Map();
for (const item of STOREFRONTS) {
  byAlias.set(item.code, item.code);
  byAlias.set(item.appleId, item.code);
  for (const alias of item.aliases) byAlias.set(String(alias).toLowerCase(), item.code);
}

export function normalizeStorefront(value, fallback = 'cn') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (byAlias.has(lower)) return byAlias.get(lower);
  const numeric = raw.match(/\b(143\d{3})\b/)?.[1];
  if (numeric && byAlias.has(numeric)) return byAlias.get(numeric);
  return byCode.has(lower) ? lower : fallback;
}

export function storefrontLabel(value) {
  const code = normalizeStorefront(value, 'cn');
  return byCode.get(code)?.label || code;
}

export function storefrontOptionsHtml(selected = 'cn') {
  const active = normalizeStorefront(selected, 'cn');
  return STOREFRONTS.map((item) =>
    `<option value="${item.code}" ${item.code === active ? 'selected' : ''}>${item.label}</option>`
  ).join('');
}
