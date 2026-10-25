import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';

const candidates = (level) => parseAdminOperation(parseArgs([
  'admin', 'word-games', 'candidates', String(level), '--after', '123', '--limit', '200'
]));

test('vocabulary review can page the unassigned pool and all five ranked pools', () => {
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const operation = candidates(level);
    const url = new URL(operation.path, 'https://example.invalid');
    assert.equal(url.pathname, '/cli/admin/word-games/candidates');
    assert.equal(url.searchParams.get('level'), String(level));
    assert.equal(url.searchParams.get('after'), '123');
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(operation.mutates, false);
    assert.equal(operation.requiresRun, false);
  }
  for (const level of [-1, 6, 1.5, 'unknown']) assert.throws(() => candidates(level));
});
