import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminOperation } from '../lib/admin.js';
import { parseArgs } from '../lib/commands.js';

test('parent email sending requires the reviewed draft revision; discards need none', () => {
  const revision = 'a'.repeat(64);
  const send = parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17', '--fingerprint', revision]));
  assert.equal(send.path, '/cli/admin/meetup-quest/emails/17/send');
  assert.deepEqual(send.body, { revision });
  assert.throws(
    () => parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17'])),
    /--fingerprint[\s\S]*meetup emails list/,
  );
  const upper = parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17', '--fingerprint', 'A'.repeat(64)]));
  assert.deepEqual(upper.body, { revision: 'a'.repeat(64) });
  const discard = parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'discard', '17']));
  assert.deepEqual(discard.body, {});
  assert.throws(() => parseAdminOperation(parseArgs(['admin', 'meetup', 'emails', 'send', '17', '--fingerprint', 'wrong'])), /fingerprint/);
});
