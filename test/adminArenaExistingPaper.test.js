import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../lib/commands.js';
import { parseAdminOperation } from '../lib/admin.js';
import { formatArenaResult } from '../lib/admin-arena.js';
import { testWorkRoot } from './helpers/work-directory.js';

const manifest = () => ({ exam: 'lt-math-e6', difficulty: 'hard', paper: 'existing-paper',
  items: Array.from({ length: 20 }, (_, n) => ({ itemId: n + 500, expectedVersion: 2, number: n + 1, contentHash: 'a'.repeat(64) })),
  review: { solved: true, optionsChecked: true, lessonChecked: true, mediaChecked: true, notes: 'Sealed independent review of all existing content and figures.' } });

test('existing-item publication previews by default and only --confirm can override file dryRun', () => {
  const file = path.join(testWorkRoot(), `arena-assembly-${process.pid}.json`);
  try {
    const payload = { ...manifest(), dryRun: false }; fs.writeFileSync(file, JSON.stringify(payload));
    const args = ['admin', 'arena', 'paper-assemble', '--file', file];
    const preview = parseAdminOperation(parseArgs(args));
    assert.equal(preview.path, '/cli/admin/arena/papers/assemble'); assert.equal(preview.mutates, false);
    assert.deepEqual(preview.body, { ...payload, dryRun: true });
    const real = parseAdminOperation(parseArgs([...args, '--confirm']));
    assert.equal(real.mutates, true); assert.equal(real.body.dryRun, false);
    assert.throws(() => parseAdminOperation(parseArgs([...args, '--confirm=false'])));
    for (const extra of [['--additive'], ['--dir', 'somewhere'], ['--audio', 'audio/a/b']]) assert.throws(() => parseAdminOperation(parseArgs([...args, ...extra])));
  } finally { fs.unlinkSync(file); }
});

test('assembly manifests reject replacements, duplicate IDs/numbers and missing reviewed identities', () => {
  const file = path.join(testWorkRoot(), `arena-assembly-invalid-${process.pid}.json`);
  try {
    const good = manifest(); const bad = [[], { ...good, items: [] }, { ...good, review: null }, { ...good, paper: '../bad' },
      { ...good, items: good.items.map((i, n) => n ? i : { ...i, content: { stem: 'new' } }) },
      { ...good, items: good.items.map((i, n) => n ? i : { ...i, expectedVersion: 0 }) },
      { ...good, items: good.items.map((i, n) => n ? i : { ...i, contentHash: 'missing' }) },
      { ...good, items: [good.items[0], ...good.items.slice(0, 19)] }];
    for (const payload of bad) {
      fs.writeFileSync(file, JSON.stringify(payload));
      assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'paper-assemble', '--file', file])));
    }
  } finally { fs.unlinkSync(file); }
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'paper-assemble'])));
});

test('text assembly preserves exact passage proof and refuses unreviewed or replacement passage data', () => {
  const file = path.join(testWorkRoot(), `arena-assembly-passages-${process.pid}.json`);
  try {
    const good = manifest();
    good.items[0].passageId = 700;
    good.passages = [{ passageId: 700, expectedVersion: 1, contentHash: 'b'.repeat(64) }];
    fs.writeFileSync(file, JSON.stringify(good));
    const operation = parseAdminOperation(parseArgs(['admin', 'arena', 'paper-assemble', '--file', file]));
    assert.deepEqual(operation.body.passages, good.passages);
    assert.deepEqual(operation.body.items, good.items);
    assert.equal(operation.body.dryRun, true);
    for (const bad of [
      { ...good, passages: undefined }, { ...good, passages: [] },
      { ...good, passages: [...good.passages, good.passages[0]] },
      { ...good, passages: [{ ...good.passages[0], body: 'Replacement text' }] },
      { ...good, passages: [{ ...good.passages[0], contentHash: 'missing' }] },
      { ...good, passages: [{ ...good.passages[0], expectedVersion: 0 }] },
      { ...good, items: good.items.map((i, n) => n ? i : { ...i, passageId: -1 }) }
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => parseAdminOperation(parseArgs(['admin', 'arena', 'paper-assemble', '--file', file])));
    }
  } finally { fs.unlinkSync(file); }
});

test('assembly output distinguishes preview, publication and unchanged retry', () => {
  const operation = { name: 'arena.paper.assemble' };
  assert.match(formatArenaResult({ operation, data: { paper: 'paper', dryRun: true, wouldAssemble: 20 } }).join('\n'), /Dry run: would assemble 20[\s\S]*--confirm/);
  assert.match(formatArenaResult({ operation, data: { paper: 'paper', dryRun: false, assembled: 20 } }).join('\n'), /Assembled 20[\s\S]*preserved/);
  assert.match(formatArenaResult({ operation, data: { paper: 'paper', alreadyAssembled: true } }).join('\n'), /nothing changed/);
});
