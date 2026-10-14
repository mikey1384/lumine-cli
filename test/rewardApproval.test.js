import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/commands.js';
import { parseAdminOperation } from '../lib/admin.js';
import { reviewApprovalFromReceipt } from '../lib/rewards.js';
const receipt = { ready: true, buildId: 2460, sourceVersionId: 60, savedVersion: 60, sourceHash: 'a'.repeat(64), sheetHash: 'b'.repeat(64), configHash: 'c'.repeat(64), willPublishImmediately: true };
test('reward command parses read-only preflight and explicit approval receipt', () => {
  assert.equal(parseArgs(['rewards','review','--preflight','--json']).rewardPreflight, true);
  assert.equal(parseArgs(['rewards','review','--approval-file','review.json']).rewardApprovalFile, 'review.json');
  const approved = reviewApprovalFromReceipt(receipt, 2460);
  assert.deepEqual(Object.keys(approved), ['buildId','sourceVersionId','sourceHash','sheetHash','configHash']);
  assert.equal(approved.sheetHash, receipt.sheetHash);
  for (const changed of [{...receipt,buildId:2610},{...receipt,ready:false},{...receipt,sheetHash:''}]) assert.throws(()=>reviewApprovalFromReceipt(changed,2460),/complete, ready preflight/);
});
test('Math Lab queue is an explicit read of the canonical server status', () => {
  const operation = parseAdminOperation(parseArgs(['admin','math-lab','queue','--json']));
  assert.equal(operation.path, '/cli/admin/math-lab/queue');
  assert.equal(operation.mutates, false);
});
