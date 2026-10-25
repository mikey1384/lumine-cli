import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/commands.js';
import { parseAdminOperation } from '../lib/admin.js';

const paper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arena-paper');

test('arena import is a validation-only dry run without --confirm and carries the audio prefix', () => {
  const op = parseAdminOperation(parseArgs(['admin', 'arena', 'import', '--dir', paper, '--audio', 'audio/suneung-eng/eng-08']));
  assert.equal(op.name, 'arena.import.preview');
  assert.equal(op.path, '/cli/admin/arena/items/import');
  assert.equal(op.mutates, false);
  assert.equal(op.body.dryRun, true);
  assert.equal(op.body.audioPrefix, 'audio/suneung-eng/eng-08');
  assert.deepEqual(op.body.items.map((i) => i.number), [1, 2]);
  assert.equal(op.body.paper, 'arena-paper');
  const real = parseAdminOperation(parseArgs(['admin', 'arena', 'import', '--dir', paper, '--live', '--confirm']));
  assert.equal(real.name, 'arena.import');
  assert.equal(real.body.dryRun, false);
  assert.equal(real.body.live, true);
});

test('explicit --live=false imports checked items without serving them to members', () => {
  const op = parseAdminOperation(parseArgs(['admin', 'arena', 'import', '--dir', paper, '--live=false', '--confirm']));
  assert.equal(op.body.dryRun, false);
  assert.equal(op.body.live, false);
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'import', '--dir', paper, '--confirm=false'])));
});

test('arena queue reads; status needs --confirm', () => {
  assert.equal(parseAdminOperation(parseArgs(['admin', 'arena', 'queue'])).method, 'GET');
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'status', '--item', '5', '--to', 'retired'])));
  const op = parseAdminOperation(parseArgs(['admin', 'arena', 'status', '--item', '5', '--to', 'retired', '--confirm']));
  assert.equal(op.path, '/cli/admin/arena/items/5/status');
  assert.deepEqual(op.body, { status: 'retired' });
});
