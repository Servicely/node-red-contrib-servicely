const assert = require("node:assert");
const helper = require("node-red-node-test-helper");
const connectionNode = require("../servicely-connection.js");
const restNodes = require("../servicely-rest.js");
const { createMockServer, json, text } = require("./helpers/mock-server");

helper.init(require.resolve("node-red"));

describe("servicely-rest", function () {
    const server = createMockServer();

    before(() => server.start());
    after(() => server.stop());
    afterEach(() => {
        server.reset();
        return helper.unload();
    });

    /**
     * Loads a connection, the node under test (id "n") and a helper node wired to its output (id "out").
     */
    function load(nodeConfig, connection) {
        const flow = [
            Object.assign({ id: "conn", type: "servicely-connection", baseUrl: server.baseUrl, authtype: "token_hmac_header" }, connection),
            Object.assign({ id: "n", connection: "conn", wires: [["out"]] }, nodeConfig),
            { id: "out", type: "helper" }
        ];
        return new Promise(resolve => helper.load([connectionNode, restNodes], flow, { conn: { apiToken: "tok", apiSecret: "sec" } },
            () => resolve({ node: helper.getNode("n"), out: helper.getNode("out") })));
    }

    /** Resolves with the next output message, or rejects with the next error reported by the node. */
    function nextResult(node, out) {
        return new Promise((resolve, reject) => {
            out.on("input", msg => resolve(msg));
            node.on("call:error", call => {
                const err = new Error(String(call.args[0]));
                err.msg = call.args[1];
                reject(err);
            });
        });
    }

    async function run(nodeConfig, msg, connection) {
        const { node, out } = await load(Object.assign({ type: "servicely-rest" }, nodeConfig), connection);
        const result = nextResult(node, out);
        node.receive(msg || { payload: {} });
        return result;
    }

    describe("REST", function () {
        it("outputs the response's data field for REST API responses", async function () {
            server.handler = (req, res) => json(res, 200, { data: [{ Number: "INC1" }] });
            const msg = await run({ method: "GET", uri: "/v1/Incident" });
            assert.deepStrictEqual(msg.payload, [{ Number: "INC1" }]);
            assert.strictEqual(msg.statusCode, 200);
            assert.strictEqual(server.requests[0].url, "/v1/Incident");
            assert.match(server.requests[0].headers.authorization, /^HMAC tok:/);
        });

        it("outputs the whole body for Inbound Webhook v2 responses", async function () {
            const webhookResponse = { webhookKey: "k", webhookOperation: "created", record: { id: "1" } };
            server.handler = (req, res) => json(res, 200, webhookResponse);
            const msg = await run({ method: "POST", uri: "/_webhook/v2/k" }, { payload: { a: 1 } });
            assert.deepStrictEqual(msg.payload, webhookResponse);
            assert.deepStrictEqual(server.requests[0].body, { a: 1 });
        });

        it("honours the data and body output modes", async function () {
            server.handler = (req, res) => json(res, 200, { data: 1, other: 2 });
            assert.deepStrictEqual((await run({ method: "GET", uri: "/x", output_mode: "body" })).payload, { data: 1, other: 2 });
            await helper.unload();
            server.handler = (req, res) => json(res, 200, { record: 1 });
            assert.strictEqual((await run({ method: "GET", uri: "/x", output_mode: "data" })).payload, undefined);
        });

        it("reads and writes custom input and output properties", async function () {
            server.handler = (req, res) => json(res, 200, { data: req.body });
            const msg = await run({ method: "PUT", uri: "/x", input_property: "record", output_property: "result.saved" }, { record: { a: 1 } });
            assert.deepStrictEqual(msg.result.saved, { a: 1 });
        });

        it("accepts the lowercase method older versions saved by default", async function () {
            server.handler = (req, res) => json(res, 200, { data: "ok" });
            const msg = await run({ method: "get", uri: "/x" });
            assert.strictEqual(msg.payload, "ok");
            assert.strictEqual(server.requests[0].method, "GET");
        });

        it("URL-encodes templated message properties", async function () {
            const msg = await run({ method: "GET", uri: "/v1/Incident/${msg.id}" }, { id: "a/b" });
            assert.ok(msg);
            assert.strictEqual(server.requests[0].url, "/v1/Incident/a%2Fb");
        });

        it("rejects URI templates that are not plain message properties", async function () {
            await assert.rejects(run({ method: "GET", uri: "/x/${process.pid}" }), /Unsupported URI template/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("reports HTTP errors to Catch nodes with the status code", async function () {
            server.handler = (req, res) => json(res, 500, { _error: "Webhook processing error", _errorId: "e1" });
            const err = await run({ method: "GET", uri: "/x" }).then(() => null, e => e);
            assert.strictEqual(err.message, "Webhook processing error (errorId: e1)");
            assert.strictEqual(err.msg.statusCode, 500);
        });

        it("reports HTML error pages without crashing", async function () {
            server.handler = (req, res) => text(res, 502, "<html>Bad Gateway</html>", "text/html");
            await assert.rejects(run({ method: "GET", uri: "/x" }), /502: <html>Bad Gateway/);
        });

        it("reports non-JSON success responses without crashing", async function () {
            server.handler = (req, res) => text(res, 200, "OK");
            await assert.rejects(run({ method: "GET", uri: "/x" }), /Unexpected non-JSON response/);
        });

        it("handles empty and null success bodies", async function () {
            server.handler = (req, res) => text(res, 200, "null", "application/json");
            assert.strictEqual((await run({ method: "DELETE", uri: "/x" })).payload, undefined);
        });

        it("uses the connection from msg._connectionNode when none is configured", async function () {
            const { node, out } = await load({ type: "servicely-rest", connection: "", method: "GET", uri: "/x" });
            const result = nextResult(node, out);
            node.receive({ _connectionNode: "conn" });
            assert.ok(await result);
        });

        it("reports a missing connection", async function () {
            const { node, out } = await load({ type: "servicely-rest", connection: "", method: "GET", uri: "/x" });
            const result = nextResult(node, out);
            node.receive({});
            await assert.rejects(result, /Servicely Connection is not specified/);
        });

        it("sends Basic auth without putting credentials in the URL", async function () {
            const flow = [
                { id: "conn", type: "servicely-connection", baseUrl: server.baseUrl, authtype: "password" },
                { id: "n", type: "servicely-rest", connection: "conn", method: "GET", uri: "/x", wires: [["out"]] },
                { id: "out", type: "helper" }
            ];
            await new Promise(resolve => helper.load([connectionNode, restNodes], flow, { conn: { user: "svc user", pass: "p@ss:w/rd#1" } }, resolve));
            const result = nextResult(helper.getNode("n"), helper.getNode("out"));
            helper.getNode("n").receive({});
            await result;
            assert.strictEqual(server.requests[0].url, "/x");
            assert.strictEqual(server.requests[0].headers.authorization, "Basic " + Buffer.from("svc user:p@ss:w/rd#1").toString("base64"));
        });
    });

    describe("Import", function () {
        it("posts the payload as import data and leaves msg.payload unchanged", async function () {
            server.handler = (req, res) => json(res, 200, { data: { imported: 2 } });
            const msg = await run({ type: "servicely-import", import_name: "src", import_table: "tbl" }, { payload: [{ a: 1 }, { a: 2 }], import_metadata: { batch: "b1" } });

            const body = server.requests[0].body;
            assert.strictEqual(server.requests[0].url, "/controller/ImportManager");
            assert.strictEqual(body.action, "import");
            assert.strictEqual(body.import_name, "src");
            assert.strictEqual(body.import_table, "tbl");
            assert.deepStrictEqual(JSON.parse(body.import_data), [{ a: 1 }, { a: 2 }]);
            assert.strictEqual(JSON.parse(body.import_metadata)[0].batch, "b1");
            assert.deepStrictEqual(msg.payload, [{ a: 1 }, { a: 2 }]);
            assert.deepStrictEqual(msg.import_result, { imported: 2 });
        });

        it("passes messages through when import_enabled is false", async function () {
            const msg = await run({ type: "servicely-import" }, { payload: 1, import_enabled: false });
            assert.strictEqual(msg.payload, 1);
            assert.strictEqual(server.requests.length, 0);
        });
    });

    describe("Transform", function () {
        it("runs the transform and writes the result to msg.transform_result", async function () {
            server.handler = (req, res) => json(res, 200, { data: { transformed: 2 } });
            const msg = await run({ type: "servicely-transform" }, { payload: "keep", transform_name: "map", import_table: "tbl" });
            assert.deepStrictEqual(server.requests[0].body, { action: "transform", transform_name: "map", import_table: "tbl" });
            assert.strictEqual(msg.payload, "keep");
            assert.deepStrictEqual(msg.transform_result, { transformed: 2 });
        });
    });
});
