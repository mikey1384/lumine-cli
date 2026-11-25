import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';
import { formatLinkBlockResult } from '../lib/admin-link-block.js';
import { formatSocialResult } from '../lib/admin-social.js';

const op = (...args) => parseAdminOperation(parseArgs(['admin', 'link-block', ...args]));

test('link-block: list reads; add and remove need a note and are dry runs without --confirm', () => {
  const list = op('list');
  assert.equal(list.path, '/cli/admin/link-blocklist');
  assert.equal(list.mutates, false);
  const dry = op('add', 'example.com', '--note', 'scam site');
  assert.deepEqual(dry.body, { host: 'example.com', note: 'scam site', dryRun: true });
  assert.equal(dry.mutates, false);
  assert.equal(dry.requiresRun, false);
  const real = op('remove', 'example.com', '--note', 'false alarm', '--confirm');
  assert.equal(real.path, '/cli/admin/link-blocklist/remove');
  assert.deepEqual(real.body, { host: 'example.com', note: 'false alarm', dryRun: false });
  assert.equal(real.mutates, true);
  assert.throws(() => op('add', 'example.com'), /--note/);
  assert.throws(() => op('add', '--note', 'x'), /site name/);
  assert.throws(() => op('purge'), /Usage/);
});

test('link-block output says what changed and that subdomains are covered', () => {
  const list = formatLinkBlockResult({
    operation: op('list'),
    data: { count: 1, hosts: [{ host: 'example.com', note: 'scam', addedByUserId: 5, addedAt: 1764000000 }] }
  });
  assert.match(list.join('\n'), /1 blocked site/);
  assert.match(list.join('\n'), /example\.com .*#5.*scam/);
  assert.match(formatLinkBlockResult({ operation: op('add', 'example.com', '--note', 'x'), data: { dryRun: true, host: 'example.com' } })[0], /Dry run: would block example\.com \(and its subdomains\)/);
  assert.match(formatLinkBlockResult({ operation: op('add', 'example.com', '--note', 'x', '--confirm'), data: { dryRun: false, changed: true, host: 'example.com', note: 'x' } })[0], /^Blocked example\.com.*within about 15 minutes/);
  assert.deepEqual(formatLinkBlockResult({ operation: op('list'), data: { hosts: [] } }), ['No blocked sites.']);
});

test('social report prints the app link counts and the top apps', () => {
  const lines = formatSocialResult({
    data: {
      status: 'ok',
      store: 'valkey',
      ttlDays: 35,
      window: { days: 7, from: '2026-11-18', lastCompletedDay: '2026-11-24' },
      lastCompletedDay: { day: '2026-11-24', status: 'measured', headline: {}, counters: {} },
      trailing: { days: 6, measuredDays: 6, dailyAverage: null },
      inProgressDay: { day: '2026-11-25', status: 'measured', headline: {} },
      appLinks: {
        lastCompletedDay: { shown: 5, opened: 3, cancelled: 2, rejected: 4, blocked: 1 },
        inProgressDay: { shown: 1, opened: 1, cancelled: 0, rejected: 0, blocked: 0 },
        window: { shown: 9, opened: 6, cancelled: 3, rejected: 4, blocked: 1 },
        topBuilds: [{ buildId: 884, shown: 7, opened: 5, cancelled: 2, rejected: 1, blocked: 0 }]
      },
      flags: [],
      notes: []
    }
  });
  const text = lines.join('\n');
  assert.match(text, /App links \(Twinkle\.app\.openLink sheet\): last day 5 shown, 3 opened, 2 cancelled, 4 rejected \(1 blocked sites\)/);
  assert.match(text, /past 7 day\(s\) 9 shown/);
  assert.match(text, /Top apps by link sheets \(past 7 day\(s\)\)/);
  assert.match(text, /#884: 7 shown, 5 opened/);
});
