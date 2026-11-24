// lumine delete <twinkle-build-or-branch-url-or-id> [--confirm] [--title "<exact title>"]
//
// Deletes a Build or a contribution branch you own, through the same request
// the website's Delete button sends: DELETE /build/:buildId with
// { confirmTitle } (twinkle-vite requestHelpers deleteBuild). The server
// enforces everything: owner only, the exact current title, a branch that is
// being merged cannot be deleted, and deleting a Main also deletes all of its
// branches. Without --confirm it is a dry run that shows what would go and
// changes nothing. With --title, the delete is refused unless that is still
// the exact title (the website's typed confirmation); without it, the title
// shown by this run's own lookup is sent.
import { requestJson } from "./http.js";
import { assertAuthScope, resolveAuth } from "./auth.js";
import { resolveBuildReference } from "./util.js";

const USAGE = 'Usage: lumine delete <twinkle-build-or-branch-url-or-id> [--confirm] [--title "<exact title>"] [--json]';
const VERSION_COUNT_LIMIT = 200;
const BRANCH_COUNT_LIMIT = 100;

function usage(message = USAGE) {
  const error = new Error(message);
  error.code = "lumine_delete_usage";
  return error;
}

export function parseDeleteConfirm(value) {
  if (value === "" || value === undefined) return false;
  if (value === "true") return true;
  throw usage("Pass --confirm on its own, without a value.");
}

function countText(count, limit, noun, plural = `${noun}s`) {
  const shown = count >= limit ? `${limit}+` : String(count);
  return `${shown} ${count === 1 ? noun : plural}`;
}

export async function deleteCommand(
  options,
  { request = requestJson, log = console.log, checkScope = assertAuthScope, auth: givenAuth = null } = {},
) {
  const target = String(options.target || "").trim();
  if (!target || (options.positional?.length || 0) > 1) throw usage();
  const reference = resolveBuildReference(target);
  if (!(reference.buildId > 0)) throw usage(`Could not read a Build from "${target}". ${USAGE}`);
  const confirm = parseDeleteConfirm(options.adminConfirm);
  const expectedTitle = options.title === undefined || options.title === null ? "" : String(options.title).trim();
  const auth = givenAuth || (await resolveAuth(options));
  await checkScope({ options, auth, scope: confirm ? "build:write" : "build:read" });
  const get = (route) =>
    request({ url: `${options.apiUrl}${route}`, authToken: auth.token, timeoutMs: options.timeoutMs });

  let buildId = reference.buildId;
  if (reference.branchNumber > 0) {
    const branch = await get(`/cli/build/${reference.buildId}/branches/${reference.branchNumber}`);
    buildId = Number(branch?.build?.id || 0);
    if (!buildId) throw new Error(`Branch ${reference.branchNumber} of Build #${reference.buildId} could not be found.`);
  }
  const build = (await get(`/cli/build/${buildId}/files?includeContent=0`))?.build;
  if (!build?.id) throw new Error(`Build #${buildId} could not be loaded.`);
  const title = String(build.title || "").trim();
  const owner = build.ownerUsername || (build.ownerUserId ? `member ${build.ownerUserId}` : "unknown");
  if (build.role !== "owner") {
    throw new Error(`You do not own Build #${buildId} "${title}" (owner: ${owner}). Only its owner can delete it.`);
  }
  const rootBuildId = Number(build.contributionRootBuildId || 0);
  const isBranch = rootBuildId > 0 || String(build.contributionStatus || "none") !== "none";
  let rootTitle = "";
  if (isBranch && rootBuildId) {
    try {
      rootTitle = String((await get(`/cli/build/${rootBuildId}/files?includeContent=0`))?.build?.title || "");
    } catch {
      rootTitle = "";
    }
  }
  const versions = (await get(`/cli/build/${buildId}/versions?limit=${VERSION_COUNT_LIMIT}`))?.versions;
  const versionCount = Array.isArray(versions) ? versions.length : 0;
  let branchCount = null;
  if (!isBranch) {
    try {
      const listed = await get(`/build/${buildId}/contributions?limit=${BRANCH_COUNT_LIMIT}`);
      branchCount = Array.isArray(listed?.contributions) ? listed.contributions.length : null;
    } catch {
      branchCount = null;
    }
  }
  const summary = {
    buildId,
    title,
    ownerUserId: build.ownerUserId || null,
    ownerUsername: build.ownerUsername || null,
    isBranch,
    branchNumber: isBranch ? Number(build.contributionBranchNumber || 0) || null : null,
    rootBuildId: isBranch ? rootBuildId || null : null,
    rootTitle: isBranch ? rootTitle || null : null,
    contributionStatus: String(build.contributionStatus || "none"),
    isPublic: Boolean(build.isPublic),
    publishedAt: build.publishedAt || null,
    versionCount,
    branchCount,
  };
  const what = isBranch
    ? `branch #${summary.branchNumber ?? "?"} "${title}" (build ${buildId}) of Build #${rootBuildId}${rootTitle ? ` "${rootTitle}"` : ""}`
    : `Build #${buildId} "${title}"`;
  const lines = [
    `${confirm ? "Deleting" : "Would delete"} ${what}, owned by ${owner}.`,
    `Saved versions: ${countText(versionCount, VERSION_COUNT_LIMIT, "version")}.`,
    ...(isBranch
      ? ["Main and its other branches are not touched."]
      : [
          branchCount === null
            ? "Deleting a Main also deletes every branch of it."
            : branchCount > 0
              ? `Deleting this Main also deletes its ${countText(branchCount, BRANCH_COUNT_LIMIT, "branch", "branches")}.`
              : "It has no branches.",
          ...(summary.isPublic || summary.publishedAt ? ["Its published app goes away too."] : []),
        ]),
  ];
  if (expectedTitle && expectedTitle !== title) {
    throw new Error(`--title "${expectedTitle}" does not match the current title "${title}". Nothing was deleted.`);
  }
  if (!confirm) {
    const result = { ok: true, dryRun: true, action: "would_delete", build: summary };
    if (options.json) log(JSON.stringify(result));
    else for (const line of [...lines, `Nothing was deleted. To delete it: lumine delete ${buildId} --confirm --title ${JSON.stringify(title)}`]) log(line);
    return result;
  }
  // The website's request, exactly: DELETE /build/:id with { confirmTitle }.
  const deleted = await request({
    method: "DELETE",
    url: `${options.apiUrl}/build/${buildId}`,
    authToken: auth.token,
    body: { confirmTitle: title },
    timeoutMs: Math.max(60000, Number(options.timeoutMs) || 0),
  });
  if (deleted?.success !== true) throw new Error(deleted?.error || `Build #${buildId} was not deleted.`);
  const result = { ok: true, dryRun: false, deleted: true, build: summary };
  if (options.json) log(JSON.stringify(result));
  else for (const line of [...lines.slice(1), `Deleted ${what}.`]) log(line);
  return result;
}
