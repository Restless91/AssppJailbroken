import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('download progress uses a public SSE stream with polling fallback', async () => {
  const [client, server] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(client, /new EventSource\('\/api\/jobs\/events'\)/);
  assert.match(client, /reconcileJobCards\(jobs\)/);
  assert.doesNotMatch(client, /jobList\.innerHTML = jobs\.map/);
  assert.match(server, /startJobEventStream\(req, res, actor\)/);
  assert.match(server, /broadcastJobChange\(job\)/);
});
