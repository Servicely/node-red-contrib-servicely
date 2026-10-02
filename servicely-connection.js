const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    function ServicelyInstance(n) {
        RED.nodes.createNode(this, n);

        this.name = n.name;
        this.baseUrl = n.baseUrl;
        this.queue = n.queue;

        // Secrets are stored as Node-RED credentials. Connections saved by older versions kept them as
        // plain node properties; those are still honoured until the connection is re-saved in the editor.
        let credentials = this.credentials || {};

        this.username = credentials.user || n.username;
        this.password = credentials.pass || n.password;
        this.token = credentials.apiToken || n.token;
        this.secret = credentials.apiSecret || n.secret;

        if (!credentials.pass && !credentials.apiToken && !credentials.apiSecret && (n.password || n.token || n.secret)) {
            this.warn("Credentials for this connection are stored in plain text in the flow. Open and re-save the connection to move them into encrypted credentials.");
        }

        this.authtype = common.resolveAuthType(n.authtype, {
            username: this.username,
            token: this.token,
            secret: this.secret
        });
    }

    function ServicelyConnectionInjector(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg, send, done) {
            msg._connectionNode = config.connection;
            send(msg);
            done();
        });
    }

    RED.nodes.registerType("servicely-connection", ServicelyInstance, {
        credentials: {
            user: { type: "text" },
            pass: { type: "password" },
            apiToken: { type: "password" },
            apiSecret: { type: "password" }
        }
    });
    RED.nodes.registerType("servicely-connection-injector", ServicelyConnectionInjector);
};
