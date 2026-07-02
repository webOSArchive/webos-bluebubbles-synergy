enyo.kind({
	name: "BlueBubbles",
	kind: "VFlexBox",
	defaultServer: "",
	defaultPort: 1234,
	dbConfigId: null,
	useServer:null,
	usePort:null,

	components:[
		{kind: "DbService", dbKind: "enyo.bffs:1", onFailure: "dbFailure", components: [
            {name: "findBffs", method: "find", onSuccess: "findBffsSuccess"},
			{name: "findForSaveBffs", method: "find", onSuccess: "findForSaveBffsSuccess"},
			{name: "putBffs", method: "put", onSuccess: "putBffsSuccess"},
			{name: "mergeBffs", method: "merge", onSuccess: "putBffsSuccess"}   
        ]},
		{kind: "PalmService", name: "launchAppRequest", service: "palm://com.palm.applicationManager/", method: "open", onSuccess: "", onFailure: "" },
		{kind: "PalmService", name: "serviceSyncRequest", service: "palm://com.wosa.bluebubbles.service/", method: "sync", onSuccess: "syncSuccess", onFailure: "syncFailure" },
		{kind: "PalmService", name: "checkServerConnection", service: "palm://com.wosa.bluebubbles.service/", method: "httpRequest", onSuccess: "serverCheckSuccess", onFailure: "serverCheckFailure" },
		{kind: "PalmService", name: "curlCheckRequest", service: "palm://com.wosa.bluebubbles.service/", method: "curlCheck", onSuccess: "curlCheckSuccess", onFailure: "curlCheckFailure" },
		{kind: "ApplicationEvents", onWindowActivated: "handleActivate", onWindowDeactivated: "handleDeactivate", onApplicationRelaunch: "handleLaunchParam"},

		{ kind: "PageHeader", components: [
			{ kind: "Image", name: "headerIcon", src: "icon.png", flex:1, style:"width:32px; height:32px; margin:0px; padding:-10px; margin-right: 8px;" },
			{ name: "titleText", content: "BlueBubbles", style:"margin-top:1px;", flex:1 },
			{ kind: "Spinner", name: "spinner"},
		]},
		
		{kind: "Scroller", flex: 1, className: "box-center", name: "mainscroller", components: [
			{name:"txtServerInfo", className: "footnote-text", style:"margin-top: 14px", content:"iMessage synchronization requires a <a href='https://bluebubbles.app'>BlueBubbles</a> server running on a Mac on your network. Enter the IP or hostname of your server (e.g. 192.168.1.5 on your LAN, or your-name.ngrok.io for a remote tunnel). For TLS, prefix the address with https:// &mdash; self-signed certificates are accepted. Plain http is used if no scheme is given. Set Port to match your server (BlueBubbles defaults to 1234; use 443 for an https tunnel)."},
			{
				kind: "RowGroup",
				caption: "Server",
				pack: "center",
				align: "start",
				class: "enyo-first",
				components: [
					{ name: "imessageServer", kind: "Input", autoCapitalize:"lowercase", autoWordComplete:false, spellcheck:false, autocorrect:false, value: this.defaultServer, pack: "center", align: "start", lazy: false, onchange: "checkServer" },
				]
			},
			{
				kind: "RowGroup",
				caption: "Port",
				pack: "center",
				align: "start",
				components: [
					{ name: "imessagePort", kind: "Input", value: this.defaultPort, pack: "center", align: "start", lazy: false, onchange: "checkPort" },
				]
			},
			{
				kind: "RowGroup",
				caption: "Server Password",
				pack: "center",
				align: "start",
				components: [
					{ name: "imessagePassword", kind: "Input", value: "", inputType: "password", pack: "center", align: "start", lazy: false },
				]
			},
			{name:"txtNote", className: "footnote-text", style:"margin-top: 8px", content:"<b>Note:</b> Secure connections require an updated OpenSSL. Download from the modernize feed in Preware."},
			{kind: "Button", name:"btnSaveConfig", caption:$L("Save"),  onclick:"trySaveSettings"},
			{name:"txtAccountInfo", className: "footnote-text", style:"margin-top: 20px", content:"Complete the setup by creating a BlueBubbles account in webOS Accounts. The password there is not used &mdash; enter any value; the real server password is the one you set above."},
			{kind: "Button", name:"btnConfigAccount", caption:$L("Accounts"), onclick:"launchAccounts"},
			{name:"txtSyncInfo", kind: "HtmlContent", className: "footnote-text", style:"margin-top: 20px", content:"Synchronization is usually automatic, every 3 minutes. If there are issues, or if you've just set the server, manually start the sync here."},
			{kind: "Button", name:"btnSyncNow", caption:$L("Sync Now"), onclick:"doSyncNow", content:"", disabled: true},
			{name:"txtSyncStatus", kind: "HtmlContent", className: "footnote-text", style:"margin-top: 8px"},
			{name:"txtDiagInfo", className: "footnote-text", style:"margin-top: 20px", content:"<b>Troubleshooting.</b> Verify the on-device curl binary and its TLS support, and view the result of the last connection test."},
			{kind: "Button", name:"btnDiagnostics", caption:$L("Run Diagnostics"), onclick:"runDiagnostics"},
			{name:"txtDiagResult", kind: "HtmlContent", className: "footnote-text", style:"margin-top: 8px"},
		]},
		{
            kind: "Helpers.Updater", //Make sure the Updater Helper is included in your depends.json
            name: "myUpdater"
        },

		{kind: "AppMenu", components: [
			{caption: $L("About"), onclick: "showAbout"},
			{caption: $L("Reset"), onclick: "resetToDefaults"},
		]},
		{
            kind: "Dialog",
            name: "alert",
            lazy: false,
            components: [{
                layoutKind: "HFlexLayout",
                pack: "center",
                components: [
                    { name: "alertMsg", kind: "HtmlContent", flex: 1, pack: "center", align: "start", style: "text-align: center;" },
                ]
            }]
        },
	],

	create: function() {
		this.inherited(arguments);
		this.handleLaunchParam();
		this.applySettings();

		this.$.myUpdater.CheckForUpdate("BlueBubbles Synergy");
	},

	handleActivate: function () {
		this.getSyncReadiness();
	},

	handleDeactivate: function () {
	},

	handleLaunchParam: function () {
		enyo.log("BlueBubbles Helper app Launch params: " + JSON.stringify(enyo.windowParams));
	},

	showAbout: function() {
		var aboutMsg = "<div style='padding-bottom:12px;margin:auto 8px'>" + enyo.fetchAppInfo().title + " " + enyo.fetchAppInfo().version;
		if (enyo.fetchAppInfo().copyright)
			aboutMsg += " - " + enyo.fetchAppInfo().copyright;
		else
			aboutMsg += " by " + enyo.fetchAppInfo().vendor
		if (enyo.fetchAppInfo().ossRepo)
			aboutMsg += ". Source code and license available at:<br>" + enyo.fetchAppInfo().ossRepo;
		aboutMsg += "</div>";
		this.$.alertMsg.setContent(aboutMsg);
        this.$.alert.open();
	},
	launchAccounts: function() {
		this.$.launchAppRequest.call({"id": "com.palm.app.accounts", "params":{}});
	},
	checkServer: function() {
		var server = this.$.imessageServer.getValue();
		if (server == "" || server.length < 3) {
			this.$.alertMsg.setContent("Server must be at least 3 characters long!");
			this.$.alert.open();
			return false;
		}
		return true;
	},
	checkPort: function() {
		var valid = true;
		var port = this.$.imessagePort.getValue();
		port = parseInt(port)
		if (isNaN(port)) {
			valid = false;
		}
		if (port < 1 || port > 65535) {
			valid = false;
		}
		if (!valid) {
			this.$.alertMsg.setContent("Port must be a numerical value between 1 and 65535!");
			this.$.alert.open();
			return false;
		}
		return true;
	},
	getSyncReadiness: function() {
		//TODO: This confirms there's ever been a sync, but we should also check if there's CURRENTLY an account
		var q = {"query":{"from":"com.wosa.bluebubbles.transport:1"}};
        this.$.findBffs.call(q);
	},
	findBffsSuccess: function(inSender, inResponse) {
        this.log("DB8 lookup results: " + enyo.json.stringify(inResponse));
		if (inResponse.results && Array.isArray(inResponse.results) && inResponse.results.length >0) {
			var result = inResponse.results[0];
			this.log("DB8 had sync record");
			this.dbConfigId = result._id;
			if (result.lastSync && result.messageBridgeServer && this.$.imessageServer.getValue().length > 3) {
				this.$.btnSyncNow.setDisabled(false);
				var localDate = new Date(result.lastSync.replace("Z", ""));
				this.$.txtSyncStatus.setContent("Last sync attempt: " + this.calcSyncDateTime(localDate));
			}
		}
	},
	trySaveSettings: function() {
		this.$.spinner.show();
		this.saveSettings();
		//Test connection
		this.useServer = this.$.imessageServer.getValue();
		this.usePort = this.$.imessagePort.getValue();
		this.usePassword = this.$.imessagePassword.getValue();

		// Authenticated reachability check against the BlueBubbles ping endpoint. Now that the
		// password is collected here, we pass it as ?guid= so the test validates auth too.
		// Scheme (http/https) is auto-detected by the service from an https:// prefix on host.
		var testQuery = {
			host: this.useServer,
			port: this.usePort,
			path: "/api/v1/ping?guid=" + encodeURIComponent(this.usePassword),
			method: "GET",
			binary: false
		 }
		 enyo.log("Testing server connection with URL: " + JSON.stringify(testQuery));
		 this.$.checkServerConnection.call(testQuery);
		var q = {"query":{"from":"com.wosa.bluebubbles.transport:1"}};
        this.$.findForSaveBffs.call(q);
	},
	findForSaveBffsSuccess: function() {
		//Write settings to DB8 for service to use
		if (!this.dbConfigId) {	//Create record if none existed
			enyo.log("Creating DB config record");
			var syncRec = [{ _kind: "com.wosa.bluebubbles.transport:1", "messageBridgeServer":this.useServer, "messageBridgePort":this.usePort, "serverPassword":this.usePassword}];
			this.$.putBffs.call({objects: syncRec});
		} else {	//Merge record if one already existed
			enyo.log("Updating DB config record with ID: " + this.dbConfigId);
			var syncRec = {"_id":this.dbConfigId, "messageBridgeServer":this.useServer, "messageBridgePort":this.usePort, "serverPassword":this.usePassword };
			this.$.mergeBffs.call({"objects": [syncRec]});
		}
		this.getSyncReadiness();
	},
	serverCheckSuccess: function(inSender, inResponse, inRequest) {
		this.$.spinner.hide();
		enyo.log("Connection test response: " + enyo.json.stringify(inResponse));
		this.$.txtDiagResult.setContent("<b>Last connection test:</b><br>" + this.formatHttpResult(inResponse));
		// returnValue is false on a non-2xx/3xx (e.g. 401 from a wrong password), so an
		// authenticated ping that fails auth reports failure instead of false success.
		if (!inResponse || inResponse == "" || !inResponse.returnValue || !inResponse.data || inResponse.data == "") {
			this.serverCheckFailure(inSender, inResponse);
		} else {
			enyo.windows.addBannerMessage("BlueBubbles connected!", "{}");
		}
	},
	// Also the PalmService onFailure handler — the service returns returnValue:false on any
	// non-2xx/3xx (or curl error), which routes here with the full diagnostic response.
	serverCheckFailure: function(inSender, inResponse) {
		this.$.spinner.hide();
		enyo.log("Connection test FAILED: " + enyo.json.stringify(inResponse));
		var detail = this.formatHttpResult(inResponse);
		this.$.txtDiagResult.setContent("<b>Last connection test (FAILED):</b><br>" + detail);
		var errorMsg = "<div style='padding-bottom:12px;margin:auto 8px'>A test connection to the specified server failed.<br><br>" + detail + "<br><br>Check the server address, port, and password; that the BlueBubbles server is reachable; and (for TLS) that the address begins with https://. Then press Save to re-test.</div>";
		this.$.alertMsg.setContent(errorMsg);
        this.$.alert.open();
	},
	// Build a readable summary from the service's httpRequest response (or a service-call error).
	formatHttpResult: function(r) {
		if (!r || typeof r != "object") return "No response from the sync service &mdash; the background service may not be running.";
		var lines = [];
		if (r.requestUrl) lines.push("<b>URL:</b> " + this.esc(r.requestUrl));
		if (r.statusCode !== undefined) lines.push("<b>HTTP status:</b> " + this.esc(r.statusCode));
		lines.push("<b>ok:</b> " + this.esc(r.returnValue));
		if (r.curlError) lines.push("<b>curl error:</b> " + this.esc(r.curlError) + (("" + r.curlError).indexOf("ENOENT") != -1 ? " &mdash; curl NOT found on PATH!" : ""));
		if (r.stderr) lines.push("<b>curl stderr:</b> " + this.esc(r.stderr));
		if (r.errorText || r.errorCode) lines.push("<b>service error:</b> " + this.esc(r.errorText) + " (" + this.esc(r.errorCode) + ")");
		if (r.data) lines.push("<b>body:</b> " + this.esc(("" + r.data).substring(0, 200)));
		return lines.join("<br>");
	},
	esc: function(s) {
		if (s === undefined || s === null) return "(none)";
		s = ("" + s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		return s.replace(/\n/g, "<br>");
	},
	runDiagnostics: function() {
		this.$.spinner.show();
		enyo.log("Diagnostics: calling curlCheck");
		this.$.txtDiagResult.setContent("Running diagnostics&hellip;");
		this.$.curlCheckRequest.call({});
	},
	curlCheckSuccess: function(inSender, inResponse) {
		this.$.spinner.hide();
		enyo.log("curlCheck response: " + enyo.json.stringify(inResponse));
		var msg;
		if (inResponse && inResponse.returnValue) {
			msg = "<b>curl found at:</b> " + this.esc(inResponse.path) + "<br><b>version:</b><br>" + this.esc(inResponse.version);
		} else {
			msg = "<b>curl is NOT usable.</b><br><b>path:</b> " + this.esc(inResponse && inResponse.path) + "<br><b>error:</b> " + this.esc(inResponse && inResponse.curlError) + "<br><b>stderr:</b> " + this.esc(inResponse && inResponse.stderr);
		}
		this.$.txtDiagResult.setContent(msg);
	},
	curlCheckFailure: function(inSender, inResponse) {
		this.$.spinner.hide();
		enyo.log("curlCheck service call FAILED: " + enyo.json.stringify(inResponse));
		this.$.txtDiagResult.setContent("<b>Diagnostics service call failed</b> &mdash; the background service may not be running.<br>" + this.formatHttpResult(inResponse));
	},
	putBffsSuccess: function(inSender, inResponse) {
        this.log("DB update success, results=" + enyo.json.stringify(inResponse));
    },
    dbFailure: function(inSender, inError, inRequest) {
        enyo.log(enyo.json.stringify(inError));
    },
	doSyncNow:function() {
		this.$.serviceSyncRequest.call({});
	},
	syncSuccess: function(inSender, inResponse) {
		enyo.windows.addBannerMessage("Recurring background sync started!", "{}");
		window.setTimeout(function () {
			this.getSyncReadiness();
		}.bind(this), 2000);
	},
	syncFailure: function(inSender, inResponse) {
		enyo.windows.addBannerMessage("Sync failure!", "{}");
		enyo.log("Background sync failure: " + enyo.json.stringify(inResponse));
		this.getSyncReadiness();
	},

	resetToDefaults: function(inSender) {
		this.$.imessageServer.setValue(this.defaultServer);
		this.$.imessagePort.setValue(this.defaultPort);
		this.$.imessagePassword.setValue("");
		this.saveSettings();
	},
	saveSettings: function() {
		Prefs.setCookie("server", this.$.imessageServer.getValue());
		Prefs.setCookie("port", this.$.imessagePort.getValue());
		Prefs.setCookie("password", this.$.imessagePassword.getValue());
	},
	applySettings: function() {
		this.$.imessageServer.setValue(Prefs.getCookie("server", this.defaultServer));
		this.$.imessagePort.setValue(Prefs.getCookie("port", this.defaultPort));
		this.$.imessagePassword.setValue(Prefs.getCookie("password", ""));
	},
	calcSyncDateTime: function(syncDate)
	{
		var d = syncDate;
		var hour = d.getHours();
		var minutes = d.getMinutes();
		var seconds = d.getSeconds();

		if (seconds < 10) seconds = "0"+seconds;
		if (minutes < 10) minutes = "0"+minutes;
		if (hour < 10)  hour= "0"+hour;

		var syncDateTime = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() +" "+hour+":"+minutes+":"+seconds+""; 
		return(syncDateTime);
	}
});
