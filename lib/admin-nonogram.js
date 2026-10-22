import { readAdminJsonFile } from './admin-news.js';

const USAGE = 'Usage: lumine admin nonogram status | add --file <pictures.json> | retire <key> | restore <key> [--confirm] [--json]';
function invalid(message) {
  const error = new Error(message);
  error.code = 'CLI_ADMIN_CLI_VALIDATION';
  throw error;
}
export function buildNonogramOperation({ action, target, options }) {
  if (!action || action === 'status') return {
    name: 'nonogram.status', method: 'GET', path: '/cli/admin/nonogram/status',
    mutates: false, requiresRun: false
  };
  if (!['add', 'retire', 'restore'].includes(action)) invalid(USAGE);
  if (options.adminConfirm !== '' && options.adminConfirm !== 'true')
    invalid('Pass --confirm on its own, without a value.');
  const confirm = options.adminConfirm === 'true';
  if (action !== 'add') {
    if (typeof target !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(target)) invalid('Supply one exact picture key.');
    return { name: `nonogram.${action}${confirm ? '' : '.preview'}`, method: 'POST',
      path: '/cli/admin/nonogram/availability', body: { key: target, retire: action === 'retire', dryRun: !confirm },
      mutates: confirm, requiresRun: false };
  }
  const pictures = readAdminJsonFile(options.adminFile, '--file <pictures.json>', { maxBytes: 1024 * 1024 });
  if (!Array.isArray(pictures) || !pictures.length || pictures.length > 150)
    invalid('The file must contain 1–150 reviewed pictures. Split larger refills.');
  return {
    name: confirm ? 'nonogram.add' : 'nonogram.add.preview', method: 'POST',
    path: '/cli/admin/nonogram/add', body: { pictures, dryRun: !confirm },
    mutates: confirm, requiresRun: false, timeoutMs: 120000
  };
}
export function formatNonogramResult({ operation, data }) {
  if (operation.name === 'nonogram.status') return (data?.sizes || []).map((s) =>
    `${s.size}×${s.size}: ${s.total} pictures; at least ${s.leastUnseen} unseen for every learner (${s.reserveDays} days at 3/day; target ${s.targetDays}).`);
  if (/^nonogram\.(retire|restore)/.test(operation.name)) return [
    `${data?.dryRun ? 'Dry run: would mark' : 'Marked'} ${data?.key} ${data?.retired ? 'retired' : 'available'}. Started puzzles are preserved.`,
    ...(data?.dryRun ? ['Nothing was written. Add --confirm to apply.'] : [])
  ];
  return [
    `${data?.dryRun ? 'Dry run: would add' : 'Added'} ${data?.added?.length || 0} pictures; skipped ${data?.skipped?.length || 0} duplicates.`,
    ...(data?.skipped || []).map((p) => `${p.key}: ${p.reason}`),
    ...(data?.dryRun ? ['Nothing was written. Add --confirm to import this reviewed collection.'] : [])
  ];
}
