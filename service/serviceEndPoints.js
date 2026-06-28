require.paths.push("./node_modules");
var child_process = require('child_process');

//This is where actual implementations of the Synergy functions are done
// The mapping of the Synergy call to these end-points is in services.json

// All HTTP(S) traffic goes through the system curl binary. The platform's updated curl
// negotiates modern TLS (1.3), which the device's bundled Node http/https and BusyBox wget
// cannot. -k (--insecure) accepts self-signed certs, which are common for self-hosted
// BlueBubbles servers. execFile (no shell) is used so arbitrary message text in a POST body
// can't break shell quoting or inject commands. callback(ok, data, statusCode).
function curlRequest(method, url, body, callback) {
   // -s silent, -S still print errors to stderr (so TLS/connect failures are captured),
   // -k accept self-signed.
   // --connect-timeout/--max-time keep a slow/hung connection from blocking the sync forever.
   var args = ["-s", "-S", "-k", "--connect-timeout", "15", "--max-time", "60", "-w", "\n%{http_code}", "-X", method];
   if (body) {
      args.push("-H", "Content-Type: application/json", "--data-raw", body);
   }
   args.push(url);
   // Log the REAL invocation (flags included, esp. -k) so a manual repro on-device matches
   // what the service runs. Args with spaces are quoted and newlines escaped for readability.
   var fmtArg = function(a) { a = String(a).replace(/\n/g, "\\n"); return /\s/.test(a) ? "'" + a + "'" : a; };
   logNoticeably("running: curl " + args.map(fmtArg).join(" "));
   // maxBuffer must be large: the device's old Node defaults execFile stdout to ~200KB, and a
   // chat/query response can exceed that. Overflow makes execFile error out and the sync silently
   // do nothing. 32MB is plenty and costs nothing unless actually used.
   child_process.execFile("curl", args, {maxBuffer: 32 * 1024 * 1024}, function(error, stdout, stderr) {
      // info carries diagnostics for the caller (and ultimately the companion app):
      //   curlError - 'ENOENT' means the curl binary was not found on PATH; a number is a
      //               curl exit code (e.g. 60 = cert problem, 7 = connection refused).
      //   stderr    - curl's own error text (thanks to -S).
      var info = { curlError: null, stderr: (stderr || ""), statusCode: 0 };
      if (error) {
         info.curlError = "" + (error.code !== undefined ? error.code : (error.message || "error"));
         logNoticeably("curl FAILED for " + url + ": code=" + error.code + " msg=" + error.message + " stderr=" + stderr);
         callback(false, (stdout || ""), 0, info);
         return;
      }
      if (!stdout) {
         logNoticeably("curl returned empty output for " + url + " stderr=" + stderr);
         callback(false, "", 0, info);
         return;
      }
      // -w appends "\n<http_code>" after the body; the code is everything after the last
      // newline (our separator is always the final newline in the output).
      var idx = stdout.lastIndexOf("\n");
      var statusCode = parseInt(stdout.substring(idx + 1), 10);
      var data = idx >= 0 ? stdout.substring(0, idx) : stdout;
      info.statusCode = statusCode;
      logNoticeably("curl " + method + " " + url + " -> status " + statusCode + (stderr ? " stderr=" + stderr : ""));
      callback(statusCode >= 200 && statusCode < 400, data, statusCode, info);
   });
}

// Normalize a remote address into the form webOS matches against a contact's
// com.palm.person phoneNumbers[].normalizedValue (which is how the Messaging app resolves a
// thread to a contact NAME). webOS computes that via enyo.g11n.PhoneNumber(addr).subscriberNumber,
// which for North-American numbers strips the country code AND area code, leaving the trailing
// 7 digits. Email/iMessage addresses match emailAddresses.normalizedValue, i.e. just lowercased.
//   "+12069720841" -> "9720841"   "(206) 972-0841" -> "9720841"   "jon@icloud.com" -> "jon@icloud.com"
// NOTE: this replicates NANP (US/Canada) normalization. International numbers would need the full
// g11n parser; verify on-device against a native SMS thread's normalizedAddress if matching fails.
function normalizeAddressForContactMatch(addr) {
   if (!addr) return "";
   addr = ("" + addr).replace(/^\s+|\s+$/g, "");
   if (addr.indexOf("@") !== -1) {
      return addr.toLowerCase();
   }
   var digits = addr.replace(/[^0-9]/g, "");
   // NANP subscriber number = last 7 digits; shorter strings (e.g. shortcodes) pass through.
   return digits.length > 7 ? digits.substring(digits.length - 7) : digits;
}

// Loose key for matching a sender/handle address to a contact's stored address. Phones -> last 10
// digits (ignores +1 / formatting differences); emails -> lowercased. This is just for our own
// address->name lookup, NOT the webOS normalizedValue.
function contactKeyForAddress(addr) {
   if (!addr) return "";
   addr = ("" + addr).replace(/^\s+|\s+$/g, "");
   if (addr.indexOf("@") !== -1) return addr.toLowerCase();
   var digits = addr.replace(/[^0-9]/g, "");
   return digits.length > 10 ? digits.substring(digits.length - 10) : digits;
}

// Resolve a list of addresses to contact display names via BlueBubbles POST /api/v1/contact/query.
// This is how the original Message Bridge connector got names ("Ben Wise"): the Mac resolves them
// and we store the result in from[].name / chatthread.displayName, which webOS displays directly
// (webOS does NOT match the number to the device's own Contacts). Calls back with a map of
// contactKeyForAddress(address) -> displayName. Returns an empty map on failure or when BlueBubbles
// has no Contacts access (it returns empty data), in which case callers fall back to the number.
function resolveContactNames(host, port, useHttps, password, addresses, callback) {
   var map = {};
   if (!addresses || addresses.length === 0) { callback(map); return; }
   // Callers pass the raw config server, which may still carry an "https://" prefix (their legacy
   // cleanup only strips "http://", and httpRequestAssistant — which normally strips it — is bypassed
   // here). Strip any scheme prefix and embedded port so we don't build "https://https://host".
   host = ("" + host);
   if (host.indexOf("://") !== -1) host = host.split("://")[1];
   if (host.indexOf(":") !== -1) host = host.split(":")[0];
   var url = (useHttps ? "https" : "http") + "://" + host + ":" + port + "/api/v1/contact/query?guid=" + encodeURIComponent(password);
   var body = JSON.stringify({ addresses: addresses });
   curlRequest("POST", url, body, function(ok, data) {
      if (ok && data) {
         try {
            var resp = JSON.parse(data);
            var contacts = (resp && resp.data) ? resp.data : [];
            for (var i = 0; i < contacts.length; i++) {
               var c = contacts[i];
               var name = c.displayName || (((c.firstName || "") + " " + (c.lastName || "")).replace(/^\s+|\s+$/g, ""));
               if (!name) continue;
               var addrs = [];
               if (c.phoneNumbers) { for (var p = 0; p < c.phoneNumbers.length; p++) addrs.push(c.phoneNumbers[p].address); }
               if (c.emails) { for (var e = 0; e < c.emails.length; e++) addrs.push(c.emails[e].address); }
               for (var a = 0; a < addrs.length; a++) {
                  var key = contactKeyForAddress(addrs[a]);
                  if (key) map[key] = name;
               }
            }
         } catch (ex) {
            logNoticeably("resolveContactNames: parse error " + ex);
         }
      }
      callback(map);
   });
}

// https is used when the transport config row has messageBridgeHttps:true OR its server
// string carries an https:// prefix; otherwise plain http (LAN servers).
function schemeForConfig(cfgRow) {
   if (cfgRow && cfgRow.messageBridgeHttps === true) return "https";
   if (cfgRow && typeof cfgRow.messageBridgeServer === "string" && cfgRow.messageBridgeServer.indexOf("https://") === 0) return "https";
   return "http";
}

var checkCredentialsAssistant = function(future) {};
checkCredentialsAssistant.prototype.run = function(future) {  

     var args = this.controller.args;
     logNoticeably("checkCredentials args =" + JSON.stringify(args));

     //Delete our account username/password from key store
     PalmCall.call("palm://com.palm.keymanager/", "remove", {"keyname" : "BlueBubblesUsername"}).then( function(f2) 
     {
         logNoticeably("Deleted old username");
         PalmCall.call("palm://com.palm.keymanager/", "remove", {"keyname" : "BlueBubblesPassword"}).then( function(f3) 
         {
            logNoticeably("Deleted old password");
            logNoticeably("Confirming new account");
            future.result = {returnValue: true, "credentials": {"common":{ "password" : args.password, "username":args.username}},
                                             "config": { "password" : args.password, "username":args.username} };
         });
     });
};

var onCapabilitiesChangedAssistant = function(future){};
onCapabilitiesChangedAssistant.prototype.run = function(future) { 
   // 
   // Called when an account's capability providers changes. The new state of enabled 
   // capability providers is passed in. This is useful for Synergy services that handle all syncing where 
   // it is easier to do all re-syncing in one step rather than using multiple 'onEnabled' handlers.
   //
   var args = this.controller.args; 
   logNoticeably("onCapabilitiesChanged args =" + JSON.stringify(args));   
   future.result = {returnValue: true};
};

var onCredentialsChangedAssistant = function(future){};
onCredentialsChangedAssistant.prototype.run = function(future) { 
// Called when the user has entered new, valid credentials to replace existing invalid credentials. 
// This is the time to start syncing if you have been holding off due to bad credentials.
   var args = this.controller.args; 
   logNoticeably("onCredentialsChanged args =" + JSON.stringify(args));
   future.result = {returnValue: true};
};

var onCreateAssistant = function(future){};
onCreateAssistant.prototype.run = function(future) {  
// The account has been created. Time to save the credentials contained in the "config" object
// that was emitted from the "checkCredentials" function.
   var args = this.controller.args;
   logNoticeably("onCreateAssistant args =" + JSON.stringify(args));

   //Username/password passed in "config" object
   var B64username = Base64.encode(args.config.username);
   var B64password = Base64.encode(args.config.password);

   var keystore1 = { "keyname":"BlueBubblesUsername", "keydata": B64username, "type": "AES", "nohide":true};
   var keystore2 = { "keyname":"BlueBubblesPassword", "keydata": B64password, "type": "AES", "nohide":true};

   //Save encrypted username/password for syncing.
   PalmCall.call("palm://com.palm.keymanager/", "store", keystore1).then( function(f) 
   {
      if (f.result.returnValue === true)
      {
         logNoticeably("Saved new username");
         PalmCall.call("palm://com.palm.keymanager/", "store", keystore2).then( function(f2) 
         {
            logNoticeably("Saved new password");
            future.result = f2.result;
         });
      }
      else   {
         future.result = f.result;
      }
   });
};

var onEnabledAssistant = function(future){};
onEnabledAssistant.prototype.run = function(future) {  
// Synergy service got 'onEnabled' message. When enabled, a sync should be started and future syncs scheduled.
// Otherwise, syncing should be disabled and associated data deleted.
// Account-wide configuration should remain and only be deleted when onDelete is called.

   var args = this.controller.args;
   logNoticeably("onEnabledAssistant args =" + JSON.stringify(args));
   future.result = {returnValue: true};
   if (args.enabled === true)   //The Accounts UI won't have the option to disable, since we only provide a single service
   {
      PalmCall.call("palm://com.wosa.bluebubbles.service/", "sync", {}).then( function(future) 
      { 
         future.result = future.result;
      });
   }
};

var syncAssistant = function(future){};
syncAssistant.prototype.run = function(future) { 
// Synergy service got 'sync' request. A sync should be started and future syncs scheduled.

   var args = this.controller.args;
   logNoticeably("syncAssistant running with ARGS =" + JSON.stringify(args));
   var username = "";
   var password = "";
   var syncServer = "";
   var syncPort = 8080;
   var useHttps = false;
   var historyLimit = 10;
   var msgQueryLimit = 200;  // recent messages pulled to DISCOVER active chats (chat/query is stale)
   var msgPerThread = 15;    // messages fetched per thread for its history
   var msgBatchThreads = 15; // threads whose messages we fetch per cycle (rest via {more:true} resume)
   var syncInterval = "2m";
   var transportConfigId;
   var storedChatThreads = [];

   //Retrieve config from db8
   var q = {"query":{"from":"com.wosa.bluebubbles.transport:1"}};
   var f = PalmCall.call("palm://com.palm.db/", "find", q).then(function(future) {
      if (future.result.returnValue === true)
      {
         var lastSyncDateTime = calcSyncDateTime();
         // Log sync attempt time
         if(future.result && future.result.results && Array.isArray(future.result.results) && future.result.results.length > 0 && future.result.results[0]._id) {
            //Update existing config record
            transportConfigId = future.result.results[0]._id;
            var syncRec = {"_id":transportConfigId, "lastSync":lastSyncDateTime };
            DB.merge([syncRec]).then(function(logSync) {
               if (logSync.result.returnValue === true)
                  logNoticeably("Logged sync time to existing record in DB8\n");
               else 
                  logNoticeably("FAILED TO LOG sync time to existing record in DB8\n");
            })
         } else {
            //Create config record
            var syncRec = [{ _kind: "com.wosa.bluebubbles.transport:1", "lastSync":lastSyncDateTime}];
            DB.put(syncRec).then(function(logSync) {
               if (logSync.result.returnValue === true)
                  logNoticeably("Logged sync time as new record in DB8\n");
               else 
                  logNoticeably("FAILED TO LOG sync time as new record in DB8\n");
            });
         }
         // Find server info. Pick the transport row that ACTUALLY has a server configured — a
         // stray "lastSync-only" row can exist (a sync that ran before config was saved created
         // one), so don't blindly trust results[0].
         var cfgRow = null;
         if (future.result.results && Array.isArray(future.result.results)) {
            for (var ci=0; ci<future.result.results.length; ci++) {
               if (future.result.results[ci].messageBridgeServer && future.result.results[ci].messageBridgeServer != "") { cfgRow = future.result.results[ci]; break; }
            }
         }
         if (cfgRow) {
            syncServer = cfgRow.messageBridgeServer;
            syncPort = cfgRow.messageBridgePort;
            useHttps = schemeForConfig(cfgRow) === "https";
            // The BlueBubbles server password is collected by the companion app and stored in
            // the transport config (the Accounts-pane password is ignored).
            password = cfgRow.serverPassword || "";
            if (cfgRow.syncInterval)
               syncInterval = cfgRow.syncInterval;
            //Next (in the "future") we'll retrieve our saved username
            return PalmCall.call("palm://com.palm.keymanager/", "fetchKey", {"keyname" : "BlueBubblesUsername"});
         } else {
            logNoticeably("could not find message bridge server in DB8\n");
            //Notify user via app...
            PalmCall.call("palm://com.palm.applicationManager/", "open", {"id": "com.wosa.bluebubbles", "params":{"status":"syncConfigMissing"}});
            future.result = {returnValue: false};
         }
      }
      else {
         logNoticeably("could not find message bridge configuration in DB8\n");
         //Notify user via app...
         PalmCall.call("palm://com.palm.applicationManager/", "open", {"id": "com.wosa.bluebubbles", "params":{"status":"syncConfigMissing"}});
         future.result = {returnValue: false};
      }
   });
   
   //Retrieve our saved username from db8, then go straight to our chat threads.
   //(The password already came from the transport config above — no keymanager hop.)
   f.then(this, function (future) {
      if (future.result.returnValue === true)  //got the username
      {
         username = Base64.decode(f.result.keydata);
         if (syncServer.indexOf("http:") != -1) {  //fix old style
            syncServer = syncServer.replace("http://", "");
            syncServer = syncServer.replace("/chats", "");
            var syncURLParts = syncServer.split(":");
            syncServer = syncURLParts[0];
            syncPort = syncURLParts[1];
         }

         if (syncServer != "") {
            logNoticeably("syncServer="+syncServer +"\n");
            logNoticeably("syncPort="+syncPort +"\n");
            logNoticeably("sync credentials="+username + " - " + password +"\n");

            //Next (in the "future") we'll get our saved chatthreads
            var q = {"from":"com.wosa.bluebubbles.chatthread:1"};
            return DB.find(q, false, false)
         } else {
            logNoticeably("The Sync Server was not defined, so sync cannot proceed");
            future.result = {returnValue: false};
         }
      }
      else {
         logNoticeably("could not find account username in DB8\n");
         future.result = future.result;  // Failure to get account username from Key Manager
      }
   });

   //Retrieve our saved chat threads, then run the WHOLE sync as one batched, in-process flow.
   //SYNERGY LIFECYCLE: the connector is reaped as soon as we set future.result, so we do all the
   //work first (3 direct curl calls) and only signal completion ({more:false}) at the very end in
   //finishSync(). No Luna self-calls to httpRequest, no per-thread syncChat fan-out — those async
   //continuations were getting killed before they ran.
   f.then(this, function(future) {
      if (future.result && future.result.results && future.result.results.length > 0) {
         storedChatThreads = future.result.results;
      }
      logNoticeably("stored chat threads: " + storedChatThreads.length);
      doSync();
   });

   function curlHost() {
      var h = "" + syncServer;
      if (h.indexOf("://") !== -1) h = h.split("://")[1];
      if (h.indexOf(":") !== -1) h = h.split(":")[0];
      return h;
   }
   function baseUrl() {
      return (useHttps ? "https" : "http") + "://" + curlHost() + ":" + syncPort;
   }

   // ---- batched sync. DISCOVERY is driven by message/query, NOT chat/query: BlueBubbles'
   // chat/query lastMessage/sort is STALE (it does not surface the chats with the newest activity),
   // so chat/query-based sync misses new messages entirely. message/query is live and embeds each
   // message's chat (guid, displayName, participants) — everything upsertThreads needs. ----
   function doSync() {
      if (!syncServer) { logNoticeably("doSync: no server configured"); finishSync(false); return; }
      var msgBody = JSON.stringify({limit: msgQueryLimit, offset: 0, "with": ["handle","chat","chat.participants"], sort: "DESC"});
      curlRequest("POST", baseUrl() + "/api/v1/message/query?guid=" + encodeURIComponent(password), msgBody, function(ok, data) {
         var recent = [];
         if (ok) { try { var r = JSON.parse(data); recent = (r && r.data) ? r.data : []; } catch (ex) { logNoticeably("doSync: message/query parse err " + ex); } }
         // Group by chat: the FIRST occurrence of each chat (recent is sorted DESC) is its newest
         // message. Attach a synthetic lastMessage so upsertThreads' delta check works unchanged.
         var seenChat = {};
         var liveChats = [];
         var partAddrs = [];
         var seenP = {};
         for (var i=0;i<recent.length;i++) {
            var m = recent[i];
            var ch = (m.chats && m.chats.length>0) ? m.chats[0] : null;
            if (!ch || !ch.guid || seenChat[ch.guid]) continue;
            seenChat[ch.guid] = true;
            ch.lastMessage = { dateCreated: m.dateCreated, text: (m.text || "") };
            liveChats.push(ch);
            var ps = ch.participants || [];
            for (var p=0;p<ps.length;p++) {
               if (ps[p].address && !seenP[ps[p].address]) { seenP[ps[p].address] = true; partAddrs.push(ps[p].address); }
            }
         }
         logNoticeably("doSync: " + liveChats.length + " active chats from " + recent.length + " recent messages");
         resolveContactNames(curlHost(), syncPort, useHttps, password, partAddrs, function(nameMap) {
            upsertThreads(liveChats, nameMap, function(guidToConv, needFetch) {
               // Per-thread message fetch (each thread gets its own history), only for new/changed
               // threads (delta), batched per cycle to fit the connector window. more=true asks
               // synergy to re-invoke for the rest.
               var batch = needFetch.slice(0, msgBatchThreads);
               var more = needFetch.length > msgBatchThreads;
               logNoticeably("doSync: " + needFetch.length + " threads need messages; fetching " + batch.length + " this cycle (more=" + more + ")");
               fetchThreadMessages(batch, nameMap, 0, function() { finishSync(true, more); });
            });
         });
      });
   }

   // Create/update a chatthread per live chat. callback(guid->convId, needFetch[]). needFetch lists
   // threads whose messages must be (re)fetched: new threads, or threads whose remote last-message
   // time differs from the stored iMessageLastReceived (the delta check).
   function upsertThreads(liveChats, nameMap, done) {
      var guidToConv = {};
      var needFetch = [];
      var pending = liveChats.length;
      if (pending === 0) { done(guidToConv, needFetch); return; }
      function settle() { if (--pending === 0) done(guidToConv, needFetch); }
      function buildDisplayName(chat) {
         var parts = chat.participants || [];
         if (parts.length > 1) {
            if (chat.displayName) return chat.displayName;
            var nl = [];
            for (var j=0;j<parts.length;j++) nl.push(nameMap[contactKeyForAddress(parts[j].address)] || parts[j].address);
            return nl.join(", ");
         }
         var addr = (parts.length>0 && parts[0].address) ? parts[0].address : chat.guid.split(";-;").pop();
         return nameMap[contactKeyForAddress(addr)] || chat.displayName || addr;
      }
      function one(chat) {
         var parts = chat.participants || [];
         var replyAddress = (parts.length>0 && parts[0].address) ? parts[0].address : chat.guid.split(";-;").pop();
         var remoteLastReceived = chat.lastMessage ? chat.lastMessage.dateCreated : 0;
         var displayName = buildDisplayName(chat);
         var summary = chat.lastMessage ? (chat.lastMessage.text || "") : "";
         var existing = null;
         for (var c=0;c<storedChatThreads.length;c++) { if (storedChatThreads[c].iMessageId === chat.guid) { existing = storedChatThreads[c]; break; } }
         if (existing) {
            guidToConv[chat.guid] = existing._id;
            // Fetch when there are new messages (delta) OR the thread's history was never actually
            // populated (messagesPopulated absent — e.g. created by an earlier build that advanced
            // iMessageLastReceived without fetching). This self-heals empty threads.
            if (!existing.messagesPopulated || existing.iMessageLastReceived !== remoteLastReceived) {
               needFetch.push({guid: chat.guid, convId: existing._id, lastReceived: remoteLastReceived});
            }
            DB.merge([{_kind:"com.wosa.bluebubbles.chatthread:1","_id":existing._id, "displayName":displayName, "summary":summary, "timestamp":remoteLastReceived}]).then(function(r){ settle(); });
         } else {
            var dbThread = {
               _kind:"com.wosa.bluebubbles.chatthread:1", flags:{visible:true},
               normalizedAddress: normalizeAddressForContactMatch(replyAddress),
               displayName: displayName, replyAddress: replyAddress, iMessageReplyId: chat.guid,
               replyService: "iMessage", summary: summary, iMessageId: chat.guid,
               timestamp: remoteLastReceived || new Date().getTime(), iMessageLastReceived: 0
            };
            (function(g, lr){
               DB.put([dbThread]).then(function(r){
                  if (r.result.returnValue === true && r.result.results && r.result.results[0]) {
                     var id = r.result.results[0].id;
                     guidToConv[g] = id;
                     needFetch.push({guid: g, convId: id, lastReceived: lr});
                  }
                  settle();
               });
            })(chat.guid, remoteLastReceived);
         }
      }
      for (var i=0;i<liveChats.length;i++) one(liveChats[i]);
   }

   // Fetch + store messages for a batch of threads, ONE thread at a time (sequential — avoids
   // spawning many curl processes at once on the old device). Advances iMessageLastReceived per
   // thread only after a SUCCESSFUL fetch, so a transient failure retries next cycle.
   function fetchThreadMessages(batch, nameMap, idx, done) {
      if (idx >= batch.length) { done(); return; }
      var t = batch[idx];
      var url = baseUrl() + "/api/v1/chat/" + encodeURIComponent(t.guid) + "/message?guid=" + encodeURIComponent(password) + "&with=handle&limit=" + msgPerThread + "&sort=DESC";
      curlRequest("GET", url, null, function(ok, data) {
         var msgs = [];
         if (ok) { try { var r = JSON.parse(data); msgs = (r && r.data) ? r.data : []; } catch (ex) { logNoticeably("fetchThreadMessages: parse err " + ex); } }
         createThreadMessages(t, msgs, nameMap, function() {
            if (ok) {
               DB.merge([{_kind:"com.wosa.bluebubbles.chatthread:1","_id":t.convId, "iMessageLastReceived":t.lastReceived, "messagesPopulated":true}]).then(function(r){
                  fetchThreadMessages(batch, nameMap, idx + 1, done);
               });
            } else {
               logNoticeably("fetchThreadMessages: fetch FAILED for " + t.guid + " (will retry next cycle)");
               fetchThreadMessages(batch, nameMap, idx + 1, done);
            }
         });
      });
   }

   // Dedup against this thread's stored messages (iMessageId is indexed) and create the new ones.
   function createThreadMessages(t, msgs, nameMap, done) {
      DB.find({"from":"com.wosa.bluebubbles.immessage:1","where":[{"prop":"iMessageId","op":"=","val":t.guid}]}, false, false).then(function(fr){
         var have = {};
         if (fr.result && fr.result.results) { for (var s=0;s<fr.result.results.length;s++) have[fr.result.results[s].iDispatchId] = true; }
         var created = 0;
         for (var b=0;b<msgs.length;b++) {
            var d = msgs[b];
            if (have[d.guid]) continue;
            var senderAddr = (d.handle && d.handle.address) ? d.handle.address : null;
            var senderName = senderAddr ? (nameMap[contactKeyForAddress(senderAddr)] || senderAddr) : username;
            var dbMsg = {
               _kind:"com.wosa.bluebubbles.immessage:1", _sync:true,
               flags: d.isFromMe ? {read:true} : {read:false},
               folder: d.isFromMe ? "outbox" : "inbox",
               conversations:[t.convId], localTimestamp: d.dateCreated, messageText: d.text || "",
               serviceName:"iMessage", status:"successful",
               from:[{addr:t.guid, name:senderName}], to:[{addr:username, name:username}],
               username:username, iMessageId:t.guid, iDispatchId:d.guid
            };
            DB.put([dbMsg]);
            created++;
         }
         logNoticeably("createThreadMessages: " + t.guid + " -> " + created + " new of " + msgs.length + " fetched");
         done();
      });
   }

   // Schedule activities, THEN signal completion. more=true tells synergy to re-invoke us for the
   // next batch of threads; more=false means this sync cycle is done.
   function finishSync(okValue, more) {
      logNoticeably("finishSync: scheduling activities; more=" + (more === true));
      PalmCall.call("palm://com.palm.activitymanager/", "create", outboxWatchActivity).then(function(f) {
         logNoticeably("outbox watch activity create result=" + JSON.stringify(f.result));
      });
      PalmCall.call("palm://com.palm.activitymanager/", "create", syncActivity).then(function(f) {
         logNoticeably("periodic sync scheduled every " + syncInterval + "; sync complete (more=" + (more === true) + ")");
         future.result = { returnValue: okValue !== false, more: more === true };
      }, function(f) {
         logNoticeably("FAILED scheduling periodic sync activity");
         future.result = { returnValue: false, more: more === true };
      });
   }

   var syncActivity =
   {
      "start": true,
      "replace": true,
      "activity": {
         "name": "blueBubblesPeriodicSync",
         "description": "Recreate Periodic Sync of incoming messages from iMessage",
         "type": { "background": true, "power": true, "explicit": true, "persist": true },
         "requirements": { "internet": true },
         "schedule": { "precise": true, "interval": syncInterval },
         "callback": {
            "method": "palm://com.wosa.bluebubbles.service/periodicSync",
            "params": {timedSync: true}
         }
      }
   };
   var outboxWatchActivity = {
      "start": true,
      "replace": true,
      "activity": {
         "name": "blueBubblesOutboxWatch",
         "description": "Watch for pending iMessage outbox messages to send",
         "type": { "foreground": true, "power": true, "powerDebounce": true, "explicit": true, "persist": true },
         "requirements": { "internet": true },
         "trigger": {
            "method": "palm://com.palm.db/watch",
            "key": "fired",
            "params": {
               "query": {
                  "from": "com.wosa.bluebubbles.immessage:1",
                  "where": [
                     {"prop": "status", "op": "=", "val": "pending"},
                     {"prop": "folder", "op": "=", "val": "outbox"}
                  ]
               },
               "subscribe": true
            }
         },
         "callback": {
            "method": "palm://com.wosa.bluebubbles.service/processOutbox",
            "params": {}
         }
      }
   };
};

var periodicSync = function(future){}
periodicSync.prototype.run = function(future) {
   logNoticeably("periodicSync run");
   PalmCall.call("palm://com.wosa.bluebubbles.service/", "sync", {timedSync: true});
   PalmCall.call("palm://com.wosa.bluebubbles.service/", "processOutbox", {});
   future.result = { returnValue: true };
};
periodicSync.prototype.complete = function() {
   logNoticeably("periodicSync complete!");
}

// The Synergy framework does not automatically call sendIM when a message is put to the outbox.
// processOutbox finds all pending outbox messages and dispatches each to sendIM. It is called
// both by periodicSync (fallback) and by the blueBubblesOutboxWatch ActivityManager DB-trigger
// activity (immediate response). The complete() method uses restart:true to re-arm the watch.
var processOutbox = function(future){};
processOutbox.prototype.run = function(future) {
   logNoticeably("processOutbox: checking for pending and failed outbox messages");
   var maxRetries = 3;
   var allMessages = [];
   // Index order must match the statusFolder compound index: status first, then folder.
   var pendingQ = {"query": {
      "from": "com.wosa.bluebubbles.immessage:1",
      "where": [
         {"prop": "status", "op": "=", "val": "pending"},
         {"prop": "folder", "op": "=", "val": "outbox"}
      ]
   }};
   var failedQ = {"query": {
      "from": "com.wosa.bluebubbles.immessage:1",
      "where": [
         {"prop": "status", "op": "=", "val": "failed"},
         {"prop": "folder", "op": "=", "val": "outbox"}
      ]
   }};
   var pf = PalmCall.call("palm://com.palm.db/", "find", pendingQ).then(function(f) {
      if (f.result.returnValue === true && f.result.results && f.result.results.length > 0) {
         for (var i = 0; i < f.result.results.length; i++) {
            allMessages.push(f.result.results[i]);
         }
      }
      return PalmCall.call("palm://com.palm.db/", "find", failedQ);
   });
   pf.then(function(f) {
      if (f.result.returnValue === true && f.result.results && f.result.results.length > 0) {
         for (var i = 0; i < f.result.results.length; i++) {
            var msg = f.result.results[i];
            var attempts = msg.sendAttempts || 0;
            if (attempts < maxRetries) {
               logNoticeably("processOutbox: queuing retry for failed _id=" + msg._id + " (attempt " + (attempts + 1) + ")");
               allMessages.push(msg);
            } else {
               logNoticeably("processOutbox: giving up on _id=" + msg._id + " after " + attempts + " failed attempts");
            }
         }
      }
      if (allMessages.length > 0) {
         logNoticeably("processOutbox: dispatching sendIM for " + allMessages.length + " message(s)");
         for (var i = 0; i < allMessages.length; i++) {
            logNoticeably("processOutbox: dispatching sendIM for _id=" + allMessages[i]._id + " text=" + allMessages[i].messageText);
            PalmCall.call("palm://com.wosa.bluebubbles.service/", "sendIM", allMessages[i]);
         }
      } else {
         logNoticeably("processOutbox: no outbox messages to process");
      }
   });
   future.result = {returnValue: true};
};
processOutbox.prototype.complete = function() {
   logNoticeably("processOutbox complete");
   // Re-arm the DB-trigger activity so it fires again on the next pending outbox message.
   // When called via ActivityManager callback, activityId is set; when called directly it is not.
   if (this.controller && this.controller.activityId) {
      logNoticeably("processOutbox: restarting outbox watch activity");
      PalmCall.call("palm://com.palm.activitymanager/", "complete", {
         activityId: this.controller.activityId,
         restart: true
      });
   }
};

var onDeleteAssistant = function(future){};
onDeleteAssistant.prototype.run = function(future) { 
// Account deleted - Synergy service should delete account and config information here.

   var args = this.controller.args;
   logNoticeably("onDelete args =" + JSON.stringify(args));
   future.result = {returnValue: true};

   //Cancel activities (fire and forget)
   PalmCall.call("palm://com.palm.activitymanager/", "cancel", { "activityName":"blueBubblesPeriodicSync" });
   PalmCall.call("palm://com.palm.activitymanager/", "cancel", { "activityName":"blueBubblesOutboxWatch" });

   //Clean up transport, then..
   var q = {"query":{"from":"com.wosa.bluebubbles.transport:1"}};
   var f = PalmCall.call("palm://com.palm.db/", "del", q).then(function(future) 
   {
      if (future.result.returnValue !== true)
         logNoticeably("an error occured cleaning up BlueBubbles sync info");
      else
         logNoticeably("deleted BlueBubbles sync info");
      q ={ "query":{ "from":"com.wosa.bluebubbles.immessage:1" }};
      return PalmCall.call("palm://com.palm.db/", "del", q);
   });

   //Clean up messages, then...
   f.then(this, function (future) {
      if (future.result.returnValue !== true)
         logNoticeably("an error occured cleaning up messages");
      else
         logNoticeably("cleaned up messages");
      q ={ "query":{ "from":"com.wosa.bluebubbles.chatthread:1" }};
      return PalmCall.call("palm://com.palm.db/", "del", q);
   });

   //Clean up chat threads, then...
   f.then(this, function (future) {
      if (future.result.returnValue !== true)
         logNoticeably("an error occured cleaning up chat threads");
      else
         logNoticeably("cleaned up chat threads");
      return PalmCall.call("palm://com.palm.keymanager/", "remove", {"keyname" : "BlueBubblesUsername"});
   });

   //Clean up username, then...
   f.then(this, function (future) {
      if (future.result.returnValue !== true)
         logNoticeably("an error occured removing iMessage Username");
      else
         logNoticeably("removed iMessage Username");
      return PalmCall.call("palm://com.palm.keymanager/", "remove", {"keyname" : "BlueBubblesPassword"}); 
   });

   //Clean up password, then...
   f.then(this, function (future) {
      if (future.result.returnValue !== true)
         logNoticeably("an error occured removing iMessage Password");
      else
         logNoticeably("removed iMessage Password");
      future.result = {returnValue: true};
   });
};

var httpRequestAssistant = function(future){};
httpRequestAssistant.prototype.run = function(future) {
   var args = this.controller.args;

   var host = args.host || "imessageserver";
   var port = args.port || "8080";
   var path = args.path || "/";
   var method = args.method || "GET";
   var body = args.body || null;

   // Scheme can be requested explicitly (scheme:"https" / https:true) or via an https://
   // prefix on the host. Default to http for plain LAN servers.
   var scheme = "http";
   if (args.scheme === "https" || args.https === true) scheme = "https";
   if (host.indexOf("https://") === 0) scheme = "https";

   // Strip any protocol prefix and embedded port from the host (port comes from the port arg).
   if (host.indexOf("://") !== -1) host = host.split("://")[1];
   if (host.indexOf(":") !== -1) host = host.split(":")[0];

   var url = scheme + "://" + host + ":" + port + path;
   curlRequest(method, url, body, function(ok, data, statusCode, info) {
      future.result = {
         returnValue: ok,
         data: data,
         statusCode: statusCode,
         curlError: info ? info.curlError : null,
         stderr: info ? info.stderr : "",
         requestUrl: url,
         file: args.savefile
      };
   });
   return;
}

// Diagnostic probe: resolve the curl binary and report its version/TLS backend so the
// companion app can confirm we're invoking the right curl (and that it exists at all).
var curlCheckAssistant = function(future){};
curlCheckAssistant.prototype.run = function(future) {
   logNoticeably("curlCheck: resolving curl path + version");
   child_process.execFile("which", ["curl"], function(werr, wpath, wstderr) {
      var resolvedPath = (!werr && wpath) ? ("" + wpath).replace(/\n+$/, "") : ("(which curl failed: " + (werr ? werr.code : "no output") + ")");
      child_process.execFile("curl", ["--version"], function(error, stdout, stderr) {
         if (error) {
            logNoticeably("curlCheck: curl --version FAILED code=" + error.code + " msg=" + error.message + " stderr=" + stderr);
            future.result = { returnValue: false, path: resolvedPath, curlError: "" + (error.code !== undefined ? error.code : (error.message || "error")), stderr: (stderr || "") };
         } else {
            logNoticeably("curlCheck: path=" + resolvedPath + " version=" + stdout);
            future.result = { returnValue: true, path: resolvedPath, version: ("" + stdout).replace(/\n+$/, ""), stderr: (stderr || "") };
         }
      });
   });
   return;
}

var sendIM = function(future){};
sendIM.prototype.run = function(future) {
   var args = this.controller.args;
   logNoticeably("sendIM args =" + JSON.stringify(args));

   if (!args || !args.messageText) {
      logNoticeably("sendIM: missing required messageText");
      future.result = {returnValue: false};
      return;
   }

   var syncServer = "";
   var syncPort = 8080;
   var useHttps = false;
   var password = "";
   var messageText = args.messageText;
   var iMessageReplyId = null;
   var conversationDbId = null;
   var iMessageThreadNumericId = null;
   // webOS pre-creates a pending DB8 record and passes its _id here so we can update it.
   // Check multiple possible field names for compatibility.
   var pendingMsgId = args._id || (args.message && args.message._id) || null;
   logNoticeably("sendIM: pendingMsgId=" + pendingMsgId);

   // Step 1: Get transport config (incl. the server password collected by the companion app),
   // then look up the chat thread to get the chatGuid (iMessageReplyId) for the send. The message
   // record has to[0].addr (not a top-level replyAddress field), and args.conversations[0] is the
   // chatthread's DB8 _id — use that for a direct get.
   var q = {"query":{"from":"com.wosa.bluebubbles.transport:1"}};
   var f = PalmCall.call("palm://com.palm.db/", "find", q).then(function(future) {
      if (future.result.returnValue === true && future.result.results && future.result.results.length > 0) {
         syncServer = future.result.results[0].messageBridgeServer;
         syncPort = future.result.results[0].messageBridgePort;
         useHttps = schemeForConfig(future.result.results[0]) === "https";
         password = future.result.results[0].serverPassword || "";
         // Strip any scheme prefix and embedded port from the host (scheme is tracked separately).
         if (syncServer.indexOf("://") !== -1) syncServer = syncServer.split("://")[1];
         if (syncServer.indexOf(":") !== -1) syncServer = syncServer.split(":")[0];
         var conversationsId = (args.conversations && args.conversations.length > 0) ? args.conversations[0] : null;
         if (conversationsId) {
            logNoticeably("sendIM: looking up thread by conversations id=" + conversationsId);
            return PalmCall.call("palm://com.palm.db/", "get", {"ids": [conversationsId]});
         } else {
            // Fallback: search by address (args.replyAddress or args.to[0].addr)
            var lookupAddr = "";
            if (args.replyAddress) {
               lookupAddr = Array.isArray(args.replyAddress) ? args.replyAddress[args.replyAddress.length - 1] : args.replyAddress;
            } else if (args.to && args.to.length > 0) {
               lookupAddr = args.to[0].addr || "";
            }
            logNoticeably("sendIM: looking up thread by replyAddress=" + lookupAddr);
            var threadQuery = {"from":"com.wosa.bluebubbles.chatthread:1", "where":[{"prop":"replyAddress","op":"=","val":lookupAddr}]};
            return DB.find(threadQuery, false, false);
         }
      } else {
         logNoticeably("sendIM: could not find transport config");
         future.result = {returnValue: false};
      }
   });

   // Step 3: POST message to BlueBubbles via curl (handles https/TLS and self-signed certs;
   // execFile avoids shell-quoting issues with arbitrary message text).
   // BlueBubbles sends a text via POST /api/v1/message/text with {chatGuid, tempGuid, message, method}.
   // method "apple-script" works without the Private API; tempGuid just needs to be unique per send.
   f.then(this, function(future) {
      if (!future.result.returnValue) return;
      if (!future.result.results || future.result.results.length === 0) {
         logNoticeably("sendIM: could not find matching chat thread for replyAddress=" + JSON.stringify(args.replyAddress));
         future.result = {returnValue: false};
         return;
      }
      var thread = future.result.results[0];
      iMessageReplyId = thread.iMessageReplyId;
      conversationDbId = thread._id;
      iMessageThreadNumericId = thread.iMessageId;
      logNoticeably("sendIM: posting message to thread " + iMessageReplyId + " via " + syncServer + ":" + syncPort);
      var tempGuid = "webos-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000000);
      var postBody = JSON.stringify({chatGuid: iMessageReplyId, tempGuid: tempGuid, message: messageText, method: "apple-script"});
      logNoticeably("sendIM: POST body=" + postBody);
      var sendUrl = (useHttps ? "https" : "http") + "://" + syncServer + ":" + syncPort + "/api/v1/message/text?guid=" + encodeURIComponent(password);
      var httpFuture = new Future();
      curlRequest("POST", sendUrl, postBody, function(ok, data, statusCode, info) {
         logNoticeably("sendIM: POST status=" + statusCode + " data=" + data + (info && info.curlError ? " curlError=" + info.curlError + " stderr=" + info.stderr : ""));
         httpFuture.result = {returnValue: ok, statusCode: statusCode, data: data};
      });
      return httpFuture;
   });

   // Step 4: Mark the pre-created pending message as successful (or create one if none exists).
   // webOS creates a DB8 record with status:"pending" before calling sendIM and expects us to
   // flip it to "successful" — if we create a new record instead, the original stays stuck forever.
   f.then(this, function(future) {
      if (!future.result.returnValue) {
         logNoticeably("sendIM: POST to BlueBubbles failed");
         if (pendingMsgId) {
            var attempts = (args.sendAttempts || 0) + 1;
            DB.merge([{_kind: "com.wosa.bluebubbles.immessage:1", "_id": pendingMsgId, "status": "failed", "sendAttempts": attempts}]).then(function(r) {
               logNoticeably("sendIM: marked pending message as failed (attempt " + attempts + "), result=" + JSON.stringify(r.result));
            });
         }
         future.result = {returnValue: false};
         return;
      }
      logNoticeably("sendIM: BlueBubbles accepted send, response=" + future.result.data);
      if (pendingMsgId) {
         logNoticeably("sendIM: updating pre-created pending message " + pendingMsgId + " to successful");
         return DB.merge([{_kind: "com.wosa.bluebubbles.immessage:1", "_id": pendingMsgId, "status": "successful"}]);
      } else {
         logNoticeably("sendIM: no pendingMsgId, creating new outbound message record");
         var msgTS = new Date().getTime();
         var recipientAddr = iMessageReplyId ? iMessageReplyId.split(";-;").pop() : "";
         var dbMsg = {
            _kind: "com.wosa.bluebubbles.immessage:1",
            _sync: true,
            flags: {read: true},
            folder: "outbox",
            conversations: [conversationDbId],
            localTimestamp: msgTS,
            messageText: messageText,
            serviceName: "iMessage",
            status: "successful",
            to: [{addr: recipientAddr, name: recipientAddr}],
            iMessageId: iMessageThreadNumericId,
         };
         return DB.put([dbMsg]);
      }
   });

   // Step 5: Update thread summary so the chat list reflects the sent message
   f.then(this, function(future) {
      if (future.result.returnValue === true) {
         logNoticeably("sendIM: stored outbound message in DB8");
         var msgTS = new Date().getTime();
         DB.merge([{_kind:"com.wosa.bluebubbles.chatthread:1", "_id":conversationDbId, "summary":messageText, "timestamp":msgTS}]).then(function(r) {
            logNoticeably("sendIM: updated thread summary");
         });
      } else {
         logNoticeably("sendIM: failed to store outbound message");
      }
      future.result = {returnValue: true};
   });

   future.result = {returnValue: true};
};