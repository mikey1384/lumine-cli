import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';
import { formatAppHostResult } from '../lib/admin-app-host.js';

const op = (...args) => parseAdminOperation(parseArgs(['admin', 'app-host', ...args]));

test('app-host: status and reports read; takedown/restore need a reason and are dry runs without --confirm', () => {
  assert.equal(op('status', 'lilys-game.lumine.app').path, '/cli/admin/app-host/status?app=lilys-game.lumine.app');
  assert.equal(op('reports').mutates, false);
  const dry = op('takedown', '2915', '--reason', 'asks for passwords');
  assert.deepEqual(dry.body, { app: '2915', reason: 'asks for passwords', dryRun: true });
  assert.equal(dry.mutates, false);
  const real = op('restore', 'lilys-game', '--reason', 'fixed', '--confirm');
  assert.equal(real.path, '/cli/admin/app-host/restore');
  assert.equal(real.mutates, true);
  assert.throws(() => op('takedown', '2915'), /--reason/);
  assert.throws(() => op('status'), /Supply the app/);
  assert.throws(() => op('nuke', '1'), /Usage/);
});

test('app-host output says where it applies', () => {
  const dry = formatAppHostResult({ operation: op('takedown', '9', '--reason', 'x'), data: { dryRun: true, buildId: 9, current: 'live', addresses: ['lilys-game', 'lilysgame.com'] } });
  assert.match(dry[0], /Dry run: would take down app 9 \(now live\) at lilys-game, lilysgame.com/);
  const done = formatAppHostResult({ operation: op('takedown', '9', '--reason', 'x', '--confirm'), data: { buildId: 9 } });
  assert.match(done[0], /^Took down app 9 .*twin-kle.com is unchanged/);
  assert.deepEqual(formatAppHostResult({ operation: op('reports'), data: { reports: [] } }), ['No open app reports.']);
});
