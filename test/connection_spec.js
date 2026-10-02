const assert = require("node:assert");
const helper = require("node-red-node-test-helper");
const connectionNode = require("../servicely-connection.js");

helper.init(require.resolve("node-red"));

describe("servicely-connection", function () {
    afterEach(() => helper.unload());

    function load(config, credentials) {
        const flow = [Object.assign({ id: "conn", type: "servicely-connection", baseUrl: "https://x.example/", queue: "q" }, config)];
        return new Promise(resolve => helper.load(connectionNode, flow, credentials ? { conn: credentials } : {}, () => resolve(helper.getNode("conn"))));
    }

    it("reads secrets from Node-RED credentials", async function () {
        const conn = await load({ authtype: "token_hmac_header" }, { apiToken: "tok", apiSecret: "sec" });
        assert.strictEqual(conn.token, "tok");
        assert.strictEqual(conn.secret, "sec");
        assert.strictEqual(conn.authtype, "token_hmac_header");
    });

    it("still honours legacy plain-text properties from older flows, with a warning", async function () {
        const conn = await load({ authtype: "password", username: "u", password: "p" });
        assert.strictEqual(conn.username, "u");
        assert.strictEqual(conn.password, "p");
        assert.ok(conn.warn.calledOnce, "expected a warning about plain-text credentials");
    });

    it("prefers credentials over legacy properties", async function () {
        const conn = await load({ authtype: "password", username: "old", password: "old" }, { user: "new", pass: "new" });
        assert.strictEqual(conn.username, "new");
        assert.strictEqual(conn.password, "new");
        assert.ok(conn.warn.notCalled);
    });

    it("infers HMAC for a legacy connection with no authtype and only a token and secret", async function () {
        const conn = await load({ token: "t", secret: "s" });
        assert.strictEqual(conn.authtype, "token_hmac_header");
    });

    it("infers password for a legacy connection with a username", async function () {
        const conn = await load({ username: "u", password: "p" });
        assert.strictEqual(conn.authtype, "password");
    });

    it("injects the connection id into messages", function (done) {
        const flow = [
            { id: "conn", type: "servicely-connection", baseUrl: "https://x.example/" },
            { id: "inj", type: "servicely-connection-injector", connection: "conn", wires: [["out"]] },
            { id: "out", type: "helper" }
        ];
        helper.load(connectionNode, flow, () => {
            helper.getNode("out").on("input", msg => {
                try {
                    assert.strictEqual(msg._connectionNode, "conn");
                    done();
                } catch (e) {
                    done(e);
                }
            });
            helper.getNode("inj").receive({ payload: 1 });
        });
    });
});
