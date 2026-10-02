const assert = require("node:assert");
const crypto = require("node:crypto");
const helper = require("node-red-node-test-helper");
const connectionNode = require("../servicely-connection.js");
const restNodes = require("../servicely-rest.js");
const { createAdminServer } = require("./helpers/admin-server");
const { createMockServer, json, text } = require("./helpers/mock-server");

helper.init(require.resolve("node-red"));

describe("servicely-import / servicely-transform auth and discovery", function () {
    const server = createMockServer();

    const admin = createAdminServer(helper);

    before(() => Promise.all([server.start(), admin.start()]));
    after(() => Promise.all([server.stop(), admin.stop()]));
    afterEach(() => {
        server.reset();
        return helper.unload();
    });

    /** Loads a connection, the node under test (id "n") and a helper node on its output ("out"). */
    function load(nodeConfig, credentials) {
        const flow = [
            { id: "conn", type: "servicely-connection", baseUrl: server.baseUrl, authtype: "token_hmac_header" },
            Object.assign({ id: "n", type: "servicely-import", connection: "conn", import_name: "src", import_table: "u_import_alerts", wires: [["out"]] }, nodeConfig),
            { id: "out", type: "helper" }
        ];
        const creds = { conn: { apiToken: "conntok", apiSecret: "connsec" }, n: credentials || {} };
        return new Promise(resolve => helper.load([connectionNode, restNodes], flow, creds, () => resolve({ node: helper.getNode("n"), out: helper.getNode("out") })));
    }

    /** Resolves with the next output message, or rejects with the next error reported by the node. */
    async function run(nodeConfig, msg, credentials) {
        const { node, out } = await load(nodeConfig, credentials);
        const result = new Promise((resolve, reject) => {
            out.on("input", resolve);
            node.on("call:error", call => reject(new Error(String(call.args[0]))));
        });
        node.receive(msg || { payload: [] });
        return result;
    }

    function hmac(secret, value, method) {
        return crypto.createHmac(method || "sha256", secret).update(value).digest("base64");
    }

    describe("token override", function () {
        it("uses the connection's auth by default", async function () {
            await run({}, { payload: [{ a: 1 }] });
            const headers = server.requests[0].headers;
            assert.strictEqual(headers.authorization, "HMAC conntok:" + hmac("connsec", headers.date));
        });

        it("imports with the node's Bearer token", async function () {
            await run({ authmode: "bearer" }, { payload: [{ a: 1 }] }, { apiToken: "imptok" });
            assert.strictEqual(server.requests[0].headers.authorization, "Bearer imptok");
            assert.strictEqual(server.requests[0].url, "/controller/ImportManager");
        });

        it("signs the token's headers, sending those taken from msg.headers", async function () {
            await run({ authmode: "token_hmac_header", hash_method: "sha1", signed_headers: "Date, X-Request-Id" },
                { payload: [], headers: { "x-request-id": "r1", Cookie: "not sent" } }, { apiToken: "t", apiSecret: "s" });
            const headers = server.requests[0].headers;
            assert.strictEqual(headers["x-request-id"], "r1");
            assert.strictEqual(headers.cookie, undefined);
            assert.strictEqual(headers.authorization, "HMAC t:" + hmac("s", headers.date + ":r1", "sha1"));
        });

        it("reports a signed header missing from msg.headers", async function () {
            await assert.rejects(run({ authmode: "token_hmac_header", signed_headers: "Date, X-Request-Id" }, { payload: [] }, { apiToken: "t", apiSecret: "s" }),
                /X-Request-Id' is not set: add it to msg.headers/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("signs the exact body sent for HMAC body transforms", async function () {
            await run({ type: "servicely-transform", transform_name: "Alerts to incidents", authmode: "token_hmac_body" }, {}, { apiToken: "t", apiSecret: "s" });
            const req = server.requests[0];
            const sent = JSON.stringify(req.body);
            const md5 = crypto.createHash("md5").update(sent).digest("base64");
            assert.strictEqual(req.headers["content-md5"], md5);
            const signed = ["POST", md5, "application/json", req.headers.date, "/controller/ImportManager"].join("\n");
            assert.strictEqual(req.headers.authorization, "HMAC t:" + hmac("s", signed));
            assert.deepStrictEqual(req.body, { action: "transform", transform_name: "Alerts to incidents", import_table: "u_import_alerts" });
        });

        it("passes its import table on, for a Transform node without one", async function () {
            const msg = await run({}, { payload: [], transform_name: "from msg" });
            assert.strictEqual(msg.import_table, "u_import_alerts");
            assert.strictEqual(msg.transform_name, "from msg");
        });

        it("passes its transform on, so a Transform node after it needs no settings", async function () {
            const imported = await run({ transform_name: "Alerts to incidents" }, { payload: [] });
            assert.strictEqual(imported.transform_name, "Alerts to incidents");
            await helper.unload();
            server.reset();
            await run({ type: "servicely-transform", import_table: "", transform_name: "" }, imported);
            assert.deepStrictEqual(server.requests[0].body, { action: "transform", transform_name: "Alerts to incidents", import_table: "u_import_alerts" });
        });

        it("refuses to transform without a transform", async function () {
            await assert.rejects(run({ type: "servicely-transform", transform_name: "" }, {}), /transform is not set/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("imports a single object as one row", async function () {
            await run({}, { payload: { AlertId: "A1" } });
            assert.strictEqual(server.requests[0].body.import_data, '[{"AlertId":"A1"}]');
            assert.match(server.requests[0].body.import_metadata, /^\[\{"lastImportTimestamp":"\d+"\}\]$/);
        });

        it("reports an import the instance couldn't load, keeping its result", async function () {
            server.handler = (req, res) => json(res, 200, { data: { success: false, error: "Table not generated" } });
            const { node } = await load({});
            const failed = new Promise(resolve => node.on("call:error", call => resolve(call)));
            node.receive({ payload: [] });
            const call = await failed;
            assert.strictEqual(String(call.args[0]), "Import failed: Table not generated");
            assert.deepStrictEqual(call.args[1].import_result, { success: false, error: "Table not generated" });
        });

        it("reports rows that failed to transform", async function () {
            server.handler = (req, res) => json(res, 200, { data: { success: false, rowFailures: 3, error: "3 row(s) failed to transform", importLoad: { Number: "IMPLOAD0000004", State: "error" } } });
            await assert.rejects(run({ type: "servicely-transform", transform_name: "Load" }, {}),
                /^Error: Transform failed \(IMPLOAD0000004\): 3 row\(s\) failed to transform\. Each row's reason is in the result's importLoad\.Log$/);
        });

        it("explains the instance's error for a name it doesn't know", async function () {
            server.handler = (req, res) => json(res, 500, { _error: "CUSTOM-40001: Custom script error" });
            await assert.rejects(run({}, { payload: [] }), /unknown import table or import source .*: CUSTOM-40001/);
        });

        it("refuses to transform without an import table, which the instance requires", async function () {
            await assert.rejects(run({ type: "servicely-transform", transform_name: "Load", import_table: "" }, {}), /import table is not set/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("reports a missing override token without calling the instance", async function () {
            await assert.rejects(run({ type: "servicely-transform", transform_name: "Load", authmode: "token_hmac_header" }, {}, { apiToken: "t" }), /token and secret are not set on the node/);
            assert.strictEqual(server.requests.length, 0);
        });
    });

    describe("discovery", function () {
        const TABLES = { data: [{ description: "Alerts", id: "t1", name: "u_import_alerts", transformCount: 1, updatedOn: "2026-09-30T01:15:00Z" }] };

        it("lists import tables with the deployed connection's credentials", async function () {
            server.handler = (req, res) => json(res, 200, TABLES);
            await load({});
            const res = await admin.request().get("/servicely/conn/import-tables").expect(200);
            assert.deepStrictEqual(res.body, TABLES);
            assert.strictEqual(server.requests[0].method, "GET");
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/tables");
            assert.match(server.requests[0].headers.authorization, /^HMAC conntok:/);
            assert.ok(res.text.indexOf("conntok") < 0 && res.text.indexOf("connsec") < 0);
        });

        it("reads an import table by name or id", async function () {
            server.handler = (req, res) => json(res, 200, { data: { name: "a b", fields: [] } });
            await load({});
            await admin.request().get("/servicely/conn/import-tables/" + encodeURIComponent("a b")).expect(200);
            await admin.request().get("/servicely/conn/import-tables/7f0000017470170f8174718d30243f03").expect(200);
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/tables/a%20b");
            assert.strictEqual(server.requests[1].url, "/_import_admin/v1/tables/7f0000017470170f8174718d30243f03");
        });

        it("lists transforms, optionally for one import table", async function () {
            await load({});
            await admin.request().get("/servicely/conn/transforms").expect(200);
            await admin.request().get("/servicely/conn/transforms?import_table=u_import_alerts").expect(200);
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/transforms");
            assert.strictEqual(server.requests[1].url, "/_import_admin/v1/transforms?import_table=u_import_alerts");
        });

        it("reads a transform by name, which is unique across the instance", async function () {
            await load({});
            await admin.request().get("/servicely/conn/transforms/" + encodeURIComponent("(Monitoring) Alerts & more") + "?import_table=ignored").expect(200);
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/transforms/(Monitoring)%20Alerts%20%26%20more");
        });

        it("lists import sources", async function () {
            const SOURCES = { data: [{ hasInboundProcessingScript: true, id: "s1", name: "Monitoring feed", type: "inbound" }] };
            server.handler = (req, res) => json(res, 200, SOURCES);
            await load({});
            const res = await admin.request().get("/servicely/conn/import-sources").expect(200);
            assert.deepStrictEqual(res.body, SOURCES);
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/sources");
        });

        it("passes on a name shared by several transforms", async function () {
            server.handler = (req, res) => json(res, 409, { _error: "Several transforms have this name; use its id" });
            await load({});
            const res = await admin.request().get("/servicely/conn/transforms/Load").expect(409);
            assert.strictEqual(res.body.error, "Several transforms have this name; use its id");
        });

        it("passes on a caller without read on the configuration", async function () {
            server.handler = (req, res) => json(res, 403, { _error: "Forbidden" });
            await load({});
            const res = await admin.request().get("/servicely/conn/import-tables").expect(403);
            assert.strictEqual(res.body.error, "Forbidden");
        });

        it("flags instances without the lookups", async function () {
            // An older instance, or a proxy in front of it, may answer without the contract's data
            server.handler = (req, res) => json(res, 200, { result: "ok" });
            await load({});
            const res = await admin.request().get("/servicely/conn/import-tables").expect(404);
            assert.strictEqual(res.body.unsupported, true);
        });

        it("flags instances without the import discovery API", async function () {
            server.handler = (req, res) => text(res, 404, "<html>Not found</html>", "text/html");
            await load({});
            const res = await admin.request().get("/servicely/conn/transforms").expect(404);
            assert.strictEqual(res.body.unsupported, true);
        });

        it("flags older builds, whose web app answers the unknown path", async function () {
            // With Accept: application/json it asks for a login; without, it serves its page
            server.handler = (req, res) => json(res, 401, { loginRequired: true });
            await load({});
            const older = (await admin.request().get("/servicely/conn/import-tables").expect(404)).body;
            assert.strictEqual(older.unsupported, true);
            assert.match(older.error, /^Looking up import tables, sources and transforms needs Servicely 1\.11\.122 or later/);
            server.handler = (req, res) => text(res, 200, "<html>app</html>", "text/html");
            assert.strictEqual((await admin.request().get("/servicely/conn/transforms").expect(404)).body.unsupported, true);
            assert.strictEqual(server.requests[0].headers.accept, "application/json");
        });

        it("reports the connection's rejected credentials", async function () {
            server.handler = (req, res) => text(res, 401, "");
            await load({});
            const res = await admin.request().get("/servicely/conn/import-sources").expect(401);
            assert.match(res.body.error, /^Unauthorized: check the connection's credentials/);
        });

        it("passes on not-found errors from the instance", async function () {
            server.handler = (req, res) => json(res, 404, { _error: "Import table not found" });
            await load({});
            const res = await admin.request().get("/servicely/conn/import-tables/nope").expect(404);
            assert.strictEqual(res.body.error, "Import table not found");
            assert.strictEqual(res.body.unsupported, undefined);
        });
    });

    describe("auth test", function () {
        const AUTHORIZED = { data: { authorized: true, effectiveUser: { displayName: "Integration User", system: false, userName: "integration" }, importTable: { exists: true, name: "u_import_alerts" }, token: { name: "Import token" }, transform: null } };

        function test(route, body) {
            return admin.request().post("/servicely/" + route).send(Object.assign({ id: "n", connection: "conn" }, body));
        }

        it("checks the connection's credentials against the import table", async function () {
            server.handler = (req, res) => json(res, 200, AUTHORIZED);
            await load({});
            const res = await test("import-auth-test", { authmode: "connection", import_table: "u_import_alerts" }).expect(200);
            assert.deepStrictEqual(res.body, AUTHORIZED);
            assert.strictEqual(server.requests[0].method, "GET");
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/auth-check?import_table=u_import_alerts");
            assert.match(server.requests[0].headers.authorization, /^HMAC conntok:/);
        });

        it("checks the credentials alone when no import table is entered", async function () {
            server.handler = (req, res) => json(res, 200, AUTHORIZED);
            await load({});
            await test("import-auth-test", { import_table: "" }).expect(200);
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/auth-check");
        });

        it("checks a typed token against the transform", async function () {
            server.handler = (req, res) => json(res, 200, AUTHORIZED);
            await load({ type: "servicely-transform" });
            await test("transform-auth-test", { authmode: "bearer", apiToken: "typed", import_table: "u_import_alerts", transform_name: "Alerts" }).expect(200);
            assert.strictEqual(server.requests[0].headers.authorization, "Bearer typed");
            assert.strictEqual(server.requests[0].url, "/_import_admin/v1/auth-check?import_table=u_import_alerts&transform_name=Alerts");
        });

        it("uses the deployed node's credentials for unchanged password fields", async function () {
            server.handler = (req, res) => json(res, 200, AUTHORIZED);
            await load({ authmode: "token_hmac_header" }, { apiToken: "imptok", apiSecret: "impsec" });
            await test("import-auth-test", { authmode: "token_hmac_header", apiToken: "__PWRD__", apiSecret: "__PWRD__" }).expect(200);
            const headers = server.requests[0].headers;
            assert.strictEqual(headers.authorization, "HMAC imptok:" + hmac("impsec", headers.date));
        });

        it("signs the query string of the check for HMAC body tokens", async function () {
            server.handler = (req, res) => json(res, 200, AUTHORIZED);
            await load({ type: "servicely-transform" });
            await test("transform-auth-test", { authmode: "token_hmac_body", apiToken: "t", apiSecret: "s", transform_name: "Alerts to incidents" }).expect(200);
            const req = server.requests[0];
            assert.strictEqual(req.url, "/_import_admin/v1/auth-check?transform_name=Alerts%20to%20incidents");
            const signed = ["GET", req.headers["content-md5"] || "", req.headers["content-type"] || "", req.headers.date,
                "/_import_admin/v1/auth-check?transform_name=Alerts to incidents"].join("\n");
            assert.strictEqual(req.headers.authorization, "HMAC t:" + hmac("s", signed));
        });

        it("explains rejected credentials", async function () {
            server.handler = (req, res) => text(res, 401, "");
            await load({});
            const res = await test("import-auth-test", { authmode: "bearer", apiToken: "wrong" }).expect(401);
            assert.match(res.body.error, /^Unauthorized: check the token/);
        });

        it("flags instances without the auth check", async function () {
            server.handler = (req, res) => text(res, 404, "", "text/html");
            await load({});
            const res = await test("transform-auth-test", {}).expect(404);
            assert.strictEqual(res.body.unsupported, true);
            assert.match(res.body.error, /^Test auth needs Servicely 1\.11\.122 or later/);
        });

        it("rejects incomplete requests without calling the instance", async function () {
            await load({});
            assert.match((await test("import-auth-test", { connection: "" }).expect(400)).body.error, /Select a connection/);
            assert.match((await test("import-auth-test", { connection: "missing" }).expect(400)).body.error, /deploy the connection/);
            assert.match((await test("transform-auth-test", { authmode: "token_hmac_body", apiToken: "t" }).expect(400)).body.error, /token and secret/);
            assert.strictEqual(server.requests.length, 0);
        });
    });
});
