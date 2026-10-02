/**
 * Editor helpers shared by the Servicely nodes' edit dialogs: validators, the token override (Auth) rows and
 * their Test auth button, instance lookups, and details saved with a node as documentation. Loaded by the
 * nodes' HTML files from resources/node-red-contrib-servicely/servicely-editor.js, before they register.
 */
(function () {
    "use strict";

    if (window.ServicelyEditor) {
        return;
    }

    const AUTH_MODES = ["connection", "bearer", "token_hmac_header", "token_hmac_body"];
    const HMAC_MODES = ["token_hmac_header", "token_hmac_body"];
    const HASH_METHODS = ["md5", "sha1", "sha256", "sha512"];
    const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

    const AUTH_LABELS = {
        password: "Username/Password",
        bearer: "Bearer Token",
        token_hmac_header: "HMAC Header Token",
        token_hmac_body: "HMAC Body Token"
    };

    // The placeholders the runtime substitutes (see renderUri in servicely-common.js)
    const TEMPLATE_PATTERN = /\$\{\s*([^}]*?)\s*\}|<%[=-]\s*([\s\S]*?)\s*%>|<%([\s\S]*?)%>/g;
    const PROPERTY_PATH = /^msg(\.[A-Za-z_$][\w$]*|\[(\d+|"[^"]*"|'[^']*')\])*$/;

    const STYLE = [
        ".servicely-message { margin-left: 105px; font-size: 0.9em; opacity: 0.8; }",
        ".servicely-message.servicely-error { color: var(--red-ui-text-color-error, #d6615f); opacity: 1; }",
        ".servicely-message.servicely-ok { color: var(--red-ui-text-color-success, #3a9a3a); opacity: 1; }",
        ".servicely-message .fa-info-circle { margin-right: 4px; }",
        ".servicely-detail { margin: 0 0 12px 105px; font-size: 0.9em; }",
        ".servicely-table { border-collapse: collapse; margin-bottom: 8px; width: 100%; }",
        ".servicely-table th, .servicely-table td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--red-ui-secondary-border-color, #ddd); vertical-align: top; }",
        ".servicely-table th { font-weight: 600; white-space: nowrap; }",
        ".servicely-heading { font-weight: 600; margin: 6px 0 2px; }",
        ".servicely-warnings { margin: 0 0 8px 16px; color: var(--red-ui-text-color-warning, #b8860b); }",
        ".servicely-actions { margin-bottom: 4px; }",
        ".servicely-source { margin-bottom: 6px; font-style: italic; opacity: 0.8; }",
        // A short prompt under a field, in the edit dialogs
        ".servicely-hint { margin: 3px 0 0 104px; font-size: 0.85em; line-height: 1.35; opacity: 0.7; }",
        ".servicely-hint code { font-size: 1em; color: inherit; background: none; padding: 0; }"
    ].join("\n");
    $("<style>").attr("id", "servicely-editor-style").text(STYLE).appendTo("head");

    /** Validator results: a reason for Node-RED 3.1+, which passes `opt` and shows it, or false for 3.0. */
    function invalid(opt, reason) {
        return opt ? reason : false;
    }

    /** "Date, X-Request-Id" → ["Date", "X-Request-Id"] */
    function headerList(value) {
        return String(value || "").split(",").map(h => h.trim()).filter(Boolean);
    }

    function sameHeaders(a, b) {
        let x = a.map(h => h.toLowerCase()), y = b.map(h => h.toLowerCase());
        return x.length === y.length && x.every((h, i) => h === y[i]);
    }

    /** A validator for a field that may contain ${msg.x} placeholders. */
    function validateTemplate(label) {
        return function (value, opt) {
            let match;
            TEMPLATE_PATTERN.lastIndex = 0;
            while ((match = TEMPLATE_PATTERN.exec(value || "")) !== null) {
                let expression = match[1] !== undefined ? match[1] : match[2];
                if (expression === undefined || !PROPERTY_PATH.test(expression.trim())) {
                    return invalid(opt, label + ": '" + match[0] + "' is not a message property such as ${msg.topic}");
                }
            }
            return true;
        };
    }

    function validateProperty(label) {
        return function (value, opt) {
            return (!value || RED.utils.validatePropertyExpression(value)) ? true : invalid(opt, label + ": not a valid message property");
        };
    }

    /**
     * The override token (and secret for HMAC) must be set. Credentials are only known in the editor once
     * the node has been edited, so nodes that haven't been are not flagged.
     */
    function validateAuthMode(value, opt) {
        if (AUTH_MODES.indexOf(value || "connection") < 0) {
            return invalid(opt, "Auth: unknown mode '" + value + "'");
        }
        let credentials = this.credentials;
        if (value === "connection" || !value || !credentials) {
            return true;
        }
        if (!credentials.apiToken && !credentials.has_apiToken) {
            return invalid(opt, "Token: required for " + AUTH_LABELS[value]);
        }
        if (HMAC_MODES.indexOf(value) >= 0 && !credentials.apiSecret && !credentials.has_apiSecret) {
            return invalid(opt, "Secret: required for " + AUTH_LABELS[value]);
        }
        return true;
    }

    function validateSignedHeaders(value, opt) {
        if (this.authmode !== "token_hmac_header") {
            return true;
        }
        let names = headerList(value);
        if (names.length === 0) {
            return invalid(opt, "Signed headers: at least one header, usually Date");
        }
        let bad = names.find(h => !HEADER_NAME.test(h));
        return bad ? invalid(opt, "Signed headers: '" + bad + "' is not a header name") : true;
    }

    /** The `defaults` entries of a node's token override. */
    function authDefaults() {
        return {
            authmode: { value: "connection", validate: validateAuthMode },
            hash_method: { value: "sha256", validate: (v, opt) => !v || HASH_METHODS.indexOf(v) >= 0 || invalid(opt, "Hash method: unsupported '" + v + "'") },
            signed_headers: { value: "Date", validate: validateSignedHeaders }
        };
    }

    /** The `credentials` of a node's token override. */
    function authCredentials() {
        return {
            apiToken: { type: "password" },
            apiSecret: { type: "password" }
        };
    }

    function formatDate(iso) {
        let date = new Date(iso);
        return isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
    }

    function hasPlaceholder(value) {
        return value.indexOf("${") >= 0 || value.indexOf("<%") >= 0;
    }

    /** Whether saved or retrieved details are those of the name (or id) entered on the node. */
    function matchesName(value, data, nameField) {
        value = (value || "").trim();
        return !!data && value !== "" && (value === data[nameField || "name"] || value === data.id);
    }

    function errorText(xhr) {
        return (xhr.responseJSON && xhr.responseJSON.error) || ("Request failed (" + xhr.status + ")");
    }

    /** A two-column row of a details table. Instance data is only ever added as text. */
    function row(label, value) {
        return $("<tr>").append($("<th>").text(label), $("<td>").text(value == null || value === "" ? "-" : value));
    }

    /** A table with a heading row, built from arrays of cell texts. */
    function table(headings, rows) {
        let result = $("<table>").addClass("servicely-table");
        result.append($("<tr>").append(headings.map(h => $("<th>").text(h))));
        rows.forEach(cells => result.append($("<tr>").append(cells.map(c => $("<td>").text(c == null ? "" : c)))));
        return result;
    }

    function warningList(warnings) {
        let list = $("<ul>").addClass("servicely-warnings");
        warnings.forEach(text => list.append($("<li>").text(text)));
        return list;
    }

    function button(icon, text, title) {
        let result = $('<button type="button" class="red-ui-button red-ui-button-small"></button>');
        result.append($("<i>").addClass("fa " + icon), document.createTextNode(" " + text));
        if (title) {
            result.attr("title", title);
        }
        return result;
    }

    /**
     * The active field mappings of a webhook or transform: {heading, table, sourceFields}, or null when
     * there are none. Inactive mappings are listed by the instance but not applied, so they are left out.
     */
    function mappingsSection(allMappings) {
        allMappings = Array.isArray(allMappings) ? allMappings : [];
        let mappings = allMappings.filter(m => m.active !== false);
        if (!mappings.length) {
            return null;
        }
        let result = table(["Type", "PK", "Source", "Target", "Lookup"], []);
        mappings.forEach(function (m) {
            let lookup = m.lookupTable ? m.lookupTable + "." + (m.lookupField || "") + (m.createOnMissing ? " (create if missing)" : "") : "";
            result.append($("<tr>").attr("title", m.name || "").append(
                $("<td>").text((m.mappingType || "") + (m.hasScript ? " (script)" : "")),
                $("<td>").text(m.primaryKey ? "✓" : ""),
                $("<td>").text(m.sourceField || ""),
                $("<td>").text(m.targetField || ""),
                $("<td>").text(lookup)
            ));
        });
        let inactive = allMappings.length - mappings.length;
        return {
            heading: $("<div>").addClass("servicely-heading").text("Mappings" + (inactive ? " (" + inactive + " inactive not shown)" : "")),
            table: result,
            sourceFields: mappings.map(m => m.sourceField).filter(Boolean)
        };
    }

    /** A button that copies a JSON skeleton with the given fields, as one object or an array of one row. */
    function samplePayloadButton(fields, asArray) {
        let copy = button("fa-clipboard", "Copy sample payload", "Copy a JSON skeleton of the fields");
        copy.on("click", function () {
            let sample = {};
            fields.forEach(f => sample[f] = "");
            RED.clipboard.copyText(JSON.stringify(asArray ? [sample] : sample, null, 2), copy, "clipboard.copyMessageValue");
        });
        return $("<div>").addClass("servicely-actions").append(copy);
    }

    /**
     * Sets up an edit dialog's shared parts. Element ids are the same in every node's template:
     *  - #node-input-connection, and the Auth rows: #node-input-authmode, -apiToken, -apiSecret,
     *    -hash_method, -signed_headers, in rows with the classes servicely-auth-token-row, -secret-row,
     *    -hash-row and -signed-row
     *  - #node-input-servicely-message for lookup messages, and #node-input-servicely-test and
     *    #node-input-servicely-test-result for Test auth
     * `onAuthChange` is called when the auth settings change, e.g. to re-check warnings.
     */
    function dialog(node, onAuthChange) {
        onAuthChange = onAuthChange || function () {};

        $("#node-input-authmode").typedInput({
            types: [{
                value: "authmode",
                options: [
                    { value: "connection", label: "The connection's" },
                    { value: "bearer", label: "Bearer Token" },
                    { value: "token_hmac_header", label: "HMAC Header Token" },
                    { value: "token_hmac_body", label: "HMAC Body Token" }
                ]
            }]
        });

        function authMode() {
            return $("#node-input-authmode").typedInput("value") || "connection";
        }

        $("#node-input-authmode").on("change", function () {
            let mode = authMode();
            let hmac = HMAC_MODES.indexOf(mode) >= 0;
            $(".servicely-auth-token-row").toggle(mode !== "connection");
            $(".servicely-auth-secret-row, .servicely-auth-hash-row").toggle(hmac);
            $(".servicely-auth-signed-row").toggle(mode === "token_hmac_header");
            onAuthChange();
        });
        $("#node-input-hash_method, #node-input-signed_headers").on("change", () => onAuthChange());
        $("#node-input-authmode").trigger("change");

        function connectionId() {
            let id = $("#node-input-connection").val();
            return (id && id !== "_ADD_") ? id : null;
        }

        /** Shows a lookup message: an error, or information (`isInfo`, e.g. an instance too old for lookups). */
        function setMessage(text, isError, isInfo) {
            let element = $("#node-input-servicely-message").text(text || "").toggleClass("servicely-error", !!isError).toggle(!!text);
            if (text && isInfo) {
                element.prepend($("<i>").addClass("fa fa-info-circle"));
            }
        }

        /**
         * Reads from the instance through the deployed connection: GET servicely/<connection>/<path>.
         * An instance without the lookup shows its message without the error styling.
         */
        function discover(path, what, onSuccess) {
            let id = connectionId();
            if (!id) {
                setMessage("Select a connection to look up " + what + ".", true);
                return;
            }
            let connection = RED.nodes.node(id);
            if (connection && connection.changed) {
                setMessage("Deploy the connection's changes first: lookups use the deployed connection.", true);
                return;
            }
            $.getJSON("servicely/" + encodeURIComponent(id) + "/" + path)
                .done(onSuccess)
                .fail(function (xhr) {
                    let unsupported = !!(xhr.responseJSON && xhr.responseJSON.unsupported);
                    setMessage(errorText(xhr), !unsupported, unsupported);
                });
        }

        /** Shows a Test auth result: ok true or false, or neither for information. */
        function setTestResult(text, ok) {
            let element = $("#node-input-servicely-test-result").text(text || "")
                .toggleClass("servicely-error", ok === false)
                .toggleClass("servicely-ok", ok === true)
                .toggle(!!text);
            if (text && ok === null) {
                element.prepend($("<i>").addClass("fa fa-info-circle"));
            }
        }

        /**
         * A credential from the dialog. An unchanged password shows as __PWRD__; when the node has been
         * saved but not deployed, the editor still holds its value, which the runtime doesn't have yet.
         */
        function dialogCredential(name) {
            let value = $("#node-input-" + name).val();
            if (value === "__PWRD__" && node.credentials && node.credentials[name]) {
                return node.credentials[name];
            }
            return value;
        }

        /**
         * Wires the Test auth button to POST servicely/<route>. `fields()` returns the node's own fields to
         * send, and `describe(data)` turns a successful check's data into {text, ok}. `resetOn` lists more
         * inputs whose change clears the result.
         */
        function testAuth(route, fields, describe, resetOn) {
            $("#node-input-servicely-test").on("click", function () {
                let mode = authMode();
                let id = connectionId();
                let connection = id ? RED.nodes.node(id) : null;
                if (mode === "connection" && connection && connection.changed) {
                    setTestResult("Deploy the connection's changes first: the test uses the deployed connection.", false);
                    return;
                }
                setTestResult("Testing…");
                $.ajax({
                    url: "servicely/" + route,
                    type: "POST",
                    contentType: "application/json",
                    dataType: "json",
                    data: JSON.stringify(Object.assign({
                        id: node.id,
                        connection: id,
                        authmode: mode,
                        apiToken: mode === "connection" ? undefined : dialogCredential("apiToken"),
                        apiSecret: HMAC_MODES.indexOf(mode) >= 0 ? dialogCredential("apiSecret") : undefined,
                        hash_method: $("#node-input-hash_method").val(),
                        signed_headers: $("#node-input-signed_headers").val()
                    }, fields()))
                }).done(function (body) {
                    let result = describe((body && body.data) || {});
                    setTestResult(result.text, result.ok);
                }).fail(function (xhr) {
                    // An instance too old for the check is information, not a failed test
                    setTestResult(errorText(xhr), (xhr.responseJSON && xhr.responseJSON.unsupported) ? null : false);
                });
            });
            let inputs = ["authmode", "apiToken", "apiSecret", "hash_method", "signed_headers", "connection"].concat(resetOn || []);
            $(inputs.map(name => "#node-input-" + name).join(", ")).on("change", () => setTestResult(""));
        }

        return {
            authMode: authMode,
            connectionId: connectionId,
            setMessage: setMessage,
            discover: discover,
            testAuth: testAuth
        };
    }

    /**
     * "Authorized: token 'x', runs as y" from a successful auth check's `token` and `effectiveUser`.
     */
    function describeAuthorized(data, extra) {
        let details = [];
        if (data.token && data.token.name) {
            details.push("token '" + data.token.name + "'");
        }
        let user = data.effectiveUser;
        if (user && user.system) {
            details.push("runs as the system user");
        } else if (user && (user.displayName || user.userName)) {
            details.push("runs as " + (user.displayName || user.userName) + (user.userName && user.displayName ? " (" + user.userName + ")" : ""));
        }
        return data.authorized === false ? "Not authorized" : "Authorized" + (details.length ? ": " + details.join(", ") : "") + (extra || "");
    }

    /**
     * Details retrieved from the instance and saved with the node in a hidden `defaults` property as
     * {retrievedAt, data}, so they stay visible as documentation. `panel` is the details element, which
     * holds the copy to save; `saved` is the node's property; `matches(data)` tells whether details are
     * those of what is entered on the node.
     */
    function snapshot(panel, saved, matches) {
        let current = (saved && saved.data) ? saved : null;
        let source = "";
        $(panel).data("snapshot", current);

        return {
            /** Keeps retrieved details. Unchanged ones keep their date, so the node isn't marked as changed. */
            keep: function (data) {
                let unchanged = current != null && JSON.stringify(current.data) === JSON.stringify(data);
                if (!unchanged) {
                    current = { retrievedAt: new Date().toISOString(), data: data };
                }
                $(panel).data("snapshot", current);
                source = unchanged
                    ? "Retrieved from the instance: unchanged since " + formatDate(current.retrievedAt) + "."
                    : "Retrieved from the instance. Saved with the node when you press Done.";
            },
            /** The saved details when they match the node, otherwise null. */
            saved: function () {
                if (current && matches(current.data)) {
                    source = "Saved with the node on " + formatDate(current.retrievedAt) + ". Press refresh to update.";
                    return current.data;
                }
                return null;
            },
            /** Where the details shown came from, as an element for the top of the panel. */
            source: function () {
                return source ? $("<div>").addClass("servicely-source").text(source) : null;
            }
        };
    }

    /** For oneditsave: the details to save, dropped when they are for something other than what is entered. */
    function snapshotToSave(panel, matches) {
        let saved = $(panel).data("snapshot");
        return (saved && matches(saved.data)) ? saved : null;
    }

    window.ServicelyEditor = {
        AUTH_LABELS: AUTH_LABELS,
        HMAC_MODES: HMAC_MODES,
        invalid: invalid,
        headerList: headerList,
        sameHeaders: sameHeaders,
        hasPlaceholder: hasPlaceholder,
        matchesName: matchesName,
        validateTemplate: validateTemplate,
        validateProperty: validateProperty,
        authDefaults: authDefaults,
        authCredentials: authCredentials,
        formatDate: formatDate,
        row: row,
        table: table,
        warningList: warningList,
        button: button,
        mappingsSection: mappingsSection,
        samplePayloadButton: samplePayloadButton,
        dialog: dialog,
        describeAuthorized: describeAuthorized,
        snapshot: snapshot,
        snapshotToSave: snapshotToSave
    };
})();
