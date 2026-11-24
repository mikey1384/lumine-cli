import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../lib/commands.js";
import { COMMANDS } from "../lib/constants.js";
import { deleteCommand, parseDeleteConfirm } from "../lib/delete.js";

const API = "https://api.example.test";
const options = (...args) => ({ ...parseArgs(["delete", ...args]), apiUrl: API, authToken: "t" });

const MAIN = { id: 2685, title: "Abyssal - Tidewatch", role: "owner", ownerUserId: 5, ownerUsername: "mikey", contributionStatus: "none", contributionRootBuildId: null, isPublic: true, publishedAt: 100 };
const BRANCH = { id: 2721, title: "mikey's branch", role: "owner", ownerUserId: 5, ownerUsername: "mikey", contributionStatus: "draft", contributionRootBuildId: 2685, contributionBranchNumber: 3, isPublic: false };

function fakeServer(builds) {
  const calls = [];
  const request = async ({ method = "GET", url, body }) => {
    const route = url.replace(API, "");
    calls.push({ method, route, body });
    const files = route.match(/^\/cli\/build\/(\d+)\/files\?includeContent=0$/);
    if (method === "GET" && files) return { build: builds[files[1]] };
    if (method === "GET" && /^\/cli\/build\/\d+\/versions\?limit=200$/.test(route)) return { versions: [{ version: 2 }, { version: 1 }] };
    if (method === "GET" && route === "/cli/build/2685/branches/3") return { build: BRANCH };
    if (method === "GET" && route === "/build/2685/contributions?limit=100") return { contributions: [BRANCH, { id: 2800 }] };
    if (method === "DELETE" && route.startsWith("/build/")) return { success: true };
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { request, calls };
}
const deps = (server, lines = []) => ({ request: server.request, log: (l) => lines.push(l), checkScope: async () => ({}), auth: { token: "t" } });

test("delete is a command; --confirm stands alone; the target is the first positional", () => {
  assert.ok(COMMANDS.has("delete"));
  const parsed = options("https://www.twin-kle.com/build/2721", "--confirm", "--title", "mikey's branch");
  assert.equal(parsed.command, "delete");
  assert.equal(parsed.target, "https://www.twin-kle.com/build/2721");
  assert.equal(parsed.adminConfirm, "true");
  assert.equal(parsed.title, "mikey's branch");
  assert.equal(parseDeleteConfirm(""), false);
  assert.throws(() => parseDeleteConfirm("yes"), /on its own/);
});

test("the dry run shows the branch, its Main, owner and versions, and deletes nothing", async () => {
  const server = fakeServer({ 2721: BRANCH, 2685: MAIN });
  const lines = [];
  const result = await deleteCommand(options("2721"), deps(server, lines));
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    { isBranch: result.build.isBranch, branchNumber: result.build.branchNumber, rootBuildId: result.build.rootBuildId, rootTitle: result.build.rootTitle, versionCount: result.build.versionCount },
    { isBranch: true, branchNumber: 3, rootBuildId: 2685, rootTitle: "Abyssal - Tidewatch", versionCount: 2 },
  );
  assert.match(lines[0], /^Would delete branch #3 "mikey's branch" \(build 2721\) of Build #2685 "Abyssal - Tidewatch", owned by mikey\.$/);
  assert.ok(lines.some((l) => /Saved versions: 2 versions/.test(l)));
  assert.ok(lines.some((l) => /Nothing was deleted\. To delete it: lumine delete 2721 --confirm --title "mikey's branch"/.test(l)));
  assert.equal(server.calls.filter((c) => c.method === "DELETE").length, 0);
});

test("a Main's dry run says its branches and published app go with it", async () => {
  const server = fakeServer({ 2685: MAIN });
  const lines = [];
  await deleteCommand(options("2685"), deps(server, lines));
  assert.ok(lines.some((l) => /also deletes its 2 branches/.test(l)));
  assert.ok(lines.some((l) => /published app goes away/.test(l)));
});

test("--confirm sends the website's exact request: DELETE /build/:id with { confirmTitle }", async () => {
  const server = fakeServer({ 2721: BRANCH, 2685: MAIN });
  const lines = [];
  // A branch URL (root + branch number) resolves to the branch build first.
  const result = await deleteCommand(options("https://www.twin-kle.com/build/2685/3", "--confirm", "--title", "mikey's branch"), deps(server, lines));
  const del = server.calls.filter((c) => c.method === "DELETE");
  assert.equal(del.length, 1);
  assert.equal(del[0].route, "/build/2721");
  assert.deepEqual(del[0].body, { confirmTitle: "mikey's branch" });
  assert.equal(result.deleted, true);
  assert.match(lines.at(-1), /^Deleted branch #3 "mikey's branch" \(build 2721\) of Build #2685/);
});

test("refused before any delete: not the owner, a title that does not match, no target", async () => {
  const server = fakeServer({ 2721: { ...BRANCH, role: "collaborator", ownerUsername: "kid" } });
  await assert.rejects(deleteCommand(options("2721", "--confirm"), deps(server)), /You do not own Build #2721 "mikey's branch" \(owner: kid\)/);
  const owned = fakeServer({ 2721: BRANCH, 2685: MAIN });
  await assert.rejects(deleteCommand(options("2721", "--confirm", "--title", "Other"), deps(owned)), /does not match the current title "mikey's branch"\. Nothing was deleted/);
  await assert.rejects(deleteCommand(options(), deps(owned)), /Usage: lumine delete/);
  assert.equal([...server.calls, ...owned.calls].filter((c) => c.method === "DELETE").length, 0);
});
