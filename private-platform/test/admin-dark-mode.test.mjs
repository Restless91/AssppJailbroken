import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('admin dark mode follows the system initially and persists manual choice', async () => {
  const [html, css, script] = await Promise.all([
    readFile(new URL('../public/admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.js', import.meta.url), 'utf8')
  ]);

  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /id="adminThemeToggle"/);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /color-scheme: dark/);
  assert.match(script, /localStorage\.setItem\('asspp-admin-theme'/);
  assert.match(script, /aria-pressed/);
});
