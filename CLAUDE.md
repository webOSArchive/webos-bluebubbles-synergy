# Claude Code Notes

## ⚠️ HARD RULES — DO NOT VIOLATE

1. **ALL network/HTTP I/O goes through the system `curl` binary. NEVER switch off curl — EVER.**
   The device runs an ancient Node whose `http`/`https` modules cannot do modern TLS and whose
   APIs are unreliable. Do NOT "optimize" or "simplify" to Node `http`/`https`, `AjaxCall`,
   `wget`, `XMLHttpRequest`, or anything else. The single transport is `curl`, invoked from the
   `curlRequest` helper. This is non-negotiable and applies to every request, forever.
   - Corollary: `curlRequest` uses `child_process.execFile("curl", ...)` — that is just *how* curl
     is launched; it is still curl. When capturing curl's output, ALWAYS pass a large `maxBuffer`
     (old Node's default is tiny, ~200KB, and silently errors the whole sync on overflow). Keep
     responses small too (modest query limits). If output could ever be large, prefer `curl -o
     <file>` + read the file over buffering stdout.

## Project overview
webOS Synergy service that bridges iMessages from a Mac running [BlueBubbles](https://bluebubbles.app) into the native webOS Messages app. The Mac exposes a JSON REST API; this service polls it and writes DB8 records that extend `com.palm.chatthread:1` and `com.palm.immessage:1`, which the Messages app renders automatically.

This is a fork of the original Message Bridge connector, re-targeted at the BlueBubbles REST API while preserving the same sync behavior, DB8 schema, and resumability design.

The server running at `192.168.10.3:8080` is the BlueBubbles instance on Jon's Mac.

### BlueBubbles API mapping
- **Auth:** the server password is sent as the `?guid=<password>` query param on every request (BlueBubbles' scheme). The account *password* IS the BlueBubbles server password; the account *username* is only used as the local user's display identity in DB8 records.
- **Discover activity / recent messages:** `POST /api/v1/message/query` body `{limit, offset, with:["handle","chat","chat.participants"], sort:"DESC"}` → `data[]` of messages, each with `dateCreated` (epoch **ms**), `text` (may be null), `isFromMe`, `handle.address` (sender; absent on outgoing), and embedded `chats[0]` (`guid`, `displayName`, `participants[].address`). **This is the source of truth for activity** — see the staleness warning below.
- ⚠️ **`POST /api/v1/chat/query`** (`{with:["lastmessage","participants"], sort:"lastmessage"}`) is **STALE** — its `lastMessage`/sort do not reflect the newest activity, so don't use it for discovery or deltas. Its `participants`/`displayName` are fine if you ever need just metadata. We no longer call it.
- **List a chat's messages:** `GET /api/v1/chat/{guid}/message?guid=<pw>&with=handle&limit=N&sort=DESC` (newest-first; `sort=DESC` IS honored here). Same message fields as above (`handle.address` is the sender, absent on outgoing).
- **Send:** `POST /api/v1/message/text?guid=<pw>` body `{chatGuid, tempGuid, message, method:"apple-script"}`. `method:"apple-script"` avoids needing the Private API; `tempGuid` just needs to be unique per send.
- All payloads are wrapped in `{status, message, data}` — callers parse and read `.data`.

### DB8 field mapping (BlueBubbles → existing fields, unchanged schema)
- `iMessageId` and `iMessageReplyId` on chatthread both store the chat **guid** (used as the message-query path segment and as the send `chatGuid`).
- `iMessageLastReceived` stores `lastMessage.dateCreated` (ms) — the delta marker; `messagesPopulated:true` is set on a chatthread only once its messages have actually been fetched (see Sync architecture).
- `iDispatchId` on immessage stores the message `guid` for de-duplication.

## Platform constraints
- **ES5 only** — no arrow functions, no `let`/`const`, no template literals, no destructuring. The device runs a very old Node.js.
- All sync operations must be resumable — webOS kills long background syncs. Design for partial completion.
- See `notes.md` for Futures, Kinds, DB8, ActivityManager, and debugging notes.

## Architecture
- `service/serviceEndPoints.js` — all sync logic
- `service/prologue.js` — Foundations imports, Base64, `calcSyncDateTime`, `logNoticeably`
- `app/source/iMessageBridge.js` — Enyo UI (server/port config, manual sync trigger)
- DB8 kinds: `com.wosa.bluebubbles.immessage:1` (messages), `com.wosa.bluebubbles.chatthread:1` (threads), `com.wosa.bluebubbles.transport:1` (server config)
- All HTTP(S) is done via the system **`curl`** binary through `child_process.execFile` (the shared `curlRequest` helper at the top of `serviceEndPoints.js`). curl handles GET and POST, negotiates modern TLS (1.3) via the platform's updated curl, and uses `-k` to accept self-signed certs. The device's bundled Node `http`/`https` and BusyBox `wget` are no longer used (too old for TLS 1.3; wget also can't POST a body).

## Bugs fixed (May 2026)
1. **Duplicate message flood** — `DB.find` in `syncChatAssistant` fetched ALL messages from ALL threads with no filter. Once total count exceeded DB8's ~500-record page limit, old messages fell off and were re-inserted every sync. Fixed: added `where` clause filtering by `iMessageId` (current thread's remote ID).

2. **Recursive sync loop** — When new chat threads were discovered, the code called `DB.put` (fire-and-forget) then immediately called `sync` recursively. Because the puts hadn't completed yet, the recursive sync saw the threads as still missing, created them again, and called sync again → infinite loop. Fixed: removed the recursive call. New threads get their messages on the next periodic sync.

3. **Missing `return` after early guard** in `syncChatAssistant` — set `future.result` but didn't stop execution. Fixed.

4. **`args` used before declaration** in `onDeleteAssistant` — `logNoticeably(args)` before `var args = ...`. Fixed.

5. **Global variable leaks** — `replyAddincomingress`, `syncActivity`, `imsgDispatches` in `serviceEndPoints.js` and `c3` in `prologue.js` were all missing `var`. Fixed.

6. **Null crash on failure path** — Both `syncAssistant` and `syncChatAssistant` accessed `future.result.results.length` without first checking `returnValue`. Crashes when any earlier step in the chain fails. Fixed: added `returnValue` guard before each `results` access.

7. **Username failure continued as success** in `syncChatAssistant` — error branch returned `{returnValue: true}` instead of `false`, causing the chain to proceed with blank credentials. Fixed.

8. **Malformed URL when host includes `http://`** — `httpRequestAssistant` builds `"http://" + host + ":" + port`, so a host like `"http://192.168.10.3"` produces `http://http://192.168.10.3:8080/...`. Old webOS wget exits 0 on a bad URL but returns empty stdout, causing the connection test to silently fail. Fixed: `httpRequestAssistant` now strips the protocol prefix and any embedded port from `host` before building the URL.

## Known remaining issues

### Auth
The server password is appended as `?guid=<password>` to every request. **The password is collected by the companion app, not the Accounts pane** — it's stored as `serverPassword` on the `com.wosa.bluebubbles.transport:1` config record, and all three request functions (`syncAssistant`, `syncChatAssistant`, `sendIM`) read it from there (`results[0].serverPassword`). The webOS Accounts password is intentionally ignored (the account is still required so the MESSAGING capability registers; enter any value). The Accounts `username` *is* still used — fetched from the keymanager `BlueBubblesUsername` key — as the local user's display identity. The keymanager `BlueBubblesPassword` store/remove in `onCreate`/`onDelete` is now vestigial. The config app's connection test hits `/api/v1/ping?guid=<password>`, so it now validates auth (a wrong password → 401 → reported as a failed test). Note: `serverPassword` lives in DB8 in plaintext (visible via Impostah and in service logs) — acceptable for a self-hosted LAN/tunnel server password, but not secret-grade.

### `sendIM` blocked by BlueBubbles Mac permissions
`sendIM` POSTs `{chatGuid, tempGuid, message, method:"apple-script"}` to `POST /api/v1/message/text`. With `method:"apple-script"`, BlueBubbles drives Messages.app via AppleScript, so the process running BlueBubbles must have Automation permission to control Messages.app (System Settings → Privacy & Security → Automation). If revoked (e.g. after a macOS update), sends fail. The Private API method (`method:"private-api"`) is more capable but requires the BlueBubbles Private API helper to be installed. To diagnose a failing send, try sending from the BlueBubbles desktop/web client directly. The POST goes out via the shared `curlRequest` helper (`curl -s -k -X POST --data-raw <json> <url>`), same as every other request.

### HTTPS / TLS
HTTPS is supported by routing all traffic through the system `curl` (see Architecture). Scheme is chosen by `schemeForConfig()`: https when the transport row has `messageBridgeHttps:true` **or** the stored `messageBridgeServer` begins with `https://`. The config app lets the user type an `https://` prefix; the service strips the scheme to a bare host and tracks https separately, threading a `https:` flag into `httpRequestAssistant` (and building the scheme directly in `sendIM`). `-k` accepts self-signed certs. Note: the device's Node `http`/`https` and BusyBox wget can't do TLS 1.3, which is why curl (updated in the platform's SSL deployment) is used instead. **Needs on-device verification** against a real https BlueBubbles endpoint (e.g. ngrok/Cloudflare or a self-signed LAN cert).

### Contact name resolution (numbers → contact names)
**Names are resolved on the Mac, not the device.** webOS simply displays whatever is in the message's `from[].name` (and the chatthread's `displayName`) — it does NOT match the number against the device's own Contacts for our records. This was proven by an Impostah export of a working imessage-synergy message: `from:[{addr:"SMS;-;+1...", name:"Ben Wise"}]` with `serviceName:"iMessage"`. The Message Bridge API pre-resolved the name and the connector stored it in `name`.

So contact resolution = ask BlueBubbles for the name and store it:
- `resolveContactNames()` POSTs `{addresses:[...]}` to `/api/v1/contact/query` (auth via `?guid=`) and returns a `contactKeyForAddress(addr) → displayName` map. The Contact carries `displayName`/`firstName`/`lastName` and `phoneNumbers[]`/`emails[]`; we index every address. Falls back to an empty map (→ use the number) if BlueBubbles has no macOS Contacts access (it returns empty data).
- `createThreadMessages` (per thread) resolves the distinct **incoming** `handle.address`es (outgoing/`isFromMe` messages have a **null handle**) via the name map and sets each message's `from[].name` to the resolved name (number fallback). Outgoing messages get `from[].name = username` (us), never the chat guid.
- `upsertThreads` resolves all participants of the non-empty chats in one `contact/query` and builds the thread `displayName`: a named group keeps its name; an unnamed group joins the participant names ("Nicole Wise, Chad Spaulding, …"); a 1:1 uses the contact name (number fallback).
- `contactKeyForAddress` keys phones by trailing 10 digits and emails lowercased — loose enough to match `+1 (206) 972-0841` (contact) against `+12069720841` (handle). Verified live: real contacts resolve; shortcodes/businesses/spam correctly show their number.

**Empty conversations (historical):** an early `chat/query`-driven design created threads for all ~968 chats incl. hundreds of empty/spam SMS threads with `lastMessage:null`. The `message/query`-driven discovery makes this a non-issue: only chats that actually have recent messages are ever surfaced, so empty chats never become threads.

Dead end that was tried and reverted: switching `serviceName` to `"sms"` to trigger webOS's *device-side* phone→contact matching. It rendered every sender as **"No Recipient"** because `getAddressesForThreading()` (utils.js:294) runs `from[].addr` through `enyo.g11n.PhoneNumber`, and our `addr` is the chat guid, not a clean number. Kept `serviceName:"iMessage"` (the working imessage-synergy value). `normalizeAddressForContactMatch()` (NANP-7-digit) and the `normalizedAddress` field remain in place but are not what makes names show — the Mac-resolved `name` is.

## Sync architecture (batched — June 2026 rewrite)
**The whole sync is ONE `syncAssistant` invocation** that runs a chain of direct `curlRequest` calls (NOT Luna self-calls, NOT separate per-thread service calls) and only signals completion at the very end. This shape is forced by the **Synergy connector lifecycle**:

- The framework reaps the connector the moment you set `future.result`, and gives each sync a bounded window (~`activityTimeout`, 60s). The original per-thread design — `syncAssistant` fired a separate `syncChat` Luna call per thread, then scheduled its activity and resolved `future.result` immediately in the synchronous tail — got **reaped before the slow curl calls ran**: the chat query logged `status 200`, then nothing. Symptom: no messages at all.
- **Fix:** do all the work first, on one in-process chain; call `finishSync(ok, more)` only at the end — it schedules the activities and sets `future.result = {returnValue, more}`. `{more:false}` = done; `{more:true}` = "re-invoke me for the next batch."

Flow inside `doSync` (after config + keymanager username are read):
1. **Discovery via `POST /api/v1/message/query`** (`msgQueryLimit`=200, `with:["handle","chat","chat.participants"]`, `sort:DESC`) → recent messages, each with its embedded chat (guid, displayName, participants). Group by chat (first occurrence per chat, since DESC, = its newest message). **Do NOT use `chat/query` for discovery** — its `lastMessage` / `sort:lastmessage` is **STALE** on BlueBubbles: it does not surface the chats with the newest activity, so a `chat/query`-driven sync silently misses new messages and recently-active chats. `message/query` is live.
2. `POST /api/v1/contact/query` with every participant address → name map (one request).
3. `upsertThreads`: create/update one chatthread per active chat (displayName from the name map); build `needFetch` = threads that are new **OR** lack `messagesPopulated` **OR** whose `iMessageLastReceived != ` the chat's newest message time.
4. `fetchThreadMessages`: for up to `msgBatchThreads` (15) of the `needFetch` threads, **one at a time**, `GET /api/v1/chat/{guid}/message?limit=15&with=handle&sort=DESC` (this GET's `sort=DESC` *is* honored — verified) → `createThreadMessages` (dedup by `iDispatchId`, create new immessage records) → on success merge `{iMessageLastReceived, messagesPopulated:true}`. If `needFetch` had more than the batch, `finishSync(true, true)` → `{more:true}`.

Each choice fixed a real bug we hit:
- **`message/query` for DISCOVERY, per-thread `GET` for HISTORY.** Creating messages off a single global "200 most-recent across all chats" left low-traffic threads empty (their messages were older than the 200th) → empty threads that vanish when tapped. So discovery uses `message/query` (active chats + newest-per-chat for the delta), but each thread's actual history is fetched per-thread (`limit`=15) so every thread is fully populated.
- **`messagesPopulated` flag**, not just `iMessageLastReceived`. An earlier build advanced `iMessageLastReceived` *without* fetching, so the delta thought stuck-empty threads were current. The separate flag (set only after messages are stored) self-heals them.
- **Batched + sequential.** ~15 sequential curls + the 2 queries fit the 60s window; sequential avoids spawning many curl processes on the ancient device. Steady state (nothing changed) = `needFetch` empty = just the 2 queries.
- Dedup is **per-thread** (`DB.find` filtered by `iMessageId`, indexed) — never an unfiltered `DB.find` (that hits DB8's ~500-row page limit and re-creates fallen-off records = the classic duplicate flood).

Not yet exercised on-device: the `{more:true}` resume path (only triggers with >15 changed threads at once — unknown whether Synergy auto-re-invokes promptly or waits for the 2-min periodic), and `sendIM` on the new build.

## Deployment & on-device iteration
After installing a new .ipk, the node service host **caches the old code** — a Luna restart alone will NOT reload a hot-pushed file (the node service host pre-forks from a cached copy). The reliable iteration loop:
1. **Bump the version** in `app/appinfo.json` + `package/packageinfo.json` — this is what makes webOS refresh.
2. `palm-package app service package accounts` → `palm-install <ipk>` **without `-r`** (install-over: upgrades in place and **preserves the account/config** — no recreation).
3. `luna-send -n 1 luna://org.webosinternals.ipkgservice/restartLuna '{}'`, wait ~70s.

A full uninstall (`palm-install -r com.wosa.bluebubbles`) runs `onDelete` (wipes records, cancels activities) — the clean reset, but loses the account. Device/novacom debugging workflow and gotchas are in the resumption memory and `notes.md`.
