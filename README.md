# KAY

KAY is a local-first, multimodal assistant starter built with Node.js, Express, and a dark Obsidian Glass interface.

## Install and run

Requires Node.js 20.16 or newer.

1. In a normal Windows PowerShell terminal, change into this folder.
2. Run npm.cmd install. If npm reports a network reset, retry after restoring access to registry.npmjs.org.
3. Keep .env private. Add provider keys, MongoDB connection string, and a stable JWT_SECRET of at least 32 characters.
4. Run npm.cmd run dev and open http://127.0.0.1:4173.

KAY binds to loopback. Provider API calls require outbound HTTPS access from the terminal running the server.

## What is included

- Streaming chat for Groq Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini Interactions.
- Groq defaults to the fast `openai/gpt-oss-20b` model, automatically uses Groq browser search when a prompt asks for current information, routes image understanding to Qwen vision, and uses Groq Whisper for audio transcription.
- Gemini is the default provider and uses gemini-3.5-flash-lite on generativelanguage.googleapis.com/v1beta/interactions with minimal thinking for faster everyday replies. Google Search grounding activates automatically when a prompt asks for current information or sources. Override the model with GEMINI_MODEL.
- Uploads for PDF, DOCX, text, CSV/TSV, common code files, PNG, JPG, and WebP. PDF and DOCX text is extracted; images are sent to vision-capable providers.
- Camera snapshots, browser speech recognition, MediaRecorder transcription fallback for Gemini or OpenAI Whisper, and browser text-to-speech.
- Image generation/editing with Gemini gemini-3.1-flash-image. Use Studio or type /image, /imagine, or "Generate an image of" followed by a prompt. Groq handles text and image understanding; image creation uses Gemini if that provider key is configured.
- Per-reply and full-conversation PDF/DOCX exports.
- Editable memory facts. Anonymous mode uses the local/PostgreSQL profile; signed-in accounts keep isolated profile facts in MongoDB.
- Five anonymous AI requests per browser, then sign-in is required. A signed HttpOnly cookie tracks the trial without storing an IP address; successful chats, image generation, and transcription count as requests.
- MongoDB sign-up/login with bcrypt password hashes, optional Google/Apple/GitHub OAuth sign-in, HttpOnly JWT session cookies, account-scoped conversations, and per-account memory.
- Signed-in users can send voluntary feedback. A private creator dashboard lists Google/Apple account sign-ins and submitted feedback for the account configured by KAY_CREATOR_EMAIL.
- Scrollable conversation history, account controls, mobile navigation drawer, collapsible desktop sidebar, stop-generation, copy/regenerate actions, Markdown rendering, and generated image view/download/copy.
- PostgreSQL/pgvector persistence when DATABASE_URL is configured and reachable; otherwise KAY saves to data/kay-memory.json. On PostgreSQL startup, the app applies db/schema.sql.

## Environment variables

- GROQ_API_KEY, GEMINI_API_KEY, optional OPENAI_API_KEY and ANTHROPIC_API_KEY
- GROQ_MODEL (default openai/gpt-oss-20b), GROQ_VISION_MODEL (default qwen/qwen3.8-27b), GROQ_TRANSCRIPTION_MODEL
- GEMINI_MODEL (default gemini-3.5-flash-lite for speed; set gemini-3.8-flash for heavier reasoning)
- GEMINI_IMAGE_MODEL (default gemini-3.1-flash-image)
- OPENAI_MODEL, OPENAI_IMAGE_MODEL (default gpt-image-1), OPENAI_TRANSCRIPTION_MODEL (default whisper-1)
- ANTHROPIC_MODEL
- DATABASE_URL, KAY_USER_ID
- MONGODB_URI (accounts disabled if no connection is available), JWT_SECRET, COOKIE_SECURE
- KAY_BASE_URL and provider OAuth credentials: GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, or APPLE_CLIENT_ID/TEAM_ID/KEY_ID/PRIVATE_KEY. Register `/api/auth/oauth/<provider>/callback` as the exact callback URL. Apple requires an HTTPS KAY_BASE_URL.
- KAY_CREATOR_EMAIL (the verified email of your creator account) to enable the private user and feedback dashboard.
- KAY_PROVIDER_TIMEOUT_MS (default 90000), PORT (default 4173), MAX_UPLOAD_MB (default 20)

Provider calls can incur provider usage charges. Uploads and generated images stay under data/uploads and public/generated on this computer. The chat transcript stays in this browser's local storage.

OAuth buttons appear after MongoDB is connected and the matching OAuth credentials are configured. Social sign-in currently requests verified identity and email only; it does not read Gmail, Drive, or private GitHub repositories. Those require separate scopes and explicit consent. Feedback is only stored when a signed-in user submits it, and only the configured creator account can view it. S3 hosting, vector embeddings/search, and video generation are not included. The memory store is profile/fact based; it does not yet embed or semantically retrieve old conversations. MongoDB account features require the MongoDB service and the dependencies in package.json to be installed.

## Troubleshooting

If Groq returns 401, Groq rejected the key: create a fresh key, update GROQ_API_KEY in .env, and restart KAY. Local startup now loads .env over stale PowerShell environment values. If a provider request fails with a model 404, check that the model name in .env matches one enabled for your provider account. If KAY reports outbound network access is denied, run the server from a terminal/environment that can reach the provider API.

## Checks

Run node --check server.js, node --check public/app.js, and node --check on each file in src. Then run npm.cmd install and npm.cmd run dev to smoke-check the app and provider integrations.
