import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_ADMIN_JSON_BYTES = 2 * 1024 * 1024;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function formatByteLimit(maxBytes) {
  const megabytes = maxBytes / (1024 * 1024);
  return Number.isInteger(megabytes) ? `${megabytes} MB` : `${maxBytes} bytes`;
}

export function readAdminJsonFile(
  filePath,
  label = "JSON file",
  { maxBytes = MAX_ADMIN_JSON_BYTES } = {},
) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) throw validationError(`Pass ${label}.`);
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw validationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    throw validationError(
      `${label} must be under ${formatByteLimit(maxBytes)}.`,
    );
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw validationError(`${normalizedPath} is not valid JSON.`);
  }
}

export function writeAdminJsonFile(
  filePath,
  value,
  { privateFile = false, maxBytes = null } = {},
) {
  const resolved = path.resolve(String(filePath || "").trim());
  if (!String(filePath || "").trim()) {
    throw validationError("An output file path is required.");
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  // Checkpoints can contain private management evidence and often live in a
  // shared temporary directory. Use an unguessable, exclusive staging file so
  // another local account cannot pre-place a symlink at the temporary path.
  const temporary = `${resolved}.tmp-${process.pid}-${randomUUID()}`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (
    Number.isSafeInteger(maxBytes) &&
    maxBytes > 0 &&
    Buffer.byteLength(contents, "utf8") > maxBytes
  ) {
    throw validationError(
      `The output exceeds the ${formatByteLimit(maxBytes)} safety limit. Narrow the request before retrying.`,
    );
  }
  try {
    writeFileSync(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: privateFile ? 0o600 : 0o644,
    });
    renameSync(temporary, resolved);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The exclusive create or successful rename may leave nothing to clean.
    }
    throw error;
  }
  if (privateFile) chmodSync(resolved, 0o600);
  return resolved;
}

export function extractNewsClaim(value) {
  const claim = value?.claim || value?.data?.claim || value;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    throw validationError("The claim file does not contain a newspaper claim.");
  }
  const editionId = Number(claim.editionId || 0);
  const leaseToken = String(claim.leaseToken || "").trim();
  const events = Array.isArray(claim.events) ? claim.events : null;
  if (
    !Number.isSafeInteger(editionId) ||
    editionId <= 0 ||
    !leaseToken ||
    !events
  ) {
    throw validationError(
      "The claim file is missing editionId, leaseToken, or canonical events.",
    );
  }
  return { ...claim, editionId, leaseToken, events };
}

function exactQuoteFromSummary(summary, maximum) {
  return String(summary || "").slice(0, Math.max(0, maximum));
}

function scaffoldStory(event, maximum) {
  return {
    eventKey: String(event.eventKey || ""),
    headline: "",
    summary: "",
    sourceQuote:
      String(event.section || "") === "front"
        ? exactQuoteFromSummary(event.summary, maximum)
        : "",
    coveredEventKeys: [],
  };
}

export function createNewsEditorialScaffold(claimValue) {
  const claim = extractNewsClaim(claimValue);
  const maximum = Math.max(0, Number(claim.maxSourceQuoteLength || 360));
  const frontIndex = claim.events.findIndex(
    (event) => String(event?.section || "") === "front",
  );
  const lead =
    frontIndex >= 0 ? scaffoldStory(claim.events[frontIndex], maximum) : null;
  const stories = claim.events
    .filter((_event, index) => index !== frontIndex)
    .map((event) => scaffoldStory(event, maximum));
  return {
    mastheadHeadline: "",
    mastheadDeck: "",
    ...(lead ? { lead } : {}),
    stories,
    editorsNote: "",
  };
}

function requireEditorialText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(`${label} must be non-empty text.`);
  }
}

export function validateNewsEditorial({ claim: claimValue, editorial }) {
  const claim = extractNewsClaim(claimValue);
  if (!editorial || typeof editorial !== "object" || Array.isArray(editorial)) {
    throw validationError("The editorial must be a JSON object.");
  }
  requireEditorialText(editorial.mastheadHeadline, "mastheadHeadline");
  requireEditorialText(editorial.mastheadDeck, "mastheadDeck");
  requireEditorialText(editorial.editorsNote, "editorsNote");
  if (!Array.isArray(editorial.stories)) {
    throw validationError("stories must be an array.");
  }
  const eventByKey = new Map(
    claim.events.map((event) => [String(event?.eventKey || ""), event]),
  );
  const usedKeys = new Set();
  const maximum = Math.max(0, Number(claim.maxSourceQuoteLength || 360));
  const entries = [
    ...(editorial.lead
      ? [{ label: "lead", story: editorial.lead, lead: true }]
      : []),
    ...editorial.stories.map((story, index) => ({
      label: `stories[${index}]`,
      story,
      lead: false,
    })),
  ];
  for (const entry of entries) {
    const story = entry.story;
    if (!story || typeof story !== "object" || Array.isArray(story)) {
      throw validationError(`${entry.label} must be an object.`);
    }
    const eventKey = String(story.eventKey || "").trim();
    const event = eventByKey.get(eventKey);
    if (!event)
      throw validationError(`${entry.label}.eventKey is not in the claim.`);
    if (usedKeys.has(eventKey)) {
      throw validationError(`${eventKey} is cited or covered more than once.`);
    }
    usedKeys.add(eventKey);
    if (entry.lead && String(event.section || "") !== "front") {
      throw validationError("The lead must cite a front-section event.");
    }
    requireEditorialText(story.headline, `${entry.label}.headline`);
    requireEditorialText(story.summary, `${entry.label}.summary`);
    const quote =
      typeof story.sourceQuote === "string" ? story.sourceQuote : "";
    if (String(event.section || "") === "front") {
      const canonicalSummary = String(event.summary || "");
      const quoteIsValid = canonicalSummary
        ? Boolean(
            quote &&
            quote.length <= maximum &&
            canonicalSummary.includes(quote),
          )
        : quote === "";
      if (!quoteIsValid) {
        throw validationError(
          `${entry.label}.sourceQuote must be an exact contiguous claim-summary passage no longer than ${maximum} characters.`,
        );
      }
    } else if (quote !== "") {
      throw validationError(
        `${entry.label}.sourceQuote must be empty outside the front section.`,
      );
    }
    const covered = story.coveredEventKeys ?? [];
    if (!Array.isArray(covered)) {
      throw validationError(
        `${entry.label}.coveredEventKeys must be an array.`,
      );
    }
    for (const rawCoveredKey of covered) {
      const coveredKey = String(rawCoveredKey || "").trim();
      if (!eventByKey.has(coveredKey)) {
        throw validationError(
          `${entry.label} covers an eventKey not in the claim.`,
        );
      }
      if (coveredKey === eventKey || usedKeys.has(coveredKey)) {
        throw validationError(
          `${coveredKey} is cited or covered more than once.`,
        );
      }
      usedKeys.add(coveredKey);
    }
  }
  return {
    valid: true,
    editionId: claim.editionId,
    citedEventCount: entries.length,
    coveredEventCount: usedKeys.size - entries.length,
    availableEventCount: claim.events.length,
  };
}

export function writeNewsClaimArtifacts({ result, outputPath, scaffoldPath }) {
  const claim = result?.data?.claim || null;
  const artifacts = { claimFile: null, scaffoldFile: null };
  if (outputPath) {
    artifacts.claimFile = writeAdminJsonFile(
      outputPath,
      { schemaVersion: 1, savedAt: new Date().toISOString(), claim },
      { privateFile: true },
    );
  }
  if (scaffoldPath && claim) {
    artifacts.scaffoldFile = writeAdminJsonFile(
      scaffoldPath,
      createNewsEditorialScaffold(claim),
    );
  }
  return artifacts;
}
