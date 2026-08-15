const PASSTHROUGH_ENVIRONMENT_KEYS = new Set([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

// Subscription CLIs load their own saved login from their local config or
// keychain. Give the provider only the environment needed to launch and find
// that saved login; in particular, do not expose Twinkle auth, cloud keys, or
// API-key billing credentials to a model-accessible child process.
export function createSubscriptionAgentEnvironment(source = process.env) {
  const environment = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value !== undefined &&
      (PASSTHROUGH_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))
    ) {
      environment[key] = String(value);
    }
  }
  return environment;
}
