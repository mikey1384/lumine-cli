// `lumine admin teachers branches …`: the teacher branch registry (2026-10-08).
// Which Twinkle branch each approved teacher works at, confirmed by Mikey
// through the academy networks teachers use, not the branch they typed when
// they applied. Mikey only, any time, no daily run. Networks are named by a
// short id and a masked address; a raw address never reaches the CLI.
//
//   suggest                 academy networks found live, each with a suggested branch
//   networks                the confirmed networks
//   confirm <networkId> --branch <name> [--branch <name>]   (two or more: a shared building)
//   unconfirm <networkId>
//   set <userId|username> --branch <name> [--note]   owner setting, beats networks
//   clear <userId|username>
//   apply                   recompute network branches from the confirmed networks
//   list [--branch <name>|none]

export const TEACHER_BRANCHES_USAGE =
  "Use: lumine admin teachers branches suggest | networks | confirm <networkId> --branch <name> [--branch <name> ...] [--note <text>] | unconfirm <networkId> | set <userId|username> --branch <name> [--note <text>] | clear <userId|username> | apply | list [--branch <name>|none] [--json]";

const BASE = "/cli/admin/teachers/branches";
// a live scan of a year of teachers' network use: the server stops at 75 s
const SCAN_TIMEOUT_MS = 150000;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

const read = (name, path, extra = {}) => ({
  name,
  method: "GET",
  path,
  body: undefined,
  mutates: false,
  requiresRun: false,
  ...extra,
});
const write = (name, path, body, extra = {}) => ({
  name,
  method: "POST",
  path,
  body,
  mutates: true,
  requiresRun: false,
  ...extra,
});

/** --branch (repeatable, or comma-separated) and --branches → names. */
export function parseBranchNames(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

function networkIdOf(raw) {
  const id = String(raw || "").trim().toLowerCase();
  if (!/^[0-9a-f]{10}$/.test(id)) {
    throw validationError(
      "Name the network by the 10-character id `lumine admin teachers branches suggest` printed.",
    );
  }
  return id;
}

function teacherRefOf(raw) {
  const ref = String(raw || "").trim();
  if (!ref) throw validationError(TEACHER_BRANCHES_USAGE);
  return encodeURIComponent(ref);
}

export function buildTeacherBranchOperation({ sub, target, options }) {
  const names = parseBranchNames(options.adminBranch);
  const note = String(options.note || "").trim();
  if (!sub || sub === "list") {
    const branch = names.join(",");
    return read(
      "teachers.branches.list",
      branch ? `${BASE}?branch=${encodeURIComponent(branch)}` : BASE,
    );
  }
  if (sub === "suggest") {
    return read("teachers.branches.suggest", `${BASE}/suggest`, {
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }
  if (sub === "networks") {
    return read("teachers.branches.networks", `${BASE}/networks`);
  }
  if (sub === "confirm") {
    const id = networkIdOf(target);
    if (!names.length) {
      throw validationError(
        "confirm needs --branch <name> (repeat --branch, or --branches A,B, for a building branches share).",
      );
    }
    return write(
      "teachers.branches.confirm",
      `${BASE}/networks/${id}`,
      { branches: names, ...(note ? { note } : {}) },
      { timeoutMs: SCAN_TIMEOUT_MS },
    );
  }
  if (sub === "unconfirm") {
    return write("teachers.branches.unconfirm", `${BASE}/networks/${networkIdOf(target)}/unconfirm`, {});
  }
  if (sub === "set") {
    const ref = teacherRefOf(target);
    if (names.length !== 1) throw validationError("set needs exactly one --branch <name>.");
    return write("teachers.branches.set", `${BASE}/teacher/${ref}`, {
      branch: names[0],
      ...(note ? { note } : {}),
    });
  }
  if (sub === "clear") {
    return write("teachers.branches.clear", `${BASE}/teacher/${teacherRefOf(target)}/clear`, {});
  }
  if (sub === "apply") {
    return write("teachers.branches.apply", `${BASE}/apply`, {}, { timeoutMs: SCAN_TIMEOUT_MS });
  }
  throw validationError(TEACHER_BRANCHES_USAGE);
}

/** What an apply keeps as its receipt: counts and the changes, not the lists. */
export function teacherBranchApplyReceipt(data = {}) {
  return {
    counts: data.counts || null,
    changes: (data.changes || []).map((c) => ({
      userId: c.userId ?? null,
      from: c.from ?? null,
      to: c.to ?? null,
      ...(c.to ? { share: c.share ?? null, actions: c.actions ?? null, days: c.days ?? null } : {}),
    })),
  };
}

const day = (seconds) =>
  Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString().slice(0, 10) : "-";
const GAP_LABELS = {
  replica_busy: "replica busy",
  time_limit: "read too slow",
  time_budget: "out of time",
  unreadable: "replica busy or too slow",
};
const gapText = (gaps) => {
  const parts = Object.entries(gaps || {})
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${n} ${GAP_LABELS[why] || why}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
};
const evidence = (x) =>
  x && x.actions != null ? ` · ${x.actions} actions on ${x.days ?? "?"} day(s)` : "";
const names = (branches) => (branches || []).map((b) => b.displayName || b).join(" + ");

function printSuggest(data) {
  console.log(
    `Academy networks (${data.academyMinAccounts}+ accounts in ${data.windowDays} days) used by the ${data.teachers} approved teachers: ${(data.networks || []).length}.`,
  );
  if (data.incomplete) {
    console.log(
      `Incomplete: ${data.teachersNotRead} teacher(s) not read${gapText(data.teachersNotReadBy)}, ${data.addressesNotCounted} address(es) not counted${gapText(data.addressesNotCountedBy)}. Run it again for the rest.`,
    );
  }
  for (const n of data.networks || []) {
    console.log("");
    console.log(
      `${n.networkId}  ${n.address} · ${n.accounts} accounts · ${n.teachers} teachers · ${n.teacherActions} teacher actions · ${day(n.firstAt)} → ${day(n.lastAt)}`,
    );
    const suggestion = n.suggested
      ? n.suggested.displayName
      : n.tiedWith?.length
        ? `tie: ${names(n.tiedWith)}`
        : "none (no official branch typed)";
    console.log(
      `  suggested: ${suggestion}${n.confirmed ? ` · CONFIRMED: ${names(n.confirmed.branches)}${n.confirmed.note ? ` (${n.confirmed.note})` : ""}` : ""}`,
    );
    console.log(`  typed: ${(n.typed || []).map((t) => `${t.branch} ${t.teachers}`).join(", ")}`);
    console.log(
      `  top: ${(n.topTeachers || []).map((t) => `${t.username || "?"} (#${t.userId}${t.typedBranch ? `, typed "${t.typedBranch}"` : ""}) ${t.actions}`).join("; ")}`,
    );
  }
  if ((data.confirmedNotSeen || []).length) {
    console.log("\nConfirmed but not seen as an academy network this time:");
    for (const n of data.confirmedNotSeen) console.log(`  ${n.networkId}  ${n.address} → ${names(n.branches)}`);
  }
  console.log(
    `\nOfficial branches: ${(data.officialBranches || []).map((b) => b.displayName).join(", ")}`,
  );
  console.log(
    "Confirm: lumine admin teachers branches confirm <networkId> --branch <name> (repeat --branch for a building branches share), then: lumine admin teachers branches apply",
  );
}

function printList(data) {
  const counts = Object.entries(data.counts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([branch, n]) => `${branch} ${n}`)
    .join(", ");
  console.log(`${data.total} approved teachers: ${counts || "-"}`);
  let current = null;
  for (const t of data.teachers || []) {
    const label = t.branch?.displayName || "No confirmed branch";
    if (label !== current) {
      current = label;
      console.log(`\n${label}`);
    }
    const source = t.branch
      ? t.branch.source === "owner"
        ? " · set by owner"
        : ` · network ${t.branch.share ?? "?"}%${evidence(t.branch)}`
      : "";
    console.log(
      `  ${t.username} (#${t.userId})${source}${t.typedBranch ? ` · typed "${t.typedBranch}"` : ""} · last active ${day(t.lastActive)}`,
    );
  }
}

function printApply(data) {
  const c = data.counts || {};
  console.log(
    `Applied ${c.confirmedNetworks} confirmed network(s) to ${c.teachers} teachers: ${c.assigned} assigned, ${c.ambiguous} ambiguous, ${c.lowEvidence ?? 0} low evidence (under ${c.minDays ?? "?"} days), ${c.unknown} unknown, ${c.ownerSet} set by owner${c.notRead ? `, ${c.notRead} not read${gapText(c.notReadBy)} (unchanged; run again)` : ""}. ${c.changed} changed; ${c.differsFromTyped} differ from what they typed${c.removedNotTeachers ? `; ${c.removedNotTeachers} former teacher row(s) removed` : ""}.`,
  );
  if ((data.changes || []).length) {
    console.log("\nChanged:");
    for (const ch of data.changes) {
      console.log(
        `  ${ch.username} (#${ch.userId}): ${ch.from || "none"} → ${ch.to || "none"}${ch.to ? ` (${ch.share}%${evidence(ch)})` : ""}`,
      );
    }
  }
  if ((data.ambiguous || []).length) {
    console.log("\nAmbiguous (set one with `teachers branches set <user> --branch <name>`):");
    for (const a of data.ambiguous) {
      console.log(
        `  ${a.username} (#${a.userId}) · ${a.candidates.join(" or ")} · ${a.split}${a.typedBranch ? ` · typed "${a.typedBranch}"` : ""} · ${a.reason}`,
      );
    }
  }
  if ((data.lowEvidence || []).length) {
    console.log(
      `\nLow evidence, not assigned (fewer than ${data.counts?.minDays ?? "?"} days on the branch: a visit, or a new teacher):`,
    );
    for (const l of data.lowEvidence) {
      console.log(
        `  ${l.username} (#${l.userId}) · ${l.branch} ${l.share}%${evidence(l)}${l.typedBranch ? ` · typed "${l.typedBranch}"` : ""}`,
      );
    }
  }
  if ((data.differsFromTyped || []).length) {
    console.log("\nAssigned a branch other than the one they typed:");
    for (const d of data.differsFromTyped) {
      console.log(`  ${d.username} (#${d.userId}) · typed "${d.typedBranch}" · network ${d.branch} ${d.share}%${evidence(d)}`);
    }
  }
  const unknown = Object.entries(data.unknownReasons || {});
  if (unknown.length) console.log(`\nUnknown: ${unknown.map(([why, n]) => `${n} ${why}`).join("; ")}`);
}

export function printTeacherBranchResult({ operation, data }) {
  switch (operation.name) {
    case "teachers.branches.suggest":
      return printSuggest(data);
    case "teachers.branches.list":
      return printList(data);
    case "teachers.branches.apply":
      return printApply(data);
    case "teachers.branches.networks": {
      const networks = data.networks || [];
      if (!networks.length) return console.log("No confirmed networks yet: lumine admin teachers branches suggest");
      for (const n of networks) {
        console.log(
          `${n.networkId}  ${n.address} → ${names(n.branches)}${n.shared ? " (shared building)" : ""} · confirmed ${day(n.confirmedAt)}${n.note ? ` · ${n.note}` : ""}`,
        );
      }
      return undefined;
    }
    case "teachers.branches.confirm":
      return console.log(
        `Confirmed ${data.networkId} (${data.address}) as ${names(data.branches)}${data.shared ? " (a shared building: each teacher's typed branch decides there)" : ""}${data.previous?.length ? `; was ${data.previous.join(" + ")}` : ""}. Next: ${data.next}`,
      );
    case "teachers.branches.unconfirm":
      return console.log(
        `Unconfirmed ${data.networkId} (${data.address}; was ${(data.removedBranches || []).join(" + ")}). Next: ${data.next}`,
      );
    case "teachers.branches.set":
      return console.log(
        `${data.username} (#${data.userId}) is now ${data.branch?.displayName} (set by owner; networks no longer change it)${data.previous ? `; was ${data.previous.branchKey} (${data.previous.source})` : ""}.`,
      );
    case "teachers.branches.clear":
      return console.log(
        data.previous
          ? `Cleared #${data.userId}${data.username ? ` (${data.username})` : ""}: was ${data.previous.branchKey} (${data.previous.source}). ${data.next}`
          : `#${data.userId} had no branch.`,
      );
    default:
      return console.log(JSON.stringify(data, null, 2));
  }
}
