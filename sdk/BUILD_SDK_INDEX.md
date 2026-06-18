# Build SDK Index

Version: 1.26.2
Updated: 2026-06-09
Generated: 2026-06-18T12:26:29.648Z

## Notes
- This SDK is injected into Build iframes via the Build preview/runtime.
- Widgets call SDK methods; the parent proxies to the API.
- Data API methods require scoped tokens handled by the parent; some namespaces include write methods.
- Use Twinkle.privateDb for LOW-frequency durable private per-user state such as preferences, drafts, settings, inventory checkpoints, and saved progress. It is NOT for high-frequency or per-frame/per-tick writes; the server rate-limits writes and returns 429.
- Match storage to update frequency: privateDb and sharedDb are for LOW-frequency durable state that changes on a user action. NEVER write per-frame/per-tick state to them (camera or cursor position, animation, live movement, presence, autosave every frame/tick). Keep live state in client memory, broadcast realtime/presence via Twinkle.world, and flush only occasional durable snapshots (on an interval or on exit, never per frame). The server enforces per-key write rate limits and returns 429 on excess; never retry-loop a 429.
- Use Twinkle.userDb only for advanced private SQLite needs such as tables, indexes, many rows, filtered queries, or aggregates.
- Use Twinkle.leaderboards for public Build scoreboards. Signed-in viewers are ranked by Twinkle username; guests can submit with a display name.
- Use Twinkle.sharedDb for LOW-frequency durable shared multi-user state such as guestbooks, votes, room settings, submitted records, and append-only run history. It is NOT for high-frequency or per-frame/per-tick writes; keep live/realtime state in Twinkle.world or client memory. The server rate-limits writes and returns 429.
- Use Twinkle.subjects.search for in-app subject pickers. Twinkle.mount remains an optional host-provided preselection/context shortcut, not a data API.
- Use Twinkle.aiCards for read-only existing public AI Card words and example texts, including word levels for typing games.
- Use Twinkle.aiStories for read-only existing AI Story galleries, readers, quizzes, topic chapter indexes, and remix tools.
- Use Twinkle.grammarbles for public Grammarbles question-bank trainer apps and optional signed-in viewer attempt-history filtering.
- Use Twinkle.chess for chess engine play and analysis; app code still owns chess rules, legal moves, board state, and UI.
- Use Twinkle.world for realtime multiplayer rooms, avatar presence, movement, emotes, and lightweight actions; world sessions are disposable and durable MMO state belongs in sharedDb/privateDb.
- Use Twinkle.characters.chat for real Zero/Ciel NPC dialogue with shared room context and AI Energy-aware thinking modes.
- Twinkle.ai.chat history entries must use { role, content }; map local message.text fields to content before passing history.

## Token Scopes
files:read, user:read, users:read, dailyReflections:read, content:read, sharedDb:read, sharedDb:write, privateDb:read, privateDb:write, files:write, chat:read, chat:write, notifications:read, notifications:write, notifications:emit, reminders:read, reminders:write

## Namespaces

### Twinkle.capabilities
- async get() | scopes: none
  - Returns: Capability snapshot
  - Includes viewer state, available namespaces, blocked writes, and Lumine action permissions.
- async can(actionName) | scopes: none
  - Returns: boolean
  - Checks whether a named Lumine action is allowed in the current context.
- async listActions() | scopes: none
  - Returns: { available, blocked, details }
  - Returns the current Lumine action permission map.
- async refresh() | scopes: none
  - Returns: Capability snapshot
  - Forces a fresh fetch from the parent.

### Twinkle.viewer
- async get() | scopes: none
  - Returns: { id, username, profilePicUrl, isLoggedIn, isOwner, isGuest }
  - Cached; use refresh() to re-fetch.
- async refresh() | scopes: none
  - Returns: Viewer info
  - Forces a fresh fetch from the parent.

### Twinkle.preview
- getLayout() | scopes: none
  - Returns: { mode, viewport, stage, safeInsets, playfield }
  - Read the host preview layout and derive a fixed-world scale from layout.playfield before sizing a canvas, sprites, or mobile game UI.
  - Always available in the build iframe.
  - Returns the current preview geometry, including viewport size, current stage size/scale, reserved safe insets, and the usable playfield rectangle.
  - Use this as the source of truth for canvas/game sizing instead of guessing from raw window size alone.
  - For fixed-world games, derive one scale from layout.playfield and apply it consistently to sprites, UI, and movement.
  - Do not subtract guessed HUD or chrome heights from the viewport when layout.playfield already represents the usable gameplay area.
  - Example: const WORLD = { width: 360, height: 640 }; const layout = Twinkle.preview.getLayout(); const scale = Math.min(layout.playfield.width / WORLD.width, layout.playfield.height / WORLD.height);
- reserveInsets({ top, right, bottom, left }) | scopes: none
  - Returns: { mode, viewport, stage, safeInsets, playfield }
  - Reserve host-aware safe space for HUD bars, touch controls, or other overlays before clamping gameplay.
  - Always available in the build iframe.
  - Reserves in-app safe space for overlays such as HUD bars or touch controls.
  - After reserving insets, clamp gameplay to playfield instead of the raw canvas or stage edge.
  - Example: Twinkle.preview.reserveInsets({ top: 72, bottom: 120, left: 0, right: 0 });
- setPlayfield({ x, y, width, height } | null) | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Declare the actual playable rectangle when the game area is smaller than the raw canvas.
  - Always available in the build iframe.
  - Declares the game or canvas playfield bounds in the app's own coordinate space.
  - Use this when the playable area is smaller than the raw canvas because of HUD, touch controls, or other reserved regions.
  - Do not pass DOM screen pixels from getBoundingClientRect(); use the same in-game coordinate space as your world and player logic.
  - Example: Twinkle.preview.setPlayfield({ x: layout.playfield.x, y: layout.playfield.y, width: layout.playfield.width, height: layout.playfield.height });
- reportGameplayState({ playfieldBounds?, playerBounds? } | null) | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Report live player or avatar bounds so the preview host can detect floor, wall, or out-of-bounds issues.
  - Always available in the build iframe.
  - Reports live gameplay bounds in the same coordinate space as setPlayfield.
  - Use this for moving players or avatars so preview review and auto-fix can detect floor or wall escapes.
  - Do not report viewport-relative or screen-pixel rectangles; keep telemetry in stable game/world coordinates.
  - Example: Twinkle.preview.reportGameplayState({ playerBounds: { x: player.x, y: player.y, width: player.width, height: player.height } });
- getGameplayTelemetry() | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Read the latest preview-side gameplay telemetry snapshot.
  - Always available in the build iframe.
  - Returns the latest gameplay telemetry snapshot known to the preview host.
- clearGameplayState() | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Always available in the build iframe.
  - Clears previously reported playfield and player telemetry.
- clearReservedInsets() | scopes: none
  - Returns: { mode, viewport, stage, safeInsets, playfield }
  - Always available in the build iframe.
  - Clears previously reserved safe insets.
- subscribe(listener, { immediate } = {}) | scopes: none
  - Returns: unsubscribe()
  - Listen for host layout changes so a fixed-world game scale or canvas surface stays synced after resize, mobile viewport changes, or embedded runtime layout shifts.
  - Always available in the build iframe.
  - Subscribes to preview layout changes such as resize, host fit changes, or inset updates.
  - Use this when the app needs to keep a canvas or playfield synced with the host preview.
  - Re-apply world scale here so embedded ContentPanel and Build Studio runtime stay aligned.
  - Example: const unsubscribe = Twinkle.preview.subscribe((layout) => syncGameLayout(layout), { immediate: true });

### Twinkle.mount
- async get() | scopes: none
  - Returns: { type: 'subject', id: number } | null
  - Always available.
  - Returns the host-provided mount context, such as a subject mounted into a book app.
  - Does not fetch subject metadata, comments, or files. Use Twinkle.subjects and Twinkle.subjectComments for data reads.
- async refresh() | scopes: none
  - Returns: { type: 'subject', id: number } | null
  - Forces a fresh mount context read from the parent frame.

### Twinkle.notifications
- getLaunchTarget() | scopes: none
  - Returns: { notificationId, buildId, eventKey, eventLabel, target, payload? } | null
  - Read the current notification launch target, if the app was opened from a Build notification.
  - Always available.
  - Use target.focus for precise in-app jumping, such as focusing a sharedDb entry.
- onLaunchTarget(listener, { immediate } = {}) | scopes: none
  - Returns: unsubscribe()
  - Listen for notification launch targets while the Build app is already open.
  - Always available.
  - By default, immediately calls the listener with the current launch target when one exists. Pass { immediate: false } to only receive future targets.
  - Example: const off = Twinkle.notifications.onLaunchTarget((launchTarget) => focusEntry(launchTarget?.target?.focus?.entryId));
- async getSubscription(channelKey, { targetKey }) | scopes: notifications:read
  - Returns: { subscription }
  - Read whether the current viewer is subscribed to an app-defined notification channel target.
  - channelKey identifies the app-defined notification class, such as room.message or leaderboard.dethroned.
  - targetKey is a stable app-defined string identity, such as room:lobby, board:daily, or user:123.
  - Example: const { subscription } = await Twinkle.notifications.getSubscription('room.message', { targetKey: 'room:lobby' });
- async subscribe(channelKey, { targetKey, launchTarget }) | scopes: notifications:write
  - Returns: { subscription }
  - Subscribe the current viewer to an app-defined notification channel target.
  - launchTarget is optional app-defined JSON delivered back through Twinkle.notifications launch targets.
  - target is accepted as a backwards-compatible alias for launchTarget.
  - Example: await Twinkle.notifications.subscribe('room.message', { targetKey: 'room:lobby', launchTarget: { view: 'room', roomId: 'lobby' } });
- async subscribeMany([{ channelKey, targetKey, launchTarget }]) | scopes: notifications:write
  - Returns: { subscriptions }
  - Subscribe the current viewer to multiple app-defined notification channel targets in one request.
  - Accepts up to 100 subscriptions per request.
  - target is accepted as a backwards-compatible alias for launchTarget on each item.
  - Example: await Twinkle.notifications.subscribeMany([{ channelKey: 'room.message', targetKey: 'room:lobby', launchTarget: { view: 'room', roomId: 'lobby' } }]);
- async unsubscribe(channelKey, { targetKey }) | scopes: notifications:write
  - Returns: { subscription: null }
  - Unsubscribe the current viewer from an app-defined notification channel target.
  - Example: await Twinkle.notifications.unsubscribe('room.message', { targetKey: 'room:lobby' });
- async unsubscribeMany([{ channelKey, targetKey }]) | scopes: notifications:write
  - Returns: { subscriptions: [], removed }
  - Unsubscribe the current viewer from multiple app-defined notification channel targets in one request.
  - Accepts up to 100 subscriptions per request.
  - Example: await Twinkle.notifications.unsubscribeMany([{ channelKey: 'room.message', targetKey: 'room:lobby' }]);
- async notifySubscribers(channelKey, { targetKey, eventKey, label, summary, launchTarget, payload }) | scopes: notifications:emit
  - Returns: { sent }
  - Notify viewers who opted into an app-defined channel target, without requiring a sharedDb write.
  - Only current subscribers to the same build, channelKey, and targetKey are considered.
  - The actor is never notified about their own emit.
  - title/body are accepted as aliases for label/summary.
  - target is accepted as a backwards-compatible alias for launchTarget.
  - Twinkle applies app API rate limits, a stricter notification emit rate limit, and existing notification mutes.
  - Example: await Twinkle.notifications.notifySubscribers('room.message', { targetKey: 'room:lobby', eventKey: 'room.message.created', label: 'Room messages', summary: 'posted in Lobby', launchTarget: { view: 'room', roomId: 'lobby', messageId } });
- async getSubjectUpdateSubscription(subjectId) | scopes: notifications:read
  - Returns: { subscription }
  - Read whether the current viewer is subscribed to Build notifications for updates to a subject.
  - Returns the current viewer's subscription for this Build and subject, or null.
  - Example: const { subscription } = await Twinkle.notifications.getSubjectUpdateSubscription(subjectId);
- async subscribeToSubjectUpdates(subjectId, { target } = {}) | scopes: notifications:write
  - Returns: { subscription }
  - Subscribe the current viewer to notifications when the original subject author adds a new page or update.
  - target is app-defined JSON delivered back through Twinkle.notifications launch targets.
  - The server sends notifications from the canonical subject comment write path when the subject author adds a page.
  - Example: await Twinkle.notifications.subscribeToSubjectUpdates(subjectId, { target: { view: 'book', subjectId } });
- async unsubscribeFromSubjectUpdates(subjectId) | scopes: notifications:write
  - Returns: { subscription: null }
  - Unsubscribe the current viewer from Build notifications for a subject's new pages or updates.

### Twinkle.chess
- async bestMove({ fen, depth?, skillLevel?, maxTimeMs?, timeoutMs? }) | scopes: none
  - Returns: { success, move, bestMove, from, to, promotion, evaluation, depth, mate, error, engine }
  - Ask the parent-hosted Stockfish engine for the best move from a FEN position.
  - Always available in the build iframe.
  - Stockfish runs in a parent-managed worker with bounded depth, timeout, and serialized requests.
  - Use skillLevel 0-20 for simple difficulty selection, or depth 1-24 for explicit search depth.
  - skillLevel 20 defaults to the strongest bounded search budget.
  - maxTimeMs and timeoutMs are clamped between 500 and 60000 milliseconds.
  - This returns engine analysis only. Use app code or a chess rules library to validate legal moves, manage board state, detect game over, and render the board.
  - Example: const result = await Twinkle.chess.bestMove({ fen: game.fen(), skillLevel: 8, maxTimeMs: 1000 });
if (result.success) game.move({ from: result.from, to: result.to, promotion: result.promotion || undefined });
- async evaluate({ fen, depth?, skillLevel?, maxTimeMs?, timeoutMs? }) | scopes: none
  - Returns: { success, move, bestMove, from, to, promotion, evaluation, depth, mate, error, engine }
  - Analyze a FEN position and return Stockfish's current best move plus centipawn or mate evaluation.
  - Always available in the build iframe.
  - evaluation is the Stockfish centipawn score from the engine output when available; mate is the mate distance when Stockfish reports one.
  - Do not call this from a render loop, animation loop, or high-frequency polling path.
  - Example: const analysis = await Twinkle.chess.evaluate({ fen: game.fen(), depth: 12 });
console.log(analysis.bestMove, analysis.evaluation, analysis.mate);

### Twinkle.files
- async saveAs({ fileName, url, dataUrl, data, text, json, bytes, blob, file, mimeType } = {}) | scopes: none
  - Returns: { success, fileName, size?, mimeType?, method }
  - Download a generated or remote file to the viewer's local device through the parent frame without opening a popup.
  - Local viewer download only; does not upload to Twinkle or consume AI Energy.
  - Use this for generated blobs/data/JSON/bytes or large/remote files that need parent-frame download handling.
  - For URL downloads, cross-origin URLs must be fetchable by browser CORS or Twinkle's CDN proxy so the parent frame can create a local Blob download.
  - Simple visible same-origin images can still use normal browser anchors with href and download.
  - Example: await Twinkle.files.saveAs({ fileName: 'fashion-guide.png', dataUrl: imageUrl, mimeType: 'image/png' });
- async uploadGenerated({ fileName, url, dataUrl, data, text, json, bytes, blob, file, mimeType } = {}) | scopes: files:write
  - Returns: { assets: [{ id, buildId, fileName, originalFileName, mimeType, sizeBytes, filePath, url, thumbUrl, fileType, uploadedByUserId, createdAt }], failed?: [{ fileName, message }], canceled }
  - Upload an app-generated file to Twinkle-hosted cloud storage without opening a picker, then store the returned asset refs in sharedDb/privateDb/userDb.
  - Signed-in viewers only.
  - Uploads generated blobs, files, bytes, data URLs, or fetchable URLs to Twinkle-hosted cloud storage.
  - Video uploads are not supported right now.
  - Store the returned asset metadata in sharedDb/privateDb/userDb instead of storing raw file bytes in a DB record.
  - Example: const { assets } = await Twinkle.files.uploadGenerated({ fileName: 'fashion-guide.png', dataUrl: generatedImageUrl, mimeType: 'image/png' });
- async pickAndUpload({ accept, multiple } = {}) | scopes: files:write
  - Returns: { assets: [{ id, buildId, fileName, originalFileName, mimeType, sizeBytes, filePath, url, thumbUrl, fileType, uploadedByUserId, createdAt }], failed?: [{ fileName, message }], canceled }
  - Pick supported local files and upload them to Twinkle-hosted cloud storage, then store the returned asset refs in sharedDb/privateDb/userDb.
  - Signed-in viewers only.
  - Uploads to Twinkle-hosted cloud storage and returns asset references.
  - Video uploads are not supported right now.
  - When multiple files are selected, successful uploads are still returned even if one later file fails.
  - Store the returned asset metadata in sharedDb/privateDb/userDb instead of storing raw file bytes in a DB record.
  - Example: const { assets, canceled } = await Twinkle.files.pickAndUpload({ accept: 'image/*,.pdf', multiple: true });
- async list({ cursor, limit } = {}) | scopes: files:read
  - Returns: { assets: [{ id, buildId, fileName, originalFileName, mimeType, sizeBytes, filePath, url, thumbUrl, fileType, uploadedByUserId, createdAt }], nextCursor, usage: { totalBytes, fileCount, maxRuntimeFileStorageBytes, remainingBytes } | null }
  - List the current viewer's uploaded runtime files for this build.
  - Signed-in viewers only.
  - Lists the current viewer's ready uploads for this build only.
  - Example: const { assets, usage } = await Twinkle.files.list({ limit: 20 });
- async delete(assetId) | scopes: files:write
  - Returns: { success, deletedAssetId, usage: { totalBytes, fileCount, maxRuntimeFileStorageBytes, remainingBytes } | null }
  - Delete one of the current viewer's uploaded runtime files and free up Twinkle.files quota.
  - Signed-in viewers only.
  - Deletes one of the current viewer's uploaded runtime files and updates quota usage.
  - Example: await Twinkle.files.delete(assetId);

### Twinkle.ai
- async listPrompts() | scopes: none
  - Returns: Array<{ id, title, description }>
  - Legacy helper. Twinkle.ai.chat does not require promptId for default runtime text generation.
- async chat({ promptId, message, history, systemPrompt, requestId, onText, onStatus } = {}) | scopes: none
  - Returns: { text, response, model, aiUsagePolicy }
  - Generate text with the default Lumine text model, optionally streaming text updates through onText.
  - Signed-in viewers only.
  - Uses gpt-5.4 by default.
  - Each successful text generation consumes AI Energy from the signed-in viewer.
  - history must be an array of { role: 'user' | 'assistant', content: string }. Twinkle.ai.chat does not read a text field.
  - The server keeps the latest 12 valid history entries.
  - Pass systemPrompt to define the app AI's personality, tone, role, or response rules.
  - Pass onText to receive streaming accumulated text before the final result resolves.
  - AI Energy is recorded after provider success when final token usage is available.
  - Use this for in-app AI replies instead of creating or fetching app-local endpoints such as /api/chat.
  - Example: const chatHistory = conversation.slice(-12).map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.text }));
const result = await Twinkle.ai.chat({ message, history: chatHistory, systemPrompt: 'You are a cheerful pirate helper who answers in one sentence.', onText: (text, meta) => renderReply(text), onStatus: (status) => setThinking(status === 'thinking') });
- async generateObject({ prompt, expectedStructure, thinkingMode, mode, instructions, systemPrompt } = {}) | scopes: none
  - Returns: { object, result, model, provider, thinkingMode, requestedThinkingMode, aiUsagePolicy }
  - Generate a validated structured JSON object for app decisions, routing, grading, and game-state logic.
  - Signed-in viewers only.
  - Use this instead of asking Twinkle.ai.chat to return JSON.
  - expectedStructure must be a JSON object that describes the exact returned object shape.
  - mode is accepted as an alias for thinkingMode, and mid is accepted as an alias for medium.
  - thinkingMode low uses GPT nano and records free low-energy usage.
  - thinkingMode medium uses GPT mini and normal AI Energy while AI Energy remains.
  - thinkingMode high uses the full GPT model and high AI Energy while AI Energy remains.
  - If medium or high is requested after AI Energy is empty, the server falls back to low and returns thinkingMode: low.
  - The SDK validates shape and retries malformed JSON, but app code should still validate business-specific enum values.
  - Example: const { object } = await Twinkle.ai.generateObject({ thinkingMode: 'medium', prompt: 'Classify the player intent from: ' + playerText, expectedStructure: { action: 'string', targetCharacter: 'string', confidence: 0, shouldAskFollowUp: false } });
- onChatStatus(listener) | scopes: none
  - Returns: unsubscribe function
  - Listen to shared runtime AI chat stream events.
  - Usually prefer per-call onText/onStatus callbacks on Twinkle.ai.chat.
  - Events include requestId plus type status, text, done, or error.
- async generateImage({ prompt, referenceImageB64, previousResponseId, previousImageId, engine, quality, requestId, onStatus, timeoutMs } = {}) | scopes: none
  - Returns: { success, imageUrl, responseId, imageId, engine, quality, aiUsagePolicy } or { success: false, error, reason, code, aiUsagePolicy }
  - Generate or edit an image from a prompt and optional base64/data-URL reference image.
  - Signed-in viewers only.
  - Each successful image generation consumes AI Energy from the signed-in viewer.
  - Default engine is openai and default quality is high.
  - The SDK timeout defaults to 390000ms for image generation because high-quality image runs can exceed normal request timing.
  - Pass onStatus to receive real-time stages from the backend: prompt_ready, in_progress, generating, partial_image, completed, and error.
  - Pass requestId when you need to correlate browser logs, backend logs, and iframe status events for one generation.
  - partial_image statuses may include partialImageB64 for progressive preview UI before the final imageUrl arrives.
  - referenceImageB64 may be a raw base64 string or a data:image/...;base64 URL.
  - Example: const result = await Twinkle.ai.generateImage({ prompt: 'Create a fashion guide portrait for this face with flattering colors and outfit ideas', referenceImageB64, quality: 'high', onStatus: (status) => console.log(status.stage) });
- onImageGenerationStatus(listener) | scopes: none
  - Returns: unsubscribe function
  - Subscribe to real-time image generation status events forwarded into the build iframe.
  - The listener receives the same status payload shape as generateImage({ onStatus }).
  - Works while this build iframe has an active Twinkle.ai.generateImage request.
  - Prefer generateImage({ onStatus }) when the UI only needs status for one request.
  - Example: const unsubscribe = Twinkle.ai.onImageGenerationStatus((status) => console.log(status.stage));

### Twinkle.characters
- async chat({ character, thinkingMode, message, history, roomContext, scene, systemPrompt, instructions, includeWebsiteContext, requestId, onText, onStatus } = {}) | scopes: none
  - Returns: { text, response, character, aiUsername, thinkingMode, requestedThinkingMode, includeWebsiteContext, model, provider, aiUsagePolicy }
  - Talk to Zero or Ciel from a Build app, either as a final-response call or streaming RPG-style dialogue text with onText/onStatus.
  - Signed-in viewers only.
  - character must be zero or ciel.
  - Recommended history shape is { role: 'user' | 'assistant', content: string, speaker?: string }; content is the canonical text field.
  - The character route also accepts text or message fields for compatibility, but generated apps should use content.
  - The server keeps the latest 16 valid character history entries.
  - Pass onText/onStatus for streaming dialogue. Omit callbacks for non-streaming dialogue where the promise resolves with the final response.
  - thinkingMode low uses Lite Mode and records free low-energy usage.
  - thinkingMode medium uses normal AI Energy: Zero uses GPT mini and Ciel uses Claude Sonnet while AI Energy remains.
  - thinkingMode high uses high AI Energy: Zero uses the full GPT model and Ciel uses Claude Opus 4.8 while AI Energy remains.
  - Zero maps low/medium/high to GPT nano/GPT mini/full GPT. Ciel maps low/medium/high to Claude Haiku/Claude Sonnet/Claude Opus 4.8.
  - If medium or high is requested after AI Energy is empty, the server falls back to low and returns thinkingMode: low.
  - Pass roomContext as a short shared scene transcript so Zero and Ciel can know what happened in the same room.
  - includeWebsiteContext defaults to true. Set includeWebsiteContext: false for in-world NPC dialogue that should only use Zero/Ciel's basic character identity plus your scene/instructions.
  - Use this for real Zero/Ciel NPCs instead of pretending with Twinkle.ai.chat systemPrompt.
  - Example: const dialogueHistory = recentTurns.slice(-16).map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.text, speaker: entry.speaker }));
const result = await Twinkle.characters.chat({ character: 'zero', thinkingMode: thinkHard ? 'high' : 'medium', message: playerText, history: dialogueHistory, roomContext, scene: { location: 'classroom', nearbyCharacters: ['zero', 'ciel'] }, includeWebsiteContext: false, onText: (text) => renderDialogue(text) });
- onChatStatus(listener) | scopes: none
  - Returns: unsubscribe function
  - Listen to shared Zero/Ciel runtime chat stream events.
  - Usually prefer per-call onText/onStatus callbacks on Twinkle.characters.chat.
  - Events include requestId plus type status, text, done, or error.

### Twinkle.userDb
- async query(sql, params) | scopes: none
  - Returns: { rows, rowCount, truncated }
  - Run a SELECT against advanced private per-user SQLite. Use Twinkle.privateDb instead for simple preferences, drafts, settings, or small JSON state.
  - Advanced private storage. Prefer Twinkle.privateDb unless the data is genuinely SQL-shaped.
  - SQL is validated; SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/INDEX only.
  - Guest mode uses browser-local storage and does not sync across devices.
- async exec(sql, params) | scopes: none
  - Returns: { changes, lastInsertRowid }
  - Run a write or schema statement against advanced private per-user SQLite.
  - Use for CREATE TABLE/INDEX, INSERT, UPDATE, and DELETE statements.
  - Do not use userDb for simple key/value state; use Twinkle.privateDb for that.

### Twinkle.subjects
- async getMySubjects({ limit, cursor } = {}) | scopes: content:read
  - Returns: { subjects: [{ id, title, description, filePath, fileName, fileSize, thumbUrl, timeStamp, rootType, rootId, rewardLevel }], cursor? }
  - Returns the current viewer's own subjects, newest first.
  - Supports cursor-based pagination. Pass cursor from previous response to load more.
- async search({ query, limit, cursor } = {}) | scopes: content:read
  - Returns: { subjects: [{ id, contentType, contentId, title, description, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, rootType, rootId, rewardLevel, numComments }], cursor?, pagination: { limit, hasMore, nextCursor }, filters: { query } }
  - Search Twinkle subjects by text for subject picker UIs, book apps, scrapbooks, and galleries.
  - Searches Twinkle subjects by text so apps can let viewers choose which subject to use.
  - Returns subject ids plus rootType/rootId metadata for picker UIs. Empty queries return an empty result set.
  - Example: const { subjects } = await Twinkle.subjects.search({ query: searchText, limit: 12 });
- async getSubject(subjectId) | scopes: content:read
  - Returns: { subject: { id, title, description, filePath, fileName, fileSize, thumbUrl, secretAnswer, secretAttachment, timeStamp, userId, username, profilePicUrl, rootType, rootId, rewardLevel } }
  - Returns full detail for a single subject, including uploader info and attachments.
  - Any subject can be fetched (not limited to viewer's own).
- async getSubjectComments(subjectId, { limit, cursor } = {}) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp }], cursor? }
  - Returns only the current viewer's own comments on the given subject.
  - Supports cursor-based pagination. Pass cursor from previous response to load more.

### Twinkle.aiCards
- async list({ limit, cursor, level, minLevel, maxLevel, quality, userId, hasImage, hasExample } = {}) | scopes: content:read
  - Returns: { cards: [{ id, contentType, contentId, word, text, exampleText, prompt, level, wordLevel, quality, style, imagePath, imageUrl, isMysteryCard, isImageGenerating, creatorId, ownerId, username, profilePicUrl, timeStamp, lastInteraction }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - List existing public AI Cards newest first, including each card word, example sentence text, word level, and quality.
  - Use card.word for word typing modes and card.exampleText for sentence typing modes.
  - Filter by level/minLevel/maxLevel to match game difficulty to AI Card word level.
  - Mystery/unrevealed cards return style as ??? and omit imagePath/imageUrl until the card image is available.
  - Example: const { cards } = await Twinkle.aiCards.list({ level: 2, hasExample: true, limit: 20 });
- async search({ query, limit, cursor, level, minLevel, maxLevel, quality, userId, hasImage, hasExample } = {}) | scopes: content:read
  - Returns: { cards: [{ id, contentType, contentId, word, text, exampleText, prompt, level, wordLevel, quality, style, imagePath, imageUrl, isMysteryCard, isImageGenerating, creatorId, ownerId, username, profilePicUrl, timeStamp, lastInteraction }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - Search existing public AI Cards by word, with optional level and quality filters.
  - Search matches AI Card words; use list(...) for broad level-based typing pools.
  - This namespace is read-only and does not summon, trade, sell, burn, or mutate AI Cards.
  - Mystery/unrevealed cards return style as ??? and omit imagePath/imageUrl until the card image is available.
  - Example: const { cards } = await Twinkle.aiCards.search({ query: searchText, minLevel: 1, maxLevel: 3, hasExample: true, limit: 12 });
- async get(cardId) | scopes: content:read
  - Returns: { card: { id, contentType, contentId, word, text, exampleText, prompt, level, wordLevel, quality, style, imagePath, imageUrl, isMysteryCard, isImageGenerating, creatorId, ownerId, username, profilePicUrl, timeStamp, lastInteraction } }
  - Fetch one existing public AI Card by id, including word, example text, and level metadata.
  - Fetches one live, unburned AI Card by id.
  - This namespace is read-only and does not expose market or ownership actions.
  - Mystery/unrevealed cards return style as ??? and omit imagePath/imageUrl until the card image is available.
  - Example: const { card } = await Twinkle.aiCards.get(cardId);

### Twinkle.aiStories
- async list({ limit, cursor, order, difficulty, type, topicKey, storyBy, isListening, userId, hasImage, hasQuestions } = {}) | scopes: content:read
  - Returns: { stories: [{ id, contentType, contentId, topic, topicKey, type, storyBy, story, explanation, difficulty, isListening, imagePath, imageUrl, audioPath, audioUrl, questions, questionsBy, hasImage, hasQuestions, userId, username, profilePicUrl, timeStamp }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - List completed existing user-generated AI Stories, optionally filtered by exact level/type/topicKey book, by storyBy (the generating model, i.e. the story's author), and ordered newest or oldest first.
  - Lists completed existing AI Stories newest first by default; order:'oldest' is allowed only with difficulty, type, and topicKey for chronological book pages.
  - Use difficulty with type and topicKey to load one exact AI Story book without scanning the full corpus in the iframe.
  - Filter with hasImage or hasQuestions when building visual galleries or quiz apps.
  - Example: const { stories } = await Twinkle.aiStories.list({ difficulty: 1, type: 'science', topicKey: 'Astronomy', order: 'oldest', limit: 20 });
- async chapters({ limit, cursor, groupBy, difficulty, type, topicKey, storyBy, isListening, userId, hasImage, hasQuestions } = {}) | scopes: content:read
  - Returns: Default (groupBy:'topicKey'): { chapters: [{ difficulty, type, topicKey, title, sampleTopic, storyCount, readingCount, listeningCount, imageCount, questionCount, latestStoryId, latestTimeStamp }], cursor?, pagination, filters }. groupBy:'type': { books: [{ difficulty, type, title, sampleTopic, chapterCount, storyCount, readingCount, listeningCount, imageCount, questionCount, latestStoryId, latestTimeStamp }], ... } — one row per (level, topic) book. groupBy:'author': { authors: [{ storyBy, title, bookCount, chapterCount, storyCount, minDifficulty, maxDifficulty, latestStoryId }], ... } — one row per generating model (the story's author); an index-only landing, so it omits media counts (use a scoped books/chapters call for those).
  - List the AI Story library index. Default groups by (level, type, topicKey) for per-subtopic chapter rows. groupBy:'type' returns one row per (level, topic) book; groupBy:'author' returns one row per generating model (storyBy = the author) — a tiny top-level set. Filter by storyBy to scope books/chapters/stories to one author, and by difficulty/type to scope further. Counts and navigation metadata only, no story bodies.
  - groupBy:'author' returns one row per generating model under an authors key (the library's authors); groupBy:'type' returns (level, topic) books under a books key; default groupBy:'topicKey' returns per-subtopic chapter rows under a chapters key.
  - storyBy is the generating model id (e.g. 'gpt-5.1', 'gpt-4o') and acts as the story's author. Pass a single id, or an array of ids to scope to a model family (e.g. fold gpt-4o snapshots into one author). Scopes books, chapters, and stories.
  - Returns book/chapter metadata only; use Twinkle.aiStories.list({ difficulty, type, topicKey, storyBy, order:'oldest', cursor }) to load story pages inside a book.
  - Use cursor pagination for large chapter indexes instead of loading every story record.
  - Example: const { authors } = await Twinkle.aiStories.chapters({ groupBy: 'author' });
- async search({ query, limit, cursor, order, difficulty, type, topicKey, storyBy, isListening, userId, hasImage, hasQuestions } = {}) | scopes: content:read
  - Returns: { stories: [{ id, contentType, contentId, topic, topicKey, type, story, explanation, difficulty, isListening, imagePath, imageUrl, audioPath, audioUrl, questions, questionsBy, hasImage, hasQuestions, userId, username, profilePicUrl, timeStamp }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - Search completed existing user-generated AI Stories by topic or story text, optionally within an exact level/type/topicKey book.
  - Searches completed existing AI Stories by topic/story text.
  - Use difficulty, type, and topicKey to search within one book of the AI Story corpus; order:'oldest' is rejected without all three filters.
  - Returned questions are normalized to an array even when stored as JSON text.
  - Example: const { stories } = await Twinkle.aiStories.search({ query: searchText, difficulty: 2, type: 'history', topicKey: 'Ancient Rome', order: 'oldest', limit: 12 });
- async get(storyId) | scopes: content:read
  - Returns: { story: { id, contentType, contentId, topic, topicKey, type, story, explanation, difficulty, isListening, imagePath, imageUrl, audioPath, audioUrl, questions, questionsBy, hasImage, hasQuestions, userId, username, profilePicUrl, timeStamp } }
  - Fetch one completed existing AI Story by id, including story text for passage typing, media URLs, and normalized questions when available.
  - Fetches one completed existing AI Story by id.
  - This namespace is read-only and does not generate new AI Stories.
  - Example: const { story } = await Twinkle.aiStories.get(storyId);

### Twinkle.grammarbles
- async listQuestions({ level, limit, cursor } = {}) | scopes: content:read
  - Returns: { questions: [{ id, level, rating, question, choices, answerIndex, correctChoice, correctChoiceKey, isChecked, explanation }], cursor?, pagination: { level, limit, hasMore, nextCursor } }
  - Read public Grammarbles questions and answers by level with rating/id cursor pagination.
  - Questions are public Grammarbles training data and include the canonical answer.
  - level is clamped from 1 through 5.
  - Pagination is stable by rating then id. Pass cursor from the previous response to load more questions in the same level.
  - This method does not expose daily attempt state, XP, coins, or daily-task progression.
  - Example: const page = await Twinkle.grammarbles.listQuestions({ level: 3, limit: 100 }); const question = page.questions[Math.floor(Math.random() * page.questions.length)];
- async getMyQuestionHistory({ level, limit, cursor } = {}) | scopes: content:read
  - Returns: { attempts: [{ id, questionId, level, grade, gradeRank, isCorrect, attemptNumber, timeStamp }], cursor?, pagination: { level, limit, hasMore, nextCursor } }
  - Read the signed-in viewer's real Grammarbles attempt rows for trainer filtering.
  - Returns real Grammarbles attempt outcome rows for the signed-in viewer, newest first.
  - History rows intentionally omit choice indexes because real Grammarbles choices are shuffled per run and the per-run shuffle order is not persisted.
  - Use Twinkle.grammarbles.listQuestions for canonical question text, choices, and answers.
  - Use app-private history in Twinkle.privateDb for trainer-only results, and combine it with this method only when the viewer chooses to include real Grammarbles history.
  - This method is read-only and does not submit, cancel, or mutate daily Grammarbles attempts.
  - Example: const history = await Twinkle.grammarbles.getMyQuestionHistory({ level: selectedLevel, limit: 500 }); const answeredIds = new Set(history.attempts.map((attempt) => attempt.questionId));

### Twinkle.subjectComments
- async list(subjectId, { limit, cursor, sortBy, includeReplies, author, authorUserId, replyScope } = {}) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, commentId, replyId }], cursor?, pagination: { limit, hasMore, nextCursor }, filters: { subjectId, sortBy, includeReplies, author, replyScope, authorUserId } }
  - Read a subject's comment stream with stable keyset pagination, oldest/newest ordering, author filters, and optional same-author reply scoping.
  - Use for subject-wide comment streams. Twinkle.subjects.getSubjectComments is the legacy viewer-own-comments helper.
  - sortBy accepts newest or oldest.
  - author accepts all, viewer, or subjectPoster. Pass authorUserId for an explicit user filter.
  - includeReplies defaults to false so book/page apps read top-level subject comments unless they opt into replies.
  - replyScope accepts all or ownThread and defaults to all.
  - With includeReplies: true and a single-author filter, replyScope: ownThread keeps that author's top-level comments and only includes that author's replies when the direct or nested reply target is also authored by that author.
  - For subject-poster books that include poster replies, use author: subjectPoster, includeReplies: true, and replyScope: ownThread so the poster's replies to other people do not become pages.
  - Supports cursor-based pagination. Pass cursor from the previous response to load more.
  - Example: const { subjects } = await Twinkle.subjects.search({ query: searchText, limit: 12 }); const subjectId = pickedSubject.id; const page = await Twinkle.subjectComments.list(subjectId, { sortBy: 'oldest', author: 'subjectPoster', includeReplies: true, replyScope: 'ownThread', limit: 50 });

### Twinkle.profileComments
- async getProfileComments({ profileUserId, limit, offset, sortBy, includeReplies, range, since, until } = {}) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, likes, replies, commentId, replyId }], pagination: { limit, offset, hasMore, nextOffset }, filters: { profileUserId, sortBy, includeReplies, since, until } }
  - Reads profile-page comments (rootType='user'). Defaults to current viewer's profile if profileUserId is not provided.
  - Use sortBy: newest | oldest.
  - Set range:'today' for today-only filters, or pass since/until Unix timestamps.
- async getProfileCommentIds({ profileUserId, limit, offset, sortBy, includeReplies, range, since, until } = {}) | scopes: content:read
  - Returns: { ids: number[], pagination: { limit, offset, hasMore, nextOffset }, filters: { profileUserId, sortBy, includeReplies, since, until } }
  - Atomic step 1: fetches only matching profile comment IDs with stable pagination.
  - Use this when you want custom pipelines such as fetching IDs first, then selective hydration/counts.
- async getCommentsByIds(idsOrOpts) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, commentId, replyId }] }
  - Atomic step 2: fetches comment records for provided IDs.
  - Accepts either an array of IDs or an object like { ids: [...] }.
- async getProfileCommentCounts(idsOrOpts) | scopes: content:read
  - Returns: { countsById: { [commentId]: { likes, replies } } }
  - Atomic step 3: fetches likes/replies aggregates for provided IDs.
  - Accepts either an array of IDs or an object like { ids: [...] }.

### Twinkle.leaderboards
- async get({ boardKey = 'default', limit, cursor } = {}) | scopes: none
  - Returns: { entries: [{ rank, id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt }], scores, cursor, hasMore, personalBest: { id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt } | null }
  - Read score-sorted personal-best leaderboard rows for this Build app.
  - Works for signed-in viewers and public-build guests.
  - Results are sorted by score descending, then earliest achieved time.
  - limit defaults to 20 and maxes at 100.
  - Use cursor from the previous response to load more rows.
  - personalBest is included when the current signed-in viewer or guest session has a row.
- async submit({ boardKey = 'default', score, displayName, meta } = {}) | scopes: none
  - Returns: { entry: { id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt } | null, personalBest: { id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt } | null, improved, previousScore }
  - Submit a score to a public Build leaderboard using server-owned viewer identity.
  - score is required and must be an integer from 0 through 1000000000000.
  - Signed-in viewers are identified by their Twinkle user id and display under their Twinkle username; do not pass a custom displayName for them.
  - Guests must pass displayName. Ask once and keep it in app state for later submits.
  - Submit only after computing the final score when a run, shift, match, or level attempt ends; do not submit every frame or every tick.
  - Only improved personal-best scores replace the existing score row.
  - meta is optional JSON object data, max 2 KB.

### Twinkle.sharedDb
- async getTopics() | scopes: sharedDb:read
  - Returns: { topics: [{ id, name, createdBy, createdAt }] }
  - Lists all topics for this build.
- async createTopic(name) | scopes: sharedDb:write
  - Returns: { topic: { id, name, createdBy, createdAt } }
  - Creates a topic or returns the existing one if name already exists.
  - Name max 100 characters.
- async getEntries(topicName, { limit, pageSize, cursor, order, sort, direction } = {}) | scopes: sharedDb:read
  - Returns: { entries: [{ id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt }], cursor?, hasMore }
  - Read shared topic rows with cursor pagination.
  - Returns entries from a topic, newest first by default.
  - Use limit or pageSize to choose how many entries to fetch per page. Default is 20, max is 100.
  - For oldest-first chronological reads, pass order: 'asc' or order: 'oldest'. sort and direction are accepted as aliases.
  - Supports cursor-based pagination. Newest-first cursors page toward older entries; oldest-first cursors page toward newer entries.
- async loadMoreEntries(topicName, { limit, pageSize, cursor, order, sort, direction } = {}) | scopes: sharedDb:read
  - Returns: { entries: [{ id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt }], cursor?, hasMore }
  - Fetch the next sharedDb page.
  - Convenience alias for getEntries used by Load more buttons.
  - Pass the previous response cursor to fetch the next page using the same order and page size.
- async addEntry(topicName, data, { notify } = {}) | scopes: sharedDb:write
  - Returns: { entry: { id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt } }
  - Append a shared JSON row, optionally creating a Twinkle notification from the canonical write.
  - Adds a JSON object entry to a topic. Auto-creates the topic if it doesn't exist.
  - data must be a JSON object, max 10 KB.
  - notify may include eventKey, label, summary, recipients, and target. Supported recipients start with { kind: 'buildOwner' }.
  - Use target.focus, such as { kind: 'sharedDbEntry', entryId: '$createdEntryId' }, so Twinkle.notifications can focus the item when opened.
  - Use Twinkle.leaderboards for standard top-score rankings and personal-best scoreboards.
- async updateEntry(entryId, data, { notify } = {}) | scopes: sharedDb:write
  - Returns: { entry: { id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt } }
  - Update a viewer-owned shared row, optionally notifying safe recipients from the canonical write.
  - Updates an entry. Only the entry creator or the build owner can update.
  - data must be a JSON object, max 10 KB.
  - notify may include eventKey, label, summary, recipients, and target. Supported recipients include { kind: 'sharedDbEntryAuthor', entryId }.
- async deleteEntry(entryId) | scopes: sharedDb:write
  - Returns: { success: true }
  - Deletes an entry. Only the entry creator or the build owner can delete.
- async kv.get(namespace, key) | scopes: sharedDb:read
  - Returns: { item: { id, key, value, version, changeSeq, deleted, updatedBy, createdAt, updatedAt } | null }
  - Read one key from the keyed shared store (shared mutable state). Deleted keys read as null.
  - Reads one key from the keyed shared store. Deleted keys read as null.
  - Example: const { item } = await Twinkle.sharedDb.kv.get('world', 'block:10:4');
- async kv.list(namespace, { limit, cursor, since } = {}) | scopes: sharedDb:read
  - Returns: { items: [{ id, key, value, version, changeSeq, deleted, updatedBy, createdAt, updatedAt }], cursor?, hasMore }
  - List keys in a namespace ordered by changeSeq for incremental sync of shared mutable state; pass since = highest changeSeq already seen to fetch only changed keys (including removals as deleted: true).
  - Lists keys in a namespace ordered by changeSeq (a monotonic write counter). For incremental sync, pass the returned cursor or since = highest changeSeq already seen; incremental results include removed keys with deleted: true (drop them locally). Full scans (no cursor/since) exclude deleted keys.
  - Example: const { items } = await Twinkle.sharedDb.kv.list('world', { since: lastChangeSeq });
- async kv.set(namespace, key, value) | scopes: sharedDb:write
  - Returns: { item: { id, key, value, version, changeSeq, deleted, updatedBy, createdAt, updatedAt } }
  - Upsert one key of shared mutable state with server-side last-write-wins. Preferred for shared world/block/grid/game state instead of append-only entry logs with client-side compaction.
  - Upserts one key with server-side last-write-wins. Any viewer with write scope may overwrite, so use kv for shared mutable state (world/block/game state) instead of append-only entry logs with client-side compaction.
  - Example: await Twinkle.sharedDb.kv.set('world', 'block:10:4', { color: 'red' });
- async kv.setMany(namespace, items) | scopes: sharedDb:write
  - Returns: { items: [{ id, key, value, version, changeSeq, deleted, updatedBy, createdAt, updatedAt }] }
  - Atomically upsert up to 100 { key, value } items of shared mutable state in one request (batch write).
  - Upserts up to 100 { key, value } items atomically in one request.
  - Example: await Twinkle.sharedDb.kv.setMany('world', [{ key: 'block:1:1', value: { color: 'red' } }, { key: 'block:1:2', value: { color: 'blue' } }]);
- async kv.remove(namespace, key) | scopes: sharedDb:write
  - Returns: { success: true, deleted: boolean }
  - Remove a key of shared mutable state, tombstoning it so kv.list incremental sync observes the removal.
  - Tombstones the key so kv.list incremental sync can observe the removal.
  - Example: await Twinkle.sharedDb.kv.remove('world', 'block:10:4');

### Twinkle.chat
- async listRooms() | scopes: chat:read
  - Returns: { rooms: [{ id, buildId, key, name, createdByUserId, createdAt, updatedAt }] }
  - Returns chat rooms created by this Build app.
- async createRoom({ roomKey, name }) | scopes: chat:write
  - Returns: { room: { id, buildId, key, name, createdByUserId, createdAt, updatedAt } }
  - Creates a room or returns the existing one.
  - roomKey may include letters, numbers, '.', '_', ':', and '-'.
- async listMessages(roomKey, { cursor, limit } = {}) | scopes: chat:read
  - Returns: { messages: [{ id, roomId, roomKey, userId, username, profilePicUrl, role, status, text, metadata, clientMessageId, createdAt, updatedAt }], cursor? }
  - Returns messages in chronological order.
  - Use the returned cursor to fetch older messages.
- async sendMessage(roomKey, textOrOptions, options) | scopes: chat:write
  - Returns: { message: { id, buildId, roomId, roomKey, userId, username, profilePicUrl, role, status, text, metadata, clientMessageId, createdAt, updatedAt }, room: { id, buildId, key, name, createdByUserId, createdAt, updatedAt }, created }
  - Accepts sendMessage('lobby', 'hi') or sendMessage('lobby', { text, metadata, clientMessageId }).
  - Pass clientMessageId when manually retrying a send; the SDK also includes one per send request.
- async deleteMessage(messageId) | scopes: chat:write
  - Returns: { success: true, messageId }
  - A viewer can delete their own messages; the build owner can delete any message in the build.
- subscribe(roomKey, listener) | scopes: chat:read
  - Returns: unsubscribe function
  - listener receives realtime events like { type: 'message.created', roomKey, message }.
  - Call the returned function to unsubscribe.

### Twinkle.world
- async join({ worldKey = 'default', roomKey = 'main', instanceId = 'main', presence, player } = {}) | scopes: none
  - Returns: { sessionId, session, room, players, snapshot, subscribe(listener), updatePresence(patch), send(actionOrType, data), leave() }
  - Join a realtime Build world room and receive a snapshot plus a session handle for presence updates, actions, and room events.
  - Always available in the build iframe.
  - World state is ephemeral and heartbeat/TTL based. Use sharedDb/privateDb for durable inventory, XP, quests, ownership, and saved progress — but write those LOW-frequency only (on a user action or an occasional snapshot, never per frame/tick); per-frame/live state stays in world presence or client memory. The server rate-limits sharedDb/privateDb writes and returns 429.
  - Events are room-scoped and include serverTime, seq, eventId, schemaVersion, sessionId, player, and room metadata.
  - Subscribe to session.ended and catch updatePresence/send errors. Stop using stale handles and reconnect only when Twinkle.world.isSessionEndedError(error) is true; for other Twinkle.world.isRecoverableSessionError(error) cases, drop the transient presence/action and keep the handle.
  - Use updatePresence for live avatar snapshots and send for lightweight actions such as emotes, interactions, and chat bubbles.
  - Throttle movement updates in app code, usually 5-15 updates per second. Do not call updatePresence from every animation frame.
  - Rooms are addressed by worldKey, roomKey, and instanceId so the contract can later move to sharded or dedicated game backends.
  - Example: const world = await Twinkle.world.join({ roomKey: 'town-square', presence: { x: 0, y: 0, z: 0, facing: 'south' }, player: { name: avatarName } });
world.subscribe((event) => updateRemotePlayers(event.players));
world.updatePresence({ x, y, z, facing });
- isRecoverableSessionError(error) | scopes: none
  - Returns: boolean
  - Return true when a world request error is expected to be handled by app code instead of crashing.
  - Recoverable session errors include ended, missing, socket-disconnected, socket-not-ready, room-missing, preview-updating, and timed-out world session requests.
  - Only session-ended errors prove that the current handle should be discarded. Timed-out or preview-updating presence requests can be dropped without reconnecting.
  - For durable game state, write through sharedDb/privateDb instead of relying on world presence — but LOW-frequency only (on a user action or an occasional snapshot, never per frame/tick).
  - Example: try {
  await world.updatePresence({ x, y, z, facing });
} catch (error) {
  if (Twinkle.world.isSessionEndedError(error)) {
    world = null;
    scheduleReconnect();
  } else if (Twinkle.world.isRecoverableSessionError(error)) {
    // Drop this transient presence update and keep the current handle.
  } else {
    throw error;
  }
}
- isSessionEndedError(error) | scopes: none
  - Returns: boolean
  - Return true when a world request error means the current session handle is stale and app code should reconnect with a fresh Twinkle.world.join call.
  - Session-ended errors include ended, missing, room-missing, and socket-disconnected world session failures.
  - Request timeouts and preview-updating skips are recoverable but not session-ended.
  - Example: if (Twinkle.world.isSessionEndedError(error)) {
  world = null;
  scheduleReconnect();
}
- leaveAll() | scopes: none
  - Returns: void
  - Leave every active world session in the current iframe.
  - The SDK also leaves active sessions on pagehide/beforeunload when possible.
  - Use this when switching maps or resetting a multiplayer game.

### Twinkle.users
- async getUser(userId) | scopes: user:read
  - Returns: { id, username, profilePicUrl, realName } | null
- async getUsers({ search, userIds, cursor, limit } = {}) | scopes: users:read
  - Returns: { users: [{ id, username, profilePicUrl, realName }], cursor? }
  - Prefer explicit userIds when possible.
  - Search is prefix-based and requires at least 2 characters.
  - Use search sparingly and with small limits.

### Twinkle.reflections
- async getDailyReflections({ userIds, cursor, lastId, limit } = {}) | scopes: dailyReflections:read
  - Returns: { reflections: [{ id, userId, response, questionId, submittedAt, sharedAt, username, profilePicUrl, question }], cursor? }
  - Read only currently public Daily Reflection shares. response is the exact text the author chose to share publicly, never an unshared raw/private answer.
  - Daily reflections are Daily Question answers shown in the Twinkle feed.
  - Only currently shared public reflections are returned. The response field is the stored shared response version, which may be raw or polished depending on what the author explicitly shared.
  - submittedAt and sharedAt are Unix timestamps (seconds). Use new Date(value * 1000) to convert to JS Date.
- async getDailyReflectionsByUser(userId, { cursor, lastId, limit } = {}) | scopes: dailyReflections:read
  - Returns: { reflections: [{ id, userId, response, questionId, submittedAt, sharedAt, username, profilePicUrl, question }], cursor? }
  - Read one user's currently public Daily Reflection shares. response is the exact text the author chose to share publicly, never an unshared raw/private answer.
  - Daily reflections are Daily Question answers shown in the Twinkle feed.
  - Only currently shared public reflections are returned. The response field is the stored shared response version, which may be raw or polished depending on what the author explicitly shared.
  - submittedAt and sharedAt are Unix timestamps (seconds). Use new Date(value * 1000) to convert to JS Date.

### Twinkle.privateDb
- async get(key) | scopes: privateDb:read
  - Returns: { item: { id, key, value, updatedAt } | null }
  - Read one key from the default private per-user JSON store.
  - Reads a single key from the current viewer's private store.
- async list({ prefix, limit, cursor } = {}) | scopes: privateDb:read
  - Returns: { items: [{ id, key, value, updatedAt }], cursor? }
  - List keys from the default private per-user JSON store.
  - Lists private keys for the current viewer. Supports prefix filter and cursor pagination.
- async set(key, value) | scopes: privateDb:write
  - Returns: { item: { id, key, value, updatedAt } }
  - Upsert one JSON-serializable value in the default private per-user store.
  - Upserts one key for the current viewer. Value must be JSON-serializable (max 16 KB).
- async remove(key) | scopes: privateDb:write
  - Returns: { success: true, deleted: boolean }
  - Delete one key from the default private per-user JSON store.
  - Deletes one key for the current viewer.

### Twinkle.reminders
- async list({ includeDisabled, limit } = {}) | scopes: reminders:read
  - Returns: { reminders: [{ id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt }] }
  - Lists reminder rules for the current signed-in viewer.
  - includeDisabled includes turned-off reminders in the result.
- async create({ title, body, targetPath, payload, schedule, isEnabled }) | scopes: reminders:write
  - Returns: { reminder: { id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt } | null }
  - Creates one reminder rule for the current signed-in viewer.
  - schedule.type supports once, daily, and weekly.
- async update(reminderId, patch) | scopes: reminders:write
  - Returns: { reminder: { id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt } | null }
  - Updates one reminder rule for the current signed-in viewer.
- async remove(reminderId) | scopes: reminders:write
  - Returns: { success: true, deleted: boolean }
  - Deletes one reminder rule for the current signed-in viewer.
- async getDue({ now, autoAcknowledge, limit } = {}) | scopes: reminders:read
  - Returns: { now, reminders: [{ id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt }] }
  - Returns reminders that are due right now for the current signed-in viewer.
  - autoAcknowledge defaults to true and prevents the same reminder from retriggering immediately.

## Examples

### Daily reflection feed

```js
const feed = await Twinkle.reflections.getDailyReflections({ limit: 20 });
```

### Advanced per-user SQLite
Use Twinkle.userDb only when the app needs private relational tables, indexes, filtered queries, or aggregates. Use Twinkle.privateDb for simple settings and small JSON state.
Keywords: sqlite, userDb, advanced private data, relational, tables, indexes

```js
await Twinkle.userDb.exec('CREATE TABLE IF NOT EXISTS follows (userId INT PRIMARY KEY, followedAt INTEGER)');
```

### List my subjects

```js
const { subjects } = await Twinkle.subjects.getMySubjects({ limit: 10 });
subjects.forEach(s => console.log(s.id, s.title));
```

### Search subjects for a picker
Use this when the app should ask the viewer which Twinkle subject to turn into a book, scrapbook, or gallery.
Keywords: subject, search, picker, book, mount

```js
const { subjects } = await Twinkle.subjects.search({ query: searchText, limit: 12 });
// Let the viewer pick one, then use picked.id with getSubject and subjectComments.list.
```

### Build a book from a subject
Ask the viewer to choose a subject with Twinkle.subjects.search, optionally preselecting Twinkle.mount.get() when the host provides a subject. Then fetch metadata and read the subject comment stream oldest-first. Filter to author:'subjectPoster' when only the poster's comments should become pages, and use replyScope:'ownThread' when including poster replies.
Keywords: subject, comments, book, pages, search, picker, mount, subject poster

```js
const mount = await Twinkle.mount.get();
const initialSubjectId = mount?.type === 'subject' ? mount.id : null;
const { subjects } = initialSubjectId
  ? { subjects: [] }
  : await Twinkle.subjects.search({ query: searchText, limit: 12 });
const subjectId = initialSubjectId || pickedSubject.id;
const { subject } = await Twinkle.subjects.getSubject(subjectId);
const { comments, pagination } = await Twinkle.subjectComments.list(subjectId, {
  sortBy: 'oldest',
  author: 'subjectPoster',
  includeReplies: true,
  replyScope: 'ownThread',
  limit: 50
});
console.log('Title:', subject.title, 'Pages:', comments.length, 'hasMore:', pagination?.hasMore);
```

### Typing game content from AI Cards and AI Stories
Use AI Card words for word mode, AI Card exampleText for sentence mode, and AI Story story text for passage mode. Keep leaderboards separate per mode.
Keywords: typing, ai cards, ai stories, words, sentences, passages, leaderboard

```js
const wordPage = await Twinkle.aiCards.list({ level: 1, hasExample: true, limit: 20 });
const wordTargets = wordPage.cards.map((card) => ({
  text: card.word,
  level: card.level,
  sourceId: card.id
}));
const sentenceTargets = wordPage.cards.map((card) => ({
  text: card.exampleText,
  level: card.level,
  sourceId: card.id
}));

const passagePage = await Twinkle.aiStories.list({ difficulty: 2, limit: 10 });
const passageTargets = passagePage.stories.map((story) => ({
  text: story.story,
  level: story.difficulty,
  sourceId: story.id
}));

await Twinkle.leaderboards.submit({
  boardKey: 'arcade-typing-words',
  score: finalScore,
  meta: { mode: 'words', level }
});
```

### Search AI Stories for a quiz app
Use existing user-generated AI Stories as source material for visual galleries, readers, and question-based games.
Keywords: ai stories, story, quiz, questions, image, gallery

```js
const { stories } = await Twinkle.aiStories.search({
  query: searchText,
  hasQuestions: true,
  hasImage: true,
  limit: 12
});
const picked = stories[0];
console.log(picked.topic, picked.imageUrl, picked.questions.length);
```

### Recent profile comments

```js
const { comments, pagination } = await Twinkle.profileComments.getProfileComments({
  sortBy: 'newest',
  includeReplies: true,
  limit: 20
});
console.log('Loaded comments:', comments.length, 'hasMore:', pagination?.hasMore);
```

### Build leaderboard
Submit personal-best scores for signed-in viewers and guests, then read score-sorted rankings.
Keywords: leaderboard, leaderboards, scoreboard, scores, rankings, personal best, guest scores

```js
const boardKey = 'main';
const finalScore = computeFinalScoreForFinishedRun();
const viewer = await Twinkle.viewer.get();
const guestName = savedGuestName || readGuestNameFromInput();
if (viewer.isGuest && !guestName) {
  showGuestNameForm();
  return;
}

await Twinkle.leaderboards.submit({
  boardKey,
  score: finalScore,
  displayName: viewer.isGuest ? guestName : undefined,
  meta: { mode: 'classic' }
});

const page = await Twinkle.leaderboards.get({ boardKey, limit: 10 });
renderLeaderboard(page.entries, page.personalBest);
```

### Paginated shared feed

```js
const pageSize = 12;
let nextCursor = null;

async function loadFirstPage() {
  const page = await Twinkle.sharedDb.getEntries('posts', { pageSize });
  nextCursor = page.cursor;
  renderPosts(page.entries, { append: false, hasMore: page.hasMore });
}

async function loadMorePosts() {
  if (!nextCursor) return;
  const page = await Twinkle.sharedDb.loadMoreEntries('posts', { pageSize, cursor: nextCursor });
  nextCursor = page.cursor;
  renderPosts(page.entries, { append: true, hasMore: page.hasMore });
}
```

### Update a shared entry

```js
const { entry } = await Twinkle.sharedDb.updateEntry(entryId, { name: 'Alice', score: 99 });
console.log('Updated:', entry.data);
```

### Store private user settings
Default private per-user key/value storage for preferences, drafts, settings, and small JSON state.
Keywords: storage, private storage, privateDb, settings, preferences, drafts, small JSON

```js
await Twinkle.privateDb.set('prefs.theme', { mode: 'mint' });
const { item } = await Twinkle.privateDb.get('prefs.theme');
console.log('Theme:', item?.value?.mode);
```

### Build a lobby chat

```js
await Twinkle.chat.createRoom({ roomKey: 'lobby', name: 'Lobby' });
const unsubscribe = Twinkle.chat.subscribe('lobby', (event) => console.log('chat event', event));
await Twinkle.chat.sendMessage('lobby', 'hello');
```

### Realtime MMO town room
Use Twinkle.world for live avatar presence and lightweight room actions, recover stale session handles, and keep durable state like inventory and quests in sharedDb/privateDb — written low-frequency (never per frame/tick).
Keywords: multiplayer, mmo, town, presence, avatars, movement, three.js, realtime

```js
let world = null;
let reconnectTimer = 0;

async function connectWorld() {
  if (world) return world;
  world = await Twinkle.world.join({
    worldKey: 'town',
    roomKey: 'square',
    presence: { x: 0, y: 0, z: 0, facing: 'south', animation: 'idle' },
    player: { name: avatarName }
  });

  world.subscribe((event) => {
    renderPlayers(event.players);
    if (event.type === 'session.ended') {
      handleWorldDrop();
    }
    if (event.type === 'action.received' && event.action?.type === 'emote') {
      showEmote(event.sessionId, event.action.data.emote);
    }
  });
  return world;
}

function handleWorldDrop() {
  world = null;
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      connectWorld().catch(handleWorldDrop);
    }, 1000);
  }
}

async function syncPresence() {
  try {
    const session = await connectWorld();
    // Throttle this in the game loop, for example 5-15 times per second.
    await session.updatePresence({ x: player.x, y: player.y, z: player.z, facing });
  } catch (error) {
    if (Twinkle.world.isSessionEndedError(error)) {
      handleWorldDrop();
      return;
    }
    if (Twinkle.world.isRecoverableSessionError(error)) {
      // Drop this transient presence update and keep the current handle.
      return;
    }
    throw error;
  }
}

await connectWorld();
await syncPresence();
```

### Play chess against the computer
Use the parent-managed Stockfish helper for the computer move while app code owns the board, legal moves, and game-over state.
Keywords: chess, stockfish, computer opponent, board game, fen

```js
const result = await Twinkle.chess.bestMove({ fen: game.fen(), skillLevel: 7, maxTimeMs: 1000 });
if (result.success) {
  game.move({ from: result.from, to: result.to, promotion: result.promotion || undefined });
  renderBoard(game);
}

const strongest = await Twinkle.chess.bestMove({ fen: game.fen(), skillLevel: 20, maxTimeMs: 60000 });
```

### Upload files and store shared metadata

```js
const { assets, canceled } = await Twinkle.files.pickAndUpload({ accept: 'image/*,.pdf', multiple: true });
if (!canceled) {
  for (const asset of assets) {
    await Twinkle.sharedDb.addEntry('uploads', { assetId: asset.id, url: asset.url, thumbUrl: asset.thumbUrl, fileName: asset.fileName, mimeType: asset.mimeType });
  }
}
```

### List and remove uploaded files

```js
const { assets, usage } = await Twinkle.files.list({ limit: 20 });
if (assets[0]) {
  await Twinkle.files.delete(assets[0].id);
}
console.log('Remaining quota bytes:', usage?.remainingBytes);
```

### Create a daily focus reminder

```js
await Twinkle.reminders.create({
  title: 'Pick your top 3',
  body: 'Choose your focus tasks for today.',
  schedule: { type: 'daily', timeZone: 'America/Los_Angeles', hour: 9, minute: 0 },
  targetPath: '/focus'
});
```
