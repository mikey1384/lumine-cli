import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import { requestJson } from "./http.js";
import { sleep, trimTrailingSlash } from "./util.js";

export async function login(options) {
  const report = options.loginProgressToStderr
    ? (...args) => console.error(...args)
    : (...args) => console.log(...args);
  const start = await requestJson({
    method: "POST",
    url: `${options.apiUrl}/cli/device/start`,
    body: {
      clientName: options.clientName,
      scopes: [
        "build:read",
        "build:write",
        "build:check",
        "build:publish",
        "build:sdk",
      ],
    },
    timeoutMs: options.timeoutMs,
  });

  const approvalUrl = start.verificationUriComplete || start.verificationUri;
  report("Connect Lumine CLI to Twinkle.");
  if (options.openBrowser && approvalUrl) {
    report("Opening Twinkle in your browser...");
    const opened = await openBrowser(approvalUrl);
    if (!opened) report("Could not open the browser automatically.");
  }
  report(`Approval link: ${approvalUrl}`);
  report(`Code: ${start.userCode}`);
  report("Leave this terminal open. Waiting for approval...");

  const intervalMs = Math.max(Number(start.interval || 3), 1) * 1000;
  const startedAt = Date.now();
  const expiresInMs = Math.max(Number(start.expiresIn || 600), 1) * 1000;

  while (Date.now() - startedAt < expiresInMs) {
    await sleep(intervalMs);
    const tokenResponse = await pollToken({
      options,
      deviceCode: start.deviceCode,
    });
    if (!tokenResponse) continue;

    await writeAuth({
      options,
      token: tokenResponse.accessToken,
      username: tokenResponse.user?.username || "",
      userId: tokenResponse.user?.id || null,
      expiresAt: Date.now() + Number(tokenResponse.expiresIn || 0) * 1000,
    });
    report(
      `Logged in${tokenResponse.user?.username ? ` as ${tokenResponse.user.username}` : ""}.`,
    );
    report("You can now run `lumine` to choose a project.");
    return;
  }

  throw new Error("Login code expired. Run `lumine login` again.");
}

export async function pollToken({ options, deviceCode }) {
  try {
    return await requestJson({
      method: "POST",
      url: `${options.apiUrl}/cli/device/token`,
      body: { deviceCode },
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error.status === 428 || error.data?.error === "authorization_pending") {
      return null;
    }
    throw error;
  }
}

export async function logout(options) {
  let removed = false;
  try {
    await fs.unlink(options.authFile);
    removed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(
    removed
      ? `Removed Lumine CLI login at ${options.authFile}`
      : `No Lumine CLI login found at ${options.authFile}`,
  );
}

export async function whoami(options) {
  const auth = await resolveAuth(options);
  const session = await requestJson({
    url: `${options.apiUrl}/cli/session`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  console.log(
    `Logged in as ${session.username || auth.username || "unknown"} ` +
      `(userId=${session.userId || auth.userId || "unknown"})`,
  );
}

export async function ensureAuth(options) {
  try {
    return await resolveAuth(options);
  } catch (error) {
    if (options.authToken || !isMissingLoginError(error)) throw error;
  }
  await login({
    ...options,
    loginProgressToStderr: Boolean(options.json),
  });
  return await resolveAuth(options);
}

export async function resolveAuth(options) {
  if (options.authToken) {
    return { token: options.authToken };
  }
  try {
    const text = await fs.readFile(options.authFile, "utf8");
    const auth = JSON.parse(text);
    if (auth.apiUrl && trimTrailingSlash(auth.apiUrl) !== options.apiUrl) {
      throw new Error(
        `Saved login is for ${auth.apiUrl}. Run ` +
          `lumine login --api-url ${options.apiUrl}.`,
      );
    }
    if (auth.token) return auth;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new Error("Run `lumine login` before launching a Twinkle build.");
}

export async function writeAuth({ options, token, username, userId, expiresAt }) {
  let existingAuth = {};
  try {
    existingAuth = JSON.parse(await fs.readFile(options.authFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeAuthFile(options, {
    ...existingAuth,
    token,
    username,
    userId,
    expiresAt,
    apiUrl: options.apiUrl,
    createdAt: new Date().toISOString(),
  });
}

export async function writeAuthFile(options, auth) {
  await fs.mkdir(path.dirname(options.authFile), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(options.authFile, JSON.stringify(auth, null, 2), {
    mode: 0o600,
  });
  await fs.chmod(options.authFile, 0o600);
}

export async function saveSelectedBuild({ options, auth, build }) {
  if (options.authToken || !build?.id) return;
  await writeAuthFile(options, {
    ...auth,
    selectedBuildId: Number(build.id),
    selectedBuildTitle: build.title || `Build ${build.id}`,
    selectedBuildRole: build.role || "",
    selectedAt: new Date().toISOString(),
  });
}

export async function assertAuthScope({ options, auth, scope }) {
  const session = await requestJson({
    url: `${options.apiUrl}/cli/session`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  if (!scopes.includes(scope)) {
    throw new Error(
      `Saved login is missing ${scope}. Run \`lumine login\` again to grant it.`,
    );
  }
}

export function isMissingLoginError(error) {
  return String(error?.message || "").includes("Run `lumine login`");
}

export async function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
