const assert = require("node:assert");
const crypto = require("node:crypto");
const helper = require("node-red-node-test-helper");
const connectionNode = require("../servicely-connection.js");
const webhookNode = require("../servicely-webhook.js");
const { createAdminServer } = require("./helpers/admin-server");
const { createMockServer, json, text } = require("./helpers/mock-server");

helper.init(require.resolve("node-red"));

describe("servicely-webhook", function () {
    const server = createMockServer();

    const admin = createAdminServer(helper);

    before(() => Promise.all([server.start(), admin.start()]));
    after(() => Promise.all([server.stop(), admin.stop()]));
    afterEach(() => {
        server.reset();
        return helper.unload();
    });

    /**
     * Loads a connection, the webhook node (id "n") and helper nodes on its outputs ("out", "skipped").
     */
    function load(nodeConfig, credentials) {
        const flow = [
            { id: "conn", type: "servicely-connection", baseUrl: server.baseUrl, authtype: "token_hmac_header" },
            Object.assign({ id: "n", type: "servicely-webhook", connection: "conn", webhook: "alert-ingest", method: "POST", wires: [["out"], ["skipped"]] }, nodeConfig),
            { id: "out", type: "helper" },
            { id: "skipped", type: "helper" }
        ];
        const creds = { conn: { apiToken: "conntok", apiSecret: "connsec" }, n: credentials || {} };
        return new Promise(resolve => helper.load([connectionNode, webhookNode], flow, creds, () => resolve({
            node: helper.getNode("n"), out: helper.getNode("out"), skipped: helper.getNode("skipped")
        })));
    }

    /** Resolves with {msg, port} for the next output message, or rejects with the next error reported by the node. */
    function nextResult(ctx) {
        return new Promise((resolve, reject) => {
            ctx.out.on("input", msg => resolve({ msg: msg, port: 0 }));
            ctx.skipped.on("input", msg => resolve({ msg: msg, port: 1 }));
            ctx.node.on("call:error", call => {
                const err = new Error(String(call.args[0]));
                err.msg = call.args[1];
                reject(err);
            });
        });
    }

    async function run(nodeConfig, msg, credentials) {
        const ctx = await load(nodeConfig, credentials);
        const result = nextResult(ctx);
        ctx.node.receive(msg || { payload: {} });
        return result;
    }

    const STANDARD = {
        timestamp: 1713250000000, webhookKey: "alert-ingest", webhookOperation: "created", webhookTable: "Incident",
        user: { id: "u1" }, record: { id: "r1", Number: "INC0001234" }, warnings: []
    };

    describe("requests", function () {
        it("posts the payload to /_webhook/v2/{key} with the connection's auth", async function () {
            server.handler = (req, res) => json(res, 200, STANDARD);
            const { msg } = await run({}, { payload: { alertId: "a1" } });

            const req = server.requests[0];
            assert.strictEqual(req.method, "POST");
            assert.strictEqual(req.url, "/_webhook/v2/alert-ingest");
            assert.deepStrictEqual(req.body, { alertId: "a1" });
            assert.match(req.headers.authorization, /^HMAC conntok:/);
            assert.deepStrictEqual(msg.payload, STANDARD);
            assert.strictEqual(msg.statusCode, 200);
        });

        it("renders message properties in the key and URL-encodes the result", async function () {
            await run({ webhook: "${msg.topic}" }, { topic: "a/b c", payload: {} });
            assert.strictEqual(server.requests[0].url, "/_webhook/v2/a%2Fb%20c");
        });

        it("uses msg.webhook_key when no webhook is configured", async function () {
            await run({ webhook: "" }, { webhook_key: "from-msg", payload: {} });
            assert.strictEqual(server.requests[0].url, "/_webhook/v2/from-msg");
        });

        it("reports a missing webhook key without calling the instance", async function () {
            await assert.rejects(run({ webhook: "" }, { payload: {} }), /Webhook is not specified/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("sends msg.webhook_params as the query string, repeating array values", async function () {
            await run({ method: "GET" }, { webhook_params: { q: "x y", tag: ["a", "b"], skip: null } });
            assert.strictEqual(server.requests[0].url, "/_webhook/v2/alert-ingest?q=x%20y&tag=a&tag=b");
            assert.strictEqual(server.requests[0].body, undefined);
        });

        it("passes msg.headers through but never lets them replace auth headers", async function () {
            await run({}, { payload: {}, headers: { "X-Source": "monitor", Authorization: "Bearer evil", date: "yesterday" } });
            const headers = server.requests[0].headers;
            assert.strictEqual(headers["x-source"], "monitor");
            assert.match(headers.authorization, /^HMAC conntok:/);
            assert.notStrictEqual(headers.date, "yesterday");
        });

        it("sends a body with DELETE", async function () {
            await run({ method: "DELETE" }, { payload: { id: "1" } });
            assert.strictEqual(server.requests[0].method, "DELETE");
            assert.deepStrictEqual(server.requests[0].body, { id: "1" });
        });

        it("uses the node's Bearer token override", async function () {
            await run({ authmode: "bearer" }, { payload: {} }, { apiToken: "hooktok" });
            assert.strictEqual(server.requests[0].headers.authorization, "Bearer hooktok");
            assert.strictEqual(server.requests[0].url, "/_webhook/v2/alert-ingest");
        });

        it("signs the Date header with the node's HMAC token override", async function () {
            await run({ authmode: "token_hmac_header" }, { payload: {} }, { apiToken: "hooktok", apiSecret: "hooksec" });
            const headers = server.requests[0].headers;
            const signature = crypto.createHmac("sha256", "hooksec").update(headers.date).digest("base64");
            assert.strictEqual(headers.authorization, "HMAC hooktok:" + signature);
        });

        it("uses the token's hash method and signed headers", async function () {
            await run({ authmode: "token_hmac_header", hash_method: "sha1", signed_headers: "Date, X-Request-Id" },
                { payload: {}, headers: { "x-request-id": "r-42" } }, { apiToken: "hooktok", apiSecret: "hooksec" });
            const headers = server.requests[0].headers;
            const signature = crypto.createHmac("sha1", "hooksec").update(headers.date + ":r-42").digest("base64");
            assert.strictEqual(headers.authorization, "HMAC hooktok:" + signature);
            assert.strictEqual(headers["x-request-id"], "r-42");
        });

        it("reports a signed header missing from msg.headers", async function () {
            await assert.rejects(run({ authmode: "token_hmac_header", signed_headers: "Date,X-Request-Id" }, { payload: {} }, { apiToken: "t", apiSecret: "s" }),
                /Signed header 'X-Request-Id' is not set/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("signs method, Content-MD5, Content-Type, Date and the decoded URI for HMAC body", async function () {
            await run({ authmode: "token_hmac_body", webhook: "a b" }, { payload: { alertId: "a1" }, webhook_params: { q: "x y" } },
                { apiToken: "hooktok", apiSecret: "hooksec" });
            const req = server.requests[0];
            const md5 = crypto.createHash("md5").update(JSON.stringify({ alertId: "a1" })).digest("base64");
            assert.strictEqual(req.headers["content-md5"], md5);
            assert.strictEqual(req.headers["content-type"], "application/json");
            const signed = ["POST", md5, "application/json", req.headers.date, "/_webhook/v2/a b?q=x y"].join("\n");
            assert.strictEqual(req.headers.authorization, "HMAC hooktok:" + crypto.createHmac("sha256", "hooksec").update(signed).digest("base64"));
        });

        it("signs empty Content-MD5 and Content-Type for HMAC body requests without a body", async function () {
            await run({ authmode: "token_hmac_body", method: "GET", hash_method: "md5" }, {}, { apiToken: "hooktok", apiSecret: "hooksec" });
            const req = server.requests[0];
            assert.strictEqual(req.headers["content-md5"], undefined);
            const signed = ["GET", "", "", req.headers.date, "/_webhook/v2/alert-ingest"].join("\n");
            assert.strictEqual(req.headers.authorization, "HMAC hooktok:" + crypto.createHmac("md5", "hooksec").update(signed).digest("base64"));
        });

        it("reports a missing override token", async function () {
            await assert.rejects(run({ authmode: "token_hmac_header" }, { payload: {} }, { apiToken: "hooktok" }), /token and secret are not set/);
            assert.strictEqual(server.requests.length, 0);
        });
    });

    describe("responses", function () {
        it("summarises standard responses in msg.webhook", async function () {
            server.handler = (req, res) => json(res, 200, STANDARD);
            const { msg } = await run({});
            assert.deepStrictEqual(msg.webhook, { key: "alert-ingest", skipped: false, operation: "created", table: "Incident", recordId: "r1", warnings: [] });
        });

        it("takes the record id from simple responses", async function () {
            server.handler = (req, res) => json(res, 200, { id: "r2", Number: "INC2", warnings: [] });
            const { msg } = await run({});
            assert.strictEqual(msg.webhook.recordId, "r2");
            assert.strictEqual(msg.webhook.operation, undefined);
        });

        it("accepts plain string results from scripted webhooks", async function () {
            server.handler = (req, res) => text(res, 200, "done");
            const { msg } = await run({});
            assert.strictEqual(msg.payload, "done");
        });

        it("logs warnings returned by the webhook", async function () {
            server.handler = (req, res) => json(res, 200, Object.assign({}, STANDARD, { warnings: ["Unknown field: foo"] }));
            const ctx = await load({});
            const result = nextResult(ctx);
            ctx.node.receive({ payload: {} });
            await result;
            const warning = ctx.node.warn.getCalls().map(c => String(c.args[0])).find(t => t.indexOf("Unknown field") >= 0);
            assert.ok(warning, "expected a warning");
        });

        it("sends skipped responses to the second output when enabled", async function () {
            server.handler = (req, res) => json(res, 200, { skipped: true, reason: "duplicate" });
            const { msg, port } = await run({ skip_output: true, outputs: 2 });
            assert.strictEqual(port, 1);
            assert.deepStrictEqual(msg.webhook, { key: "alert-ingest", skipped: true, reason: "duplicate" });
        });

        it("sends skipped responses to the only output by default", async function () {
            server.handler = (req, res) => json(res, 200, { skipped: true, reason: "duplicate" });
            const { msg, port } = await run({});
            assert.strictEqual(port, 0);
            assert.strictEqual(msg.webhook.skipped, true);
        });

        it("explains 401 responses", async function () {
            server.handler = (req, res) => json(res, 401, { _error: "Unauthorized" });
            const err = await run({}).then(() => null, e => e);
            assert.match(err.message, /^Unauthorized: the token must match the webhook's API token/);
            assert.strictEqual(err.msg.statusCode, 401);
        });

        it("explains 404 responses", async function () {
            server.handler = (req, res) => json(res, 404, { _error: "Webhook not found" });
            await assert.rejects(run({}), /Webhook 'alert-ingest' not found or inactive/);
        });

        it("reports processing errors with their errorId", async function () {
            server.handler = (req, res) => json(res, 500, { _error: "Webhook processing error", _errorId: "tx1" });
            const err = await run({}).then(() => null, e => e);
            assert.strictEqual(err.message, "Webhook processing error (errorId: tx1)");
            assert.strictEqual(err.msg.statusCode, 500);
        });
    });

    describe("discovery", function () {
        const LIST = { data: [{ id: "w1", key: "alert-ingest", name: "Alert ingest", type: "transform", active: true, apiToken: null }] };

        it("proxies the webhook list using the deployed connection's credentials", async function () {
            server.handler = (req, res) => json(res, 200, LIST);
            await load({});
            const res = await admin.request().get("/servicely/conn/webhooks").expect(200);
            assert.deepStrictEqual(res.body, LIST);
            assert.strictEqual(server.requests[0].url, "/_webhook_admin/v2/inbound");
            assert.match(server.requests[0].headers.authorization, /^HMAC conntok:/);
            assert.ok(res.text.indexOf("conntok") < 0 && res.text.indexOf("connsec") < 0);
        });

        it("proxies a webhook's detail by key", async function () {
            server.handler = (req, res) => json(res, 200, { data: { key: "a b", mappings: [] } });
            await load({});
            await admin.request().get("/servicely/conn/webhooks/" + encodeURIComponent("a b")).expect(200);
            assert.strictEqual(server.requests[0].url, "/_webhook_admin/v2/inbound/a%20b");
        });

        it("reports connections that are not deployed", async function () {
            await load({});
            const res = await admin.request().get("/servicely/missing/webhooks").expect(404);
            assert.match(res.body.error, /deploy the connection first/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("flags instances without the discovery endpoint", async function () {
            server.handler = (req, res) => text(res, 404, "<html>Not Found</html>", "text/html");
            await load({});
            const res = await admin.request().get("/servicely/conn/webhooks").expect(404);
            assert.strictEqual(res.body.unsupported, true);
            assert.match(res.body.error, /^Looking up webhooks needs Servicely 1\.11\.122 or later/);
        });

        it("flags older builds that answer with no static resource", async function () {
            await load({});
            for (const status of [500, 404, 400]) {
                server.handler = (req, res) => json(res, status, { message: "No static resource _webhook_admin/v2/inbound." });
                const res = await admin.request().get("/servicely/conn/webhooks").expect(404);
                assert.strictEqual(res.body.unsupported, true, "status " + status);
                assert.match(res.body.error, /needs Servicely 1\.11\.122 or later/);
            }
        });

        it("passes on webhook-not-found errors from the instance", async function () {
            server.handler = (req, res) => json(res, 404, { _error: "Webhook not found" });
            await load({});
            const res = await admin.request().get("/servicely/conn/webhooks/nope").expect(404);
            assert.strictEqual(res.body.error, "Webhook not found");
            assert.strictEqual(res.body.unsupported, undefined);
        });

        it("explains the instance's empty 401", async function () {
            server.handler = (req, res) => text(res, 401, "");
            await load({});
            const res = await admin.request().get("/servicely/conn/webhooks").expect(401);
            assert.match(res.body.error, /check the connection's credentials/);
        });

        it("reports permission errors from the instance", async function () {
            server.handler = (req, res) => json(res, 403, { _error: "Forbidden" });
            await load({});
            const res = await admin.request().get("/servicely/conn/webhooks").expect(403);
            assert.strictEqual(res.body.error, "Forbidden");
        });

        describe("auth test", function () {
            const AUTHORIZED = { data: { authorized: true, token: { name: "Monitoring token" } } };

            function test(body) {
                return admin.request().post("/servicely/webhook-auth-test").send(Object.assign({ id: "n", connection: "conn", webhook: "alert-ingest" }, body));
            }

            it("checks the connection's credentials against the webhook", async function () {
                server.handler = (req, res) => json(res, 200, AUTHORIZED);
                await load({});
                const res = await test({ authmode: "connection" }).expect(200);
                assert.deepStrictEqual(res.body, AUTHORIZED);
                assert.strictEqual(server.requests[0].method, "GET");
                assert.strictEqual(server.requests[0].url, "/_webhook_admin/v2/inbound/alert-ingest/auth-check");
                assert.match(server.requests[0].headers.authorization, /^HMAC conntok:/);
            });

            it("uses a token typed in the dialog", async function () {
                server.handler = (req, res) => json(res, 200, AUTHORIZED);
                await load({});
                await test({ authmode: "bearer", apiToken: "typed" }).expect(200);
                assert.strictEqual(server.requests[0].headers.authorization, "Bearer typed");
            });

            it("uses the deployed node's credentials for unchanged password fields", async function () {
                server.handler = (req, res) => json(res, 200, AUTHORIZED);
                await load({ authmode: "token_hmac_header" }, { apiToken: "hooktok", apiSecret: "hooksec" });
                await test({ authmode: "token_hmac_header", apiToken: "__PWRD__", apiSecret: "__PWRD__" }).expect(200);
                const headers = server.requests[0].headers;
                const signature = crypto.createHmac("sha256", "hooksec").update(headers.date).digest("base64");
                assert.strictEqual(headers.authorization, "HMAC hooktok:" + signature);
            });

            it("signs the auth check with the dialog's HMAC body settings", async function () {
                server.handler = (req, res) => json(res, 200, AUTHORIZED);
                await load({});
                await test({ authmode: "token_hmac_body", apiToken: "t", apiSecret: "s", hash_method: "sha512" }).expect(200);
                const req = server.requests[0];
                const signed = ["GET", "", "", req.headers.date, "/_webhook_admin/v2/inbound/alert-ingest/auth-check"].join("\n");
                assert.strictEqual(req.headers.authorization, "HMAC t:" + crypto.createHmac("sha512", "s").update(signed).digest("base64"));
            });

            it("explains rejected credentials", async function () {
                server.handler = (req, res) => json(res, 401, { _error: "Unauthorized" });
                await load({});
                const res = await test({ authmode: "bearer", apiToken: "wrong" }).expect(401);
                assert.match(res.body.error, /^Unauthorized: the token must match/);
            });

            it("flags instances without the auth check", async function () {
                server.handler = (req, res) => text(res, 404, "", "text/html");
                await load({});
                const res = await test({}).expect(404);
                assert.strictEqual(res.body.unsupported, true);
                assert.match(res.body.error, /^Test auth needs Servicely 1\.11\.122 or later/);
            });

            it("rejects incomplete requests without calling the instance", async function () {
                await load({});
                assert.match((await test({ webhook: "" }).expect(400)).body.error, /Key or id/);
                assert.match((await test({ webhook: "${msg.topic}" }).expect(400)).body.error, /literal Key/);
                assert.match((await test({ connection: "" }).expect(400)).body.error, /Select a connection/);
                assert.match((await test({ connection: "missing" }).expect(400)).body.error, /deploy the connection/);
                assert.match((await test({ authmode: "token_hmac_header", apiToken: "t" }).expect(400)).body.error, /token and secret/);
                assert.strictEqual(server.requests.length, 0);
            });
        });

        it("only proxies for connection nodes", async function () {
            await load({});
            await admin.request().get("/servicely/n/webhooks").expect(404);
            assert.strictEqual(server.requests.length, 0);
        });
    });
});
