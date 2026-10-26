import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/commands.js';
import { parseAdminOperation } from '../lib/admin.js';
import { formatArenaResult } from '../lib/admin-arena.js';
import fs from 'node:fs';
import { testWorkRoot } from './helpers/work-directory.js';

const paper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arena-paper');

test('Today’s Q queue/member reads paginate; publication needs explicit confirmation and overrides file dryRun', () => {
  const op = parseAdminOperation(parseArgs(['admin', 'arena', 'today-queue', '--cursor', '123', '--limit', '25']));
  assert.equal(op.path, '/cli/admin/arena/today/queue?cursor=123&limit=25');
  assert.equal(op.mutates, false);
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'today-queue', '--limit', '101'])));
  assert.equal(parseAdminOperation(parseArgs(['admin', 'arena', 'today-member', '--user', '123'])).path, '/cli/admin/arena/today/member/123');
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'today-member', '--user', '-1'])));
  const file = path.join(testWorkRoot(), `arena-today-${process.pid}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ userId: 123, revision: 2, items: [], dryRun: false }));
    const args = ['admin', 'arena', 'today-import', '--file', file];
    const preview = parseAdminOperation(parseArgs(args));
    assert.equal(preview.body.dryRun, true); assert.equal(preview.mutates, false);
    const real = parseAdminOperation(parseArgs([...args, '--confirm']));
    assert.equal(real.body.dryRun, false); assert.equal(real.mutates, true);
    assert.equal(real.path, '/cli/admin/arena/today/import');
  } finally { fs.unlinkSync(file); }
});

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

test('arena marking is read-only and preserves a cursor even when a page has no issues', () => {
  const op = parseAdminOperation(parseArgs(['admin', 'arena', 'marking', '--cursor', '123', '--limit', '50', '--json']));
  assert.equal(op.path, '/cli/admin/arena/marking?cursor=123&limit=50');
  assert.equal(op.method, 'GET');
  assert.equal(op.mutates, false);
  assert.equal(op.requiresRun, false);
  const lines = formatArenaResult({ operation: op, data: { scannedBattles: 50, entries: [], nextCursor: '200' } });
  assert.match(lines.at(-1), /--cursor 200/);
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'marking', '--limit', '201'])));
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'marking', '--cursor', '-1'])));
});
test('arena queue separates low stock without demand from an active refill', () => {
  const lines = formatArenaResult({ operation: { name: 'arena.queue' }, data: { types: [
    { examFamily: 'english', difficulty: 'normal', itemType: 'reading', live: 4, activeLearners: 0, minFresh: 4, stockLow: true, refillDue: false, toWrite: 0 },
    { examFamily: 'english', difficulty: 'hard', itemType: 'listening', live: 25, activeLearners: 1, minFresh: 3, stockLow: false, refillDue: true, toWrite: 17 }
  ] } });
  assert.match(lines[0], /0 active learner\(s\).*low stock; no active demand/);
  assert.ok(!lines[0].includes('write'));
  assert.match(lines[1], /1 active learner\(s\).*3 unseen -> write 17/);
  assert.equal(lines[2], '1 type(s) due for a refill.');
});
