# Build SDK Index

Version: 1.26.2
Updated: 2026-06-09
Generated: 2026-06-09T01:00:18.637Z

## Notes
- This SDK is injected into Build iframes via the Build preview/runtime.
- Widgets call SDK methods; the parent proxies to the API.
- Data API methods require scoped tokens handled by the parent; some namespaces include write methods.
- Use Twinkle.privateDb as the default private per-user persistence layer for preferences, drafts, settings, and small JSON state.
- Use Twinkle.userDb only for advanced private SQLite needs such as tables, indexes, many rows, filtered queries, or aggregates.
- Use Twinkle.leaderboards for public Build scoreboards. Signed-in viewers are ranked by Twinkle username; guests can submit with a display name.
- Use Twinkle.sharedDb for custom shared multi-user structured data, guestbooks, votes, and append-only run history.
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
- async can(actionName) | scopes: none
  - Returns: boolean
- async listActions() | scopes: none
  - Returns: { available, blocked, details }
- async refresh() | scopes: none
  - Returns: Capability snapshot

### Twinkle.viewer
- async get() | scopes: none
  - Returns: { id, username, profilePicUrl, isLoggedIn, isOwner, isGuest }
- async refresh() | scopes: none
  - Returns: Viewer info

### Twinkle.preview
- getLayout() | scopes: none
  - Returns: { mode, viewport, stage, safeInsets, playfield }
  - Read the host preview layout and derive a fixed-world scale from layout.playfield before sizing a canvas, sprites, or mobile game UI.
  - Example: const WORLD = { width: 360, height: 640 }; const layout = Twinkle.preview.getLayout(); const scale = Math.min(layout.playfield.width / WORLD.width, layout.playfield.height / WORLD.height);
- reserveInsets({ top, right, bottom, left }) | scopes: none
  - Returns: { mode, viewport, stage, safeInsets, playfield }
  - Reserve host-aware safe space for HUD bars, touch controls, or other overlays before clamping gameplay.
  - Example: Twinkle.preview.reserveInsets({ top: 72, bottom: 120, left: 0, right: 0 });
- setPlayfield({ x, y, width, height } | null) | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Declare the actual playable rectangle when the game area is smaller than the raw canvas.
  - Example: Twinkle.preview.setPlayfield({ x: layout.playfield.x, y: layout.playfield.y, width: layout.playfield.width, height: layout.playfield.height });
- reportGameplayState({ playfieldBounds?, playerBounds? } | null) | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Report live player or avatar bounds so the preview host can detect floor, wall, or out-of-bounds issues.
  - Example: Twinkle.preview.reportGameplayState({ playerBounds: { x: player.x, y: player.y, width: player.width, height: player.height } });
- getGameplayTelemetry() | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
  - Read the latest preview-side gameplay telemetry snapshot.
- clearGameplayState() | scopes: none
  - Returns: { playfieldBounds, playerBounds, overflowTop, overflowRight, overflowBottom, overflowLeft, status, reportedAt } | null
- clearReservedInsets() | scopes: none
  - Returns: { mode, viewport, stage, safeInsets, playfield }
- subscribe(listener, { immediate } = {}) | scopes: none
  - Returns: unsubscribe()
  - Listen for host layout changes so a fixed-world game scale or canvas surface stays synced after resize, mobile viewport changes, or embedded runtime layout shifts.
  - Example: const unsubscribe = Twinkle.preview.subscribe((layout) => syncGameLayout(layout), { immediate: true });

### Twinkle.mount
- async get() | scopes: none
  - Returns: { type: 'subject', id: number } | null
- async refresh() | scopes: none
  - Returns: { type: 'subject', id: number } | null

### Twinkle.notifications
- getLaunchTarget() | scopes: none
  - Returns: { notificationId, buildId, eventKey, eventLabel, target, payload? } | null
  - Read the current notification launch target, if the app was opened from a Build notification.
- onLaunchTarget(listener, { immediate } = {}) | scopes: none
  - Returns: unsubscribe()
  - Listen for notification launch targets while the Build app is already open.
  - Example: const off = Twinkle.notifications.onLaunchTarget((launchTarget) => focusEntry(launchTarget?.target?.focus?.entryId));
- async getSubscription(channelKey, { targetKey }) | scopes: notifications:read
  - Returns: { subscription }
  - Read whether the current viewer is subscribed to an app-defined notification channel target.
  - Example: const { subscription } = await Twinkle.notifications.getSubscription('room.message', { targetKey: 'room:lobby' });
- async subscribe(channelKey, { targetKey, launchTarget }) | scopes: notifications:write
  - Returns: { subscription }
  - Subscribe the current viewer to an app-defined notification channel target.
  - Example: await Twinkle.notifications.subscribe('room.message', { targetKey: 'room:lobby', launchTarget: { view: 'room', roomId: 'lobby' } });
- async subscribeMany([{ channelKey, targetKey, launchTarget }]) | scopes: notifications:write
  - Returns: { subscriptions }
  - Subscribe the current viewer to multiple app-defined notification channel targets in one request.
  - Example: await Twinkle.notifications.subscribeMany([{ channelKey: 'room.message', targetKey: 'room:lobby', launchTarget: { view: 'room', roomId: 'lobby' } }]);
- async unsubscribe(channelKey, { targetKey }) | scopes: notifications:write
  - Returns: { subscription: null }
  - Unsubscribe the current viewer from an app-defined notification channel target.
  - Example: await Twinkle.notifications.unsubscribe('room.message', { targetKey: 'room:lobby' });
- async unsubscribeMany([{ channelKey, targetKey }]) | scopes: notifications:write
  - Returns: { subscriptions: [], removed }
  - Unsubscribe the current viewer from multiple app-defined notification channel targets in one request.
  - Example: await Twinkle.notifications.unsubscribeMany([{ channelKey: 'room.message', targetKey: 'room:lobby' }]);
- async notifySubscribers(channelKey, { targetKey, eventKey, label, summary, launchTarget, payload }) | scopes: notifications:emit
  - Returns: { sent }
  - Notify viewers who opted into an app-defined channel target, without requiring a sharedDb write.
  - Example: await Twinkle.notifications.notifySubscribers('room.message', { targetKey: 'room:lobby', eventKey: 'room.message.created', label: 'Room messages', summary: 'posted in Lobby', launchTarget: { view: 'room', roomId: 'lobby', messageId } });
- async getSubjectUpdateSubscription(subjectId) | scopes: notifications:read
  - Returns: { subscription }
  - Read whether the current viewer is subscribed to Build notifications for updates to a subject.
  - Example: const { subscription } = await Twinkle.notifications.getSubjectUpdateSubscription(subjectId);
- async subscribeToSubjectUpdates(subjectId, { target } = {}) | scopes: notifications:write
  - Returns: { subscription }
  - Subscribe the current viewer to notifications when the original subject author adds a new page or update.
  - Example: await Twinkle.notifications.subscribeToSubjectUpdates(subjectId, { target: { view: 'book', subjectId } });
- async unsubscribeFromSubjectUpdates(subjectId) | scopes: notifications:write
  - Returns: { subscription: null }
  - Unsubscribe the current viewer from Build notifications for a subject's new pages or updates.

### Twinkle.chess
- async bestMove({ fen, depth?, skillLevel?, maxTimeMs?, timeoutMs? }) | scopes: none
  - Returns: { success, move, bestMove, from, to, promotion, evaluation, depth, mate, error, engine }
  - Ask the parent-hosted Stockfish engine for the best move from a FEN position.
  - Example: const result = await Twinkle.chess.bestMove({ fen: game.fen(), skillLevel: 8, maxTimeMs: 1000 });
if (result.success) game.move({ from: result.from, to: result.to, promotion: result.promotion || undefined });
- async evaluate({ fen, depth?, skillLevel?, maxTimeMs?, timeoutMs? }) | scopes: none
  - Returns: { success, move, bestMove, from, to, promotion, evaluation, depth, mate, error, engine }
  - Analyze a FEN position and return Stockfish's current best move plus centipawn or mate evaluation.
  - Example: const analysis = await Twinkle.chess.evaluate({ fen: game.fen(), depth: 12 });
console.log(analysis.bestMove, analysis.evaluation, analysis.mate);

### Twinkle.files
- async saveAs({ fileName, url, dataUrl, data, text, json, bytes, blob, file, mimeType } = {}) | scopes: none
  - Returns: { success, fileName, size?, mimeType?, method }
  - Download a generated or remote file to the viewer's local device through the parent frame without opening a popup.
  - Example: await Twinkle.files.saveAs({ fileName: 'fashion-guide.png', dataUrl: imageUrl, mimeType: 'image/png' });
- async uploadGenerated({ fileName, url, dataUrl, data, text, json, bytes, blob, file, mimeType } = {}) | scopes: files:write
  - Returns: { assets: [{ id, buildId, fileName, originalFileName, mimeType, sizeBytes, filePath, url, thumbUrl, fileType, uploadedByUserId, createdAt }], failed?: [{ fileName, message }], canceled }
  - Upload an app-generated file to Twinkle-hosted cloud storage without opening a picker, then store the returned asset refs in sharedDb/privateDb/userDb.
  - Example: const { assets } = await Twinkle.files.uploadGenerated({ fileName: 'fashion-guide.png', dataUrl: generatedImageUrl, mimeType: 'image/png' });
- async pickAndUpload({ accept, multiple } = {}) | scopes: files:write
  - Returns: { assets: [{ id, buildId, fileName, originalFileName, mimeType, sizeBytes, filePath, url, thumbUrl, fileType, uploadedByUserId, createdAt }], failed?: [{ fileName, message }], canceled }
  - Pick supported local files and upload them to Twinkle-hosted cloud storage, then store the returned asset refs in sharedDb/privateDb/userDb.
  - Example: const { assets, canceled } = await Twinkle.files.pickAndUpload({ accept: 'image/*,.pdf', multiple: true });
- async list({ cursor, limit } = {}) | scopes: files:read
  - Returns: { assets: [{ id, buildId, fileName, originalFileName, mimeType, sizeBytes, filePath, url, thumbUrl, fileType, uploadedByUserId, createdAt }], nextCursor, usage: { totalBytes, fileCount, maxRuntimeFileStorageBytes, remainingBytes } | null }
  - List the current viewer's uploaded runtime files for this build.
  - Example: const { assets, usage } = await Twinkle.files.list({ limit: 20 });
- async delete(assetId) | scopes: files:write
  - Returns: { success, deletedAssetId, usage: { totalBytes, fileCount, maxRuntimeFileStorageBytes, remainingBytes } | null }
  - Delete one of the current viewer's uploaded runtime files and free up Twinkle.files quota.
  - Example: await Twinkle.files.delete(assetId);

### Twinkle.ai
- async listPrompts() | scopes: none
  - Returns: Array<{ id, title, description }>
- async chat({ promptId, message, history, systemPrompt, requestId, onText, onStatus } = {}) | scopes: none
  - Returns: { text, response, model, aiUsagePolicy }
  - Generate text with the default Lumine text model, optionally streaming text updates through onText.
  - Example: const chatHistory = conversation.slice(-12).map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.text }));
const result = await Twinkle.ai.chat({ message, history: chatHistory, systemPrompt: 'You are a cheerful pirate helper who answers in one sentence.', onText: (text, meta) => renderReply(text), onStatus: (status) => setThinking(status === 'thinking') });
- async generateObject({ prompt, expectedStructure, thinkingMode, mode, instructions, systemPrompt } = {}) | scopes: none
  - Returns: { object, result, model, provider, thinkingMode, requestedThinkingMode, aiUsagePolicy }
  - Generate a validated structured JSON object for app decisions, routing, grading, and game-state logic.
  - Example: const { object } = await Twinkle.ai.generateObject({ thinkingMode: 'medium', prompt: 'Classify the player intent from: ' + playerText, expectedStructure: { action: 'string', targetCharacter: 'string', confidence: 0, shouldAskFollowUp: false } });
- onChatStatus(listener) | scopes: none
  - Returns: unsubscribe function
  - Listen to shared runtime AI chat stream events.
- async generateImage({ prompt, referenceImageB64, previousResponseId, previousImageId, engine, quality, requestId, onStatus, timeoutMs } = {}) | scopes: none
  - Returns: { success, imageUrl, responseId, imageId, engine, quality, aiUsagePolicy } or { success: false, error, reason, code, aiUsagePolicy }
  - Generate or edit an image from a prompt and optional base64/data-URL reference image.
  - Example: const result = await Twinkle.ai.generateImage({ prompt: 'Create a fashion guide portrait for this face with flattering colors and outfit ideas', referenceImageB64, quality: 'high', onStatus: (status) => console.log(status.stage) });
- onImageGenerationStatus(listener) | scopes: none
  - Returns: unsubscribe function
  - Subscribe to real-time image generation status events forwarded into the build iframe.
  - Example: const unsubscribe = Twinkle.ai.onImageGenerationStatus((status) => console.log(status.stage));

### Twinkle.characters
- async chat({ character, thinkingMode, message, history, roomContext, scene, systemPrompt, instructions, includeWebsiteContext, requestId, onText, onStatus } = {}) | scopes: none
  - Returns: { text, response, character, aiUsername, thinkingMode, requestedThinkingMode, includeWebsiteContext, model, provider, aiUsagePolicy }
  - Talk to Zero or Ciel from a Build app, either as a final-response call or streaming RPG-style dialogue text with onText/onStatus.
  - Example: const dialogueHistory = recentTurns.slice(-16).map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.text, speaker: entry.speaker }));
const result = await Twinkle.characters.chat({ character: 'zero', thinkingMode: thinkHard ? 'high' : 'medium', message: playerText, history: dialogueHistory, roomContext, scene: { location: 'classroom', nearbyCharacters: ['zero', 'ciel'] }, includeWebsiteContext: false, onText: (text) => renderDialogue(text) });
- onChatStatus(listener) | scopes: none
  - Returns: unsubscribe function
  - Listen to shared Zero/Ciel runtime chat stream events.

### Twinkle.userDb
- async query(sql, params) | scopes: none
  - Returns: { rows, rowCount, truncated }
  - Run a SELECT against advanced private per-user SQLite. Use Twinkle.privateDb instead for simple preferences, drafts, settings, or small JSON state.
- async exec(sql, params) | scopes: none
  - Returns: { changes, lastInsertRowid }
  - Run a write or schema statement against advanced private per-user SQLite.

### Twinkle.subjects
- async getMySubjects({ limit, cursor } = {}) | scopes: content:read
  - Returns: { subjects: [{ id, title, description, filePath, fileName, fileSize, thumbUrl, timeStamp, rootType, rootId, rewardLevel }], cursor? }
- async search({ query, limit, cursor } = {}) | scopes: content:read
  - Returns: { subjects: [{ id, contentType, contentId, title, description, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, rootType, rootId, rewardLevel, numComments }], cursor?, pagination: { limit, hasMore, nextCursor }, filters: { query } }
  - Search Twinkle subjects by text for subject picker UIs, book apps, scrapbooks, and galleries.
  - Example: const { subjects } = await Twinkle.subjects.search({ query: searchText, limit: 12 });
- async getSubject(subjectId) | scopes: content:read
  - Returns: { subject: { id, title, description, filePath, fileName, fileSize, thumbUrl, secretAnswer, secretAttachment, timeStamp, userId, username, profilePicUrl, rootType, rootId, rewardLevel } }
- async getSubjectComments(subjectId, { limit, cursor } = {}) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp }], cursor? }

### Twinkle.aiCards
- async list({ limit, cursor, level, minLevel, maxLevel, quality, userId, hasImage, hasExample } = {}) | scopes: content:read
  - Returns: { cards: [{ id, contentType, contentId, word, text, exampleText, prompt, level, wordLevel, quality, style, imagePath, imageUrl, isMysteryCard, isImageGenerating, creatorId, ownerId, username, profilePicUrl, timeStamp, lastInteraction }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - List existing public AI Cards newest first, including each card word, example sentence text, word level, and quality.
  - Example: const { cards } = await Twinkle.aiCards.list({ level: 2, hasExample: true, limit: 20 });
- async search({ query, limit, cursor, level, minLevel, maxLevel, quality, userId, hasImage, hasExample } = {}) | scopes: content:read
  - Returns: { cards: [{ id, contentType, contentId, word, text, exampleText, prompt, level, wordLevel, quality, style, imagePath, imageUrl, isMysteryCard, isImageGenerating, creatorId, ownerId, username, profilePicUrl, timeStamp, lastInteraction }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - Search existing public AI Cards by word, with optional level and quality filters.
  - Example: const { cards } = await Twinkle.aiCards.search({ query: searchText, minLevel: 1, maxLevel: 3, hasExample: true, limit: 12 });
- async get(cardId) | scopes: content:read
  - Returns: { card: { id, contentType, contentId, word, text, exampleText, prompt, level, wordLevel, quality, style, imagePath, imageUrl, isMysteryCard, isImageGenerating, creatorId, ownerId, username, profilePicUrl, timeStamp, lastInteraction } }
  - Fetch one existing public AI Card by id, including word, example text, and level metadata.
  - Example: const { card } = await Twinkle.aiCards.get(cardId);

### Twinkle.aiStories
- async list({ limit, cursor, order, difficulty, type, topicKey, isListening, userId, hasImage, hasQuestions } = {}) | scopes: content:read
  - Returns: { stories: [{ id, contentType, contentId, topic, topicKey, type, story, explanation, difficulty, isListening, imagePath, imageUrl, audioPath, audioUrl, questions, questionsBy, hasImage, hasQuestions, userId, username, profilePicUrl, timeStamp }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - List completed existing user-generated AI Stories, optionally filtered by exact level/type/topicKey book and ordered newest or oldest first.
  - Example: const { stories } = await Twinkle.aiStories.list({ difficulty: 1, type: 'science', topicKey: 'Astronomy', order: 'oldest', limit: 20 });
- async chapters({ limit, cursor, difficulty, type, topicKey, isListening, userId, hasImage, hasQuestions } = {}) | scopes: content:read
  - Returns: { chapters: [{ difficulty, type, topicKey, title, sampleTopic, storyCount, readingCount, listeningCount, imageCount, questionCount, latestStoryId, latestTimeStamp }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - List server-built AI Story books grouped by level, type, and topic, with counts and navigation metadata but no story bodies.
  - Example: const page = await Twinkle.aiStories.chapters({ limit: 200 });
- async search({ query, limit, cursor, order, difficulty, type, topicKey, isListening, userId, hasImage, hasQuestions } = {}) | scopes: content:read
  - Returns: { stories: [{ id, contentType, contentId, topic, topicKey, type, story, explanation, difficulty, isListening, imagePath, imageUrl, audioPath, audioUrl, questions, questionsBy, hasImage, hasQuestions, userId, username, profilePicUrl, timeStamp }], cursor?, pagination: { limit, hasMore, nextCursor }, filters }
  - Search completed existing user-generated AI Stories by topic or story text, optionally within an exact level/type/topicKey book.
  - Example: const { stories } = await Twinkle.aiStories.search({ query: searchText, difficulty: 2, type: 'history', topicKey: 'Ancient Rome', order: 'oldest', limit: 12 });
- async get(storyId) | scopes: content:read
  - Returns: { story: { id, contentType, contentId, topic, topicKey, type, story, explanation, difficulty, isListening, imagePath, imageUrl, audioPath, audioUrl, questions, questionsBy, hasImage, hasQuestions, userId, username, profilePicUrl, timeStamp } }
  - Fetch one completed existing AI Story by id, including story text for passage typing, media URLs, and normalized questions when available.
  - Example: const { story } = await Twinkle.aiStories.get(storyId);

### Twinkle.grammarbles
- async listQuestions({ level, limit, cursor } = {}) | scopes: content:read
  - Returns: { questions: [{ id, level, rating, question, choices, answerIndex, correctChoice, correctChoiceKey, isChecked, explanation }], cursor?, pagination: { level, limit, hasMore, nextCursor } }
  - Read public Grammarbles questions and answers by level with rating/id cursor pagination.
  - Example: const page = await Twinkle.grammarbles.listQuestions({ level: 3, limit: 100 }); const question = page.questions[Math.floor(Math.random() * page.questions.length)];
- async getMyQuestionHistory({ level, limit, cursor } = {}) | scopes: content:read
  - Returns: { attempts: [{ id, questionId, level, grade, gradeRank, isCorrect, attemptNumber, timeStamp }], cursor?, pagination: { level, limit, hasMore, nextCursor } }
  - Read the signed-in viewer's real Grammarbles attempt rows for trainer filtering.
  - Example: const history = await Twinkle.grammarbles.getMyQuestionHistory({ level: selectedLevel, limit: 500 }); const answeredIds = new Set(history.attempts.map((attempt) => attempt.questionId));

### Twinkle.subjectComments
- async list(subjectId, { limit, cursor, sortBy, includeReplies, author, authorUserId, replyScope } = {}) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, commentId, replyId }], cursor?, pagination: { limit, hasMore, nextCursor }, filters: { subjectId, sortBy, includeReplies, author, replyScope, authorUserId } }
  - Read a subject's comment stream with stable keyset pagination, oldest/newest ordering, author filters, and optional same-author reply scoping.
  - Example: const { subjects } = await Twinkle.subjects.search({ query: searchText, limit: 12 }); const subjectId = pickedSubject.id; const page = await Twinkle.subjectComments.list(subjectId, { sortBy: 'oldest', author: 'subjectPoster', includeReplies: true, replyScope: 'ownThread', limit: 50 });

### Twinkle.profileComments
- async getProfileComments({ profileUserId, limit, offset, sortBy, includeReplies, range, since, until } = {}) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, likes, replies, commentId, replyId }], pagination: { limit, offset, hasMore, nextOffset }, filters: { profileUserId, sortBy, includeReplies, since, until } }
- async getProfileCommentIds({ profileUserId, limit, offset, sortBy, includeReplies, range, since, until } = {}) | scopes: content:read
  - Returns: { ids: number[], pagination: { limit, offset, hasMore, nextOffset }, filters: { profileUserId, sortBy, includeReplies, since, until } }
- async getCommentsByIds(idsOrOpts) | scopes: content:read
  - Returns: { comments: [{ id, content, filePath, fileName, fileSize, thumbUrl, timeStamp, userId, username, profilePicUrl, commentId, replyId }] }
- async getProfileCommentCounts(idsOrOpts) | scopes: content:read
  - Returns: { countsById: { [commentId]: { likes, replies } } }

### Twinkle.leaderboards
- async get({ boardKey = 'default', limit, cursor } = {}) | scopes: none
  - Returns: { entries: [{ rank, id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt }], scores, cursor, hasMore, personalBest: { id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt } | null }
  - Read score-sorted personal-best leaderboard rows for this Build app.
- async submit({ boardKey = 'default', score, displayName, meta } = {}) | scopes: none
  - Returns: { entry: { id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt } | null, personalBest: { id, buildId, boardKey, viewerKind, userId, displayName, score, meta, achievedAt, createdAt, updatedAt } | null, improved, previousScore }
  - Submit a score to a public Build leaderboard using server-owned viewer identity.

### Twinkle.sharedDb
- async getTopics() | scopes: sharedDb:read
  - Returns: { topics: [{ id, name, createdBy, createdAt }] }
- async createTopic(name) | scopes: sharedDb:write
  - Returns: { topic: { id, name, createdBy, createdAt } }
- async getEntries(topicName, { limit, pageSize, cursor, order, sort, direction } = {}) | scopes: sharedDb:read
  - Returns: { entries: [{ id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt }], cursor?, hasMore }
  - Read shared topic rows with cursor pagination.
- async loadMoreEntries(topicName, { limit, pageSize, cursor, order, sort, direction } = {}) | scopes: sharedDb:read
  - Returns: { entries: [{ id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt }], cursor?, hasMore }
  - Fetch the next sharedDb page.
- async addEntry(topicName, data, { notify } = {}) | scopes: sharedDb:write
  - Returns: { entry: { id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt } }
  - Append a shared JSON row, optionally creating a Twinkle notification from the canonical write.
- async updateEntry(entryId, data, { notify } = {}) | scopes: sharedDb:write
  - Returns: { entry: { id, topicId, userId, username, profilePicUrl, data, createdAt, updatedAt } }
  - Update a viewer-owned shared row, optionally notifying safe recipients from the canonical write.
- async deleteEntry(entryId) | scopes: sharedDb:write
  - Returns: { success: true }

### Twinkle.chat
- async listRooms() | scopes: chat:read
  - Returns: { rooms: [{ id, buildId, key, name, createdByUserId, createdAt, updatedAt }] }
- async createRoom({ roomKey, name }) | scopes: chat:write
  - Returns: { room: { id, buildId, key, name, createdByUserId, createdAt, updatedAt } }
- async listMessages(roomKey, { cursor, limit } = {}) | scopes: chat:read
  - Returns: { messages: [{ id, roomId, roomKey, userId, username, profilePicUrl, role, status, text, metadata, clientMessageId, createdAt, updatedAt }], cursor? }
- async sendMessage(roomKey, textOrOptions, options) | scopes: chat:write
  - Returns: { message: { id, buildId, roomId, roomKey, userId, username, profilePicUrl, role, status, text, metadata, clientMessageId, createdAt, updatedAt }, room: { id, buildId, key, name, createdByUserId, createdAt, updatedAt }, created }
- async deleteMessage(messageId) | scopes: chat:write
  - Returns: { success: true, messageId }
- subscribe(roomKey, listener) | scopes: chat:read
  - Returns: unsubscribe function

### Twinkle.world
- async join({ worldKey = 'default', roomKey = 'main', instanceId = 'main', presence, player } = {}) | scopes: none
  - Returns: { sessionId, session, room, players, snapshot, subscribe(listener), updatePresence(patch), send(actionOrType, data), leave() }
  - Join a realtime Build world room and receive a snapshot plus a session handle for presence updates, actions, and room events.
  - Example: const world = await Twinkle.world.join({ roomKey: 'town-square', presence: { x: 0, y: 0, z: 0, facing: 'south' }, player: { name: avatarName } });
world.subscribe((event) => updateRemotePlayers(event.players));
world.updatePresence({ x, y, z, facing });
- isRecoverableSessionError(error) | scopes: none
  - Returns: boolean
  - Return true when a world request error is expected to be handled by app code instead of crashing.
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
  - Example: if (Twinkle.world.isSessionEndedError(error)) {
  world = null;
  scheduleReconnect();
}
- leaveAll() | scopes: none
  - Returns: void
  - Leave every active world session in the current iframe.

### Twinkle.users
- async getUser(userId) | scopes: user:read
  - Returns: { id, username, profilePicUrl, realName } | null
- async getUsers({ search, userIds, cursor, limit } = {}) | scopes: users:read
  - Returns: { users: [{ id, username, profilePicUrl, realName }], cursor? }

### Twinkle.reflections
- async getDailyReflections({ userIds, cursor, lastId, limit } = {}) | scopes: dailyReflections:read
  - Returns: { reflections: [{ id, userId, response, questionId, submittedAt, sharedAt, username, profilePicUrl, question }], cursor? }
  - Read only currently public Daily Reflection shares. response is the exact text the author chose to share publicly, never an unshared raw/private answer.
- async getDailyReflectionsByUser(userId, { cursor, lastId, limit } = {}) | scopes: dailyReflections:read
  - Returns: { reflections: [{ id, userId, response, questionId, submittedAt, sharedAt, username, profilePicUrl, question }], cursor? }
  - Read one user's currently public Daily Reflection shares. response is the exact text the author chose to share publicly, never an unshared raw/private answer.

### Twinkle.privateDb
- async get(key) | scopes: privateDb:read
  - Returns: { item: { id, key, value, updatedAt } | null }
  - Read one key from the default private per-user JSON store.
- async list({ prefix, limit, cursor } = {}) | scopes: privateDb:read
  - Returns: { items: [{ id, key, value, updatedAt }], cursor? }
  - List keys from the default private per-user JSON store.
- async set(key, value) | scopes: privateDb:write
  - Returns: { item: { id, key, value, updatedAt } }
  - Upsert one JSON-serializable value in the default private per-user store.
- async remove(key) | scopes: privateDb:write
  - Returns: { success: true, deleted: boolean }
  - Delete one key from the default private per-user JSON store.

### Twinkle.reminders
- async list({ includeDisabled, limit } = {}) | scopes: reminders:read
  - Returns: { reminders: [{ id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt }] }
- async create({ title, body, targetPath, payload, schedule, isEnabled }) | scopes: reminders:write
  - Returns: { reminder: { id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt } | null }
- async update(reminderId, patch) | scopes: reminders:write
  - Returns: { reminder: { id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt } | null }
- async remove(reminderId) | scopes: reminders:write
  - Returns: { success: true, deleted: boolean }
- async getDue({ now, autoAcknowledge, limit } = {}) | scopes: reminders:read
  - Returns: { now, reminders: [{ id, buildId, userId, title, body, targetPath, payload, isEnabled, schedule, lastTriggeredAt, createdAt, updatedAt }] }

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
Use Twinkle.world for live avatar presence and lightweight room actions, recover stale session handles, and keep durable state like inventory and quests in sharedDb/privateDb.
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
