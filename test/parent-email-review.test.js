import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';

test('parent email sending carries the reviewed draft revision without changing ordinary sends or discards', () => {
  const revision = 'a'.repeat(64);
  const send = parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17', '--fingerprint', revision]));
  assert.equal(send.path, '/cli/admin/meetup-quest/emails/17/send');
  assert.deepEqual(send.body, { revision });
  const ordinary = parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17']));
  assert.deepEqual(ordinary.body, {});
  const discard = parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'discard', '17']));
  assert.deepEqual(discard.body, {});
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17', '--fingerprint', 'wrong'])), /fingerprint/);
});
