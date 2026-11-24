// lumine admin builds merge: Mikey takes a teammate's branch into another
// creator's Main and, with --publish, publishes it, without the owner acting
// (Mikey 11-24). The server is
// twinkle-api/controllers/cli/admin/buildAdminMerge.ts: only Mikey's account
// passes, the owner's storage quota is charged, the branch's suggestion
// closes, the owner gets a notice in their project chat, and every merge and
// publish is audited.
//
// Steps: a dry run shows the owner, the branch and the diff summary; nothing
// changes until --yes or a typed "y". Then the merge, and with --publish the
// publish dry run (checks, and for a rewards app the reward preflight against
// the live approval), then the publish. An app with rewards publishes through
// a reward review Mikey requests and approves in one step; the live approved
// rules and caps are kept (--reward-rules live keeps them when the new
// rewards.json differs).
import { requestJson } from "./http.js";
import { confirmPrompt } from "./assets.js";
import { resolveBuildReference } from "./util.js";

const USAGE =
  "Usage: lumine admin builds merge <branch-url-or-id> [--publish] [--reward-rules proposed|live] [--yes] [--json]";
const REWARD_RULES = new Set(["proposed", "live"]);

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

// <branch-url-or-id>: the branch's own build id ("3045", build:3045), or a
// /build/<main>/<branch-number> URL.
export function parseAdminMergeTarget(target) {
  const raw = String(target || "").trim().replace(/^build:/i, "");
  if (!raw) invalid(USAGE);
  const reference = resolveBuildReference(raw);
  if (!reference.buildId) invalid(`Could not read a branch from "${target}". ${USAGE}`);
  return reference.branchNumber > 0
    ? { rootBuildId: reference.buildId, branchNumber: reference.branchNumber }
    : { branchBuildId: reference.buildId };
}

export function buildAdminBuildMergeOperation({ target, options }) {
  const branch = parseAdminMergeTarget(target);
  const rewardRules = String(options.adminRewardRules || "proposed");
  if (!REWARD_RULES.has(rewardRules)) invalid("--reward-rules must be proposed or live.");
  if (options.adminRewardRules && !options.publish)
    invalid("--reward-rules only applies with --publish.");
  return {
    name: "build.admin-merge",
    method: "POST",
    path: "/cli/admin/builds/admin-merge",
    body: { ...branch, publish: Boolean(options.publish) },
    branch,
    publish: Boolean(options.publish),
    rewardRules,
    buildMergeWorkflow: true,
    // build:write scope; the workflow keys its own requests (below).
    mutates: true,
    requiresRun: false,
  };
}

// Stable keys: a re-run after a crash replays a finished merge or publish
// from its audit record instead of doing it twice.
export function adminMergeRequestKey(branchBuildId) {
  return `cli:admin-merge:${branchBuildId}`;
}
export function adminPublishRequestKey(buildId, filesHash) {
  return `cli:admin-publish:${buildId}:${String(filesHash).slice(0, 16)}`;
}

export function describeMergePreview(preview) {
  const root = preview?.rootBuild || {};
  const branch = preview?.branch || {};
  const summary = preview?.diff?.summary || {};
  const lines = [
    `Main: Build #${root.id} "${root.title}" by ${root.ownerUsername || `user ${root.ownerUserId}`} (owner ${root.ownerUserId}${root.isPublic ? ", published" : ", not published"})`,
    `Branch: #${branch.branchNumber ?? "?"} (build ${branch.id}) by ${branch.contributorUsername || `user ${branch.contributorUserId}`}, ${branch.status}`,
    `Changes: ${summary.total || 0} file${summary.total === 1 ? "" : "s"} (${summary.added || 0} added, ${summary.updated || 0} updated, ${summary.deleted || 0} deleted)`,
    ...(preview?.diff?.changedFiles || []).map((file) => `  ${file.status} ${file.path}`),
    ...(preview?.diff?.changedFilesTruncated ? ["  …"] : []),
    preview?.openSuggestionMessageId
      ? "Open suggestion: yes, it closes as merged."
      : "Open suggestion: none.",
    `Charged to: the owner's storage quota (user ${preview?.charges?.storageQuotaUserId}).`,
  ];
  if (root.ownedByOperator) lines.push("This is your own app; `lumine suggestions merge` works too.");
  for (const refusal of preview?.refusals || []) lines.push(`Refused: ${refusal.message}`);
  if ((preview?.conflicts || []).length)
    lines.push(`Overlapping files: ${preview.conflicts.join(", ")}`);
  return lines;
}

export function describePublishPreview(preview) {
  const build = preview?.build || {};
  const checks = preview?.checks || {};
  const lines = [
    `Publish: Build #${build.id} "${build.title}" (${build.isPublic ? "update" : "first publish"})`,
    `Checks: project files ${checks.projectFiles?.ok ? "ok" : "fail"}, toolchain ${checks.toolchain?.ok ? "ok" : "fail"}, conflict markers ${checks.conflictMarkers?.ok ? "ok" : "fail"}`,
    ...(checks.toolchain?.ok ? [] : [`  ${checks.toolchain?.summary || ""}`]),
  ];
  const rewards = preview?.rewards;
  if (rewards) {
    lines.push(
      `Rewards: ${rewards.ready ? "ready for review" : "not ready"}; ${
        rewards.live
          ? rewards.matchesLive
            ? `same rules as the live approval (review #${rewards.live.reviewId})`
            : `different from the live approval (review #${rewards.live.reviewId})`
          : "no live approval"
      }`,
    );
  }
  for (const refusal of preview?.refusals || []) lines.push(`Refused: ${refusal.message}`);
  return lines;
}

function receiptError(receipt) {
  return receipt?.error || { code: "CLI_ADMIN_RECEIPT_INVALID", message: "No valid receipt." };
}

export async function runAdminBuildMergeWorkflow({
  options,
  operation,
  authToken,
  request = requestJson,
  confirm = confirmPrompt,
  log = () => {},
}) {
  const call = async (path, body, idempotencyKey) => {
    try {
      return await request({
        method: "POST",
        url: `${options.apiUrl}${path}`,
        authToken,
        body,
        headers: idempotencyKey ? { "x-lumine-idempotency-key": idempotencyKey } : {},
        timeoutMs: Math.max(120000, Number(options.timeoutMs) || 0),
      });
    } catch (error) {
      return {
        ok: false,
        error: error?.data?.error || {
          code: error?.code || "CLI_ADMIN_REQUEST_FAILED",
          message: String(error?.message || error),
        },
      };
    }
  };
  const fail = (step, data, error) => {
    process.exitCode = 1;
    return { ok: false, status: "error", data: { step, ...data }, error };
  };

  const previewReceipt = await call("/cli/admin/builds/admin-merge", { ...operation.branch });
  if (previewReceipt?.ok !== true) return fail("merge-preview", {}, receiptError(previewReceipt));
  const preview = previewReceipt.data;
  for (const line of describeMergePreview(preview)) log(line);
  if (preview.action !== "would_merge") {
    return fail("merge-preview", { preview }, {
      code: preview.refusals?.[0]?.code || "CLI_ADMIN_BUILD_MERGE_REFUSED",
      message: (preview.refusals || []).map((refusal) => refusal.message).join(" ") || "The merge was refused.",
    });
  }

  if (!options.assumeYes) {
    const answer = await confirm(
      `Merge branch #${preview.branch.branchNumber ?? preview.branch.id} into ${preview.rootBuild.ownerUsername || "the owner"}'s Main${operation.publish ? " and publish it" : ""}? [y/N] `,
    );
    if (answer !== true) {
      log(answer === null ? "Not a TTY: re-run with --yes to merge." : "Aborted. Nothing changed.");
      return { ok: true, status: "aborted", changed: false, data: { preview } };
    }
  }

  const mergeReceipt = await call(
    "/cli/admin/builds/admin-merge",
    {
      branchBuildId: preview.branch.id,
      expectedOwnerUserId: preview.rootBuild.ownerUserId,
      // With --publish the owner gets one notice, after the publish.
      notifyOwner: !operation.publish,
      dryRun: false,
    },
    adminMergeRequestKey(preview.branch.id),
  );
  if (mergeReceipt?.ok !== true) return fail("merge", { preview }, receiptError(mergeReceipt));
  const merge = mergeReceipt.data;
  log(
    `Merged branch #${merge.branchNumber ?? merge.branchBuildId} into Build #${merge.rootBuildId}${merge.afterVersionNumber ? ` as v${merge.afterVersionNumber}` : ""} (audit ${merge.auditId}).`,
  );
  if (!operation.publish) {
    return { ok: true, status: "success", changed: true, data: { preview, merge } };
  }

  const rootBuildId = merge.rootBuildId;
  const publishPreviewReceipt = await call(`/cli/admin/builds/${rootBuildId}/admin-publish`, {});
  if (publishPreviewReceipt?.ok !== true)
    return fail("publish-preview", { preview, merge }, receiptError(publishPreviewReceipt));
  const publishPreview = publishPreviewReceipt.data;
  for (const line of describePublishPreview(publishPreview)) log(line);
  if (publishPreview.action !== "would_publish") {
    return fail("publish-preview", { preview, merge, publishPreview }, {
      code: publishPreview.refusals?.[0]?.code || "CLI_ADMIN_BUILD_PUBLISH_REFUSED",
      message: `Merged, not published: ${(publishPreview.refusals || []).map((refusal) => refusal.message).join(" ")}`,
    });
  }
  const rewards = publishPreview.rewards;
  if (rewards && !rewards.matchesLive && operation.rewardRules !== "live") {
    return fail("publish-preview", { preview, merge, publishPreview }, {
      code: "build_admin_publish_reward_rules_differ",
      message: `Merged, not published: this version's rewards differ from the live approval (review #${rewards.live?.reviewId}). Re-run with --publish --reward-rules live to keep the live approved rules and caps, or review it normally.`,
    });
  }
  const publishReceipt = await call(
    `/cli/admin/builds/${rootBuildId}/admin-publish`,
    {
      dryRun: false,
      expectedOwnerUserId: publishPreview.build.ownerUserId,
      expectedFilesHash: publishPreview.filesHash,
      ...(rewards ? { expectedApproval: rewards.approval, rewardRules: operation.rewardRules } : {}),
      branchBuildId: merge.branchBuildId,
    },
    adminPublishRequestKey(rootBuildId, publishPreview.filesHash),
  );
  if (publishReceipt?.ok !== true)
    return fail("publish", { preview, merge, publishPreview }, receiptError(publishReceipt));
  const publish = publishReceipt.data;
  log(
    `Published Build #${rootBuildId}${publish.publishedVersion ? ` v${publish.publishedVersion}` : ""} (${publish.path === "reward_review" ? `reward review #${publish.rewardReview?.reviewId} approved` : "no reward review needed"}, audit ${publish.auditId}). Owner notified: ${publish.ownerNotified ? "yes" : "no"}.`,
  );
  return {
    ok: true,
    status: "success",
    changed: true,
    data: { preview, merge, publishPreview, publish },
  };
}

export function formatAdminBuildMergeResult({ data }) {
  const lines = [];
  if (data?.publish) {
    lines.push(
      `Done: branch merged into Build #${data.merge?.rootBuildId} and published${data.publish.publishedVersion ? ` as v${data.publish.publishedVersion}` : ""}.`,
    );
  } else if (data?.merge) {
    lines.push(`Done: branch merged into Build #${data.merge.rootBuildId}. Not published.`);
  } else if (data?.preview) {
    lines.push("Nothing changed.");
  }
  return lines;
}
