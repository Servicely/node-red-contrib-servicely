const assert = require("node:assert");
const crypto = require("node:crypto");
const common = require("../servicely-common.js");
const { createMockServer, json, text } = require("./helpers/mock-server");

describe("servicely-common", function () {

    describe("generateHeaders", function () {
        it("signs the Date header with HMAC-SHA256 for token_hmac_header", function () {
            const headers = common.generateHeaders({ authtype: "token_hmac_header", token: "tok.en", secret: "s3cret" });
            const expected = crypto.createHmac("sha256", "s3cret").update(headers.Date).digest("base64");

            assert.strictEqual(headers.Authorization, "HMAC tok.en:" + expected);
            assert.ok(!isNaN(Date.parse(headers.Date)));
        });

        it("matches a known HMAC signature", function () {
            // Fixed vector (computed with the previous crypto-js implementation's scheme) so a change in
            // the signing scheme is caught
            const realDate = Date.prototype.toUTCString;
            Date.prototype.toUTCString = () => "Wed, 30 Sep 2026 00:00:00 GMT";
            try {
                const headers = common.generateHeaders({ authtype: "token_hmac_header", token: "t", secret: "secret" });
                assert.strictEqual(headers.Authorization, "HMAC t:DgsDVgwKVNvX2TuVZW03qu6iJdIvLC17qPa6n0xJcg0=");
            } finally {
                Date.prototype.toUTCString = realDate;
            }
        });

        it("sends a Bearer token", function () {
            const headers = common.generateHeaders({ authtype: "bearer", token: "abc" });
            assert.strictEqual(headers.Authorization, "Bearer abc");
            assert.strictEqual(headers.Date, undefined);
        });

        it("sends Basic auth, including credentials with URL-special characters", function () {
            const headers = common.generateHeaders({ authtype: "password", username: "svc user", password: "p@ss:w/rd#1" });
            assert.strictEqual(headers.Authorization, "Basic " + Buffer.from("svc user:p@ss:w/rd#1").toString("base64"));
        });

        it("defaults to Basic auth", function () {
            const headers = common.generateHeaders({ username: "u", password: "p" });
            assert.ok(headers.Authorization.startsWith("Basic "));
        });
    });

    describe("resolveAuthType", function () {
        it("keeps an explicit type", function () {
            assert.strictEqual(common.resolveAuthType("bearer", { username: "u" }), "bearer");
        });
        it("infers HMAC for a legacy connection with only a token and secret", function () {
            assert.strictEqual(common.resolveAuthType(undefined, { token: "t", secret: "s" }), "token_hmac_header");
        });
        it("infers password when a username is set", function () {
            assert.strictEqual(common.resolveAuthType(undefined, { username: "u", token: "t", secret: "s" }), "password");
        });
    });

    describe("generateStandardURL", function () {
        it("joins the base URL and path with a single slash", function () {
            assert.strictEqual(common.generateStandardURL({ baseUrl: "https://x.example/" }, "/v1/User"), "https://x.example/v1/User");
            assert.strictEqual(common.generateStandardURL({ baseUrl: "https://x.example" }, "v1/User"), "https://x.example/v1/User");
        });
        it("never puts credentials in the URL", function () {
            const url = common.generateStandardURL({ baseUrl: "https://x.example/", username: "u", password: "p" }, "v1");
            assert.strictEqual(url, "https://x.example/v1");
        });
    });

    describe("renderUri", function () {
        const msg = { id: "a/b?c", payload: { sys: { id: 42 } }, items: [{ name: "n 1" }] };

        it("substitutes and URL-encodes ${msg.x} placeholders", function () {
            assert.strictEqual(common.renderUri("/v1/Incident/${msg.id}", msg), "/v1/Incident/a%2Fb%3Fc");
        });
        it("supports nested and indexed paths", function () {
            assert.strictEqual(common.renderUri("/x/${msg.payload.sys.id}/${msg.items[0].name}", msg), "/x/42/n%201");
        });
        it("supports the <%= msg.x %> form", function () {
            assert.strictEqual(common.renderUri("/x/<%= msg.payload.sys.id %>", msg), "/x/42");
        });
        it("renders missing properties as empty", function () {
            assert.strictEqual(common.renderUri("/x/${msg.nope}", msg), "/x/");
        });
        it("rejects anything that is not a message property", function () {
            assert.throws(() => common.renderUri("/x/${process.exit()}", msg), /Unsupported URI template/);
            assert.throws(() => common.renderUri("/x/<% while(true){} %>", msg), /Unsupported URI template/);
            assert.throws(() => common.renderUri("/x/${msg.id + 1}", msg), /Unsupported URI template/);
        });
        it("leaves URIs without placeholders unchanged", function () {
            assert.strictEqual(common.renderUri("/v1/User?limit=1", msg), "/v1/User?limit=1");
        });
    });

    describe("describeHttpError", function () {
        it("describes the common error shapes", function () {
            assert.strictEqual(common.describeHttpError(401, ""), "HTTP 401");
            assert.strictEqual(common.describeHttpError(502, "<html>Bad Gateway</html>"), "502: <html>Bad Gateway</html>");
            assert.strictEqual(common.describeHttpError(500, { _error: "Webhook processing error", _errorId: "abc" }), "Webhook processing error (errorId: abc)");
            assert.strictEqual(common.describeHttpError(400, { errors: { request: ["bad"] } }), '{"request":["bad"]}');
        });
    });

    describe("sendRequest", function () {
        const server = createMockServer();
        before(() => server.start());
        after(() => server.stop());
        afterEach(() => server.reset());

        function send(options) {
            return new Promise(resolve => common.sendRequest(Object.assign({ method: "GET" }, options), (err, res, body) => resolve({ err, res, body })));
        }

        it("sends JSON and parses JSON responses", async function () {
            server.handler = (req, res) => json(res, 201, { data: { echoed: req.body } });
            const { err, res, body } = await send({ url: server.baseUrl + "x", method: "POST", json: { a: 1 } });
            assert.ifError(err);
            assert.strictEqual(res.statusCode, 201);
            assert.deepStrictEqual(body, { data: { echoed: { a: 1 } } });
            assert.strictEqual(server.requests[0].headers["content-type"], "application/json");
        });

        it("returns non-JSON bodies as text rather than throwing", async function () {
            server.handler = (req, res) => text(res, 502, "<html>Bad Gateway</html>", "text/html");
            const { err, res, body } = await send({ url: server.baseUrl + "x" });
            assert.ifError(err);
            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(body, "<html>Bad Gateway</html>");
        });

        it("does not share cookies between requests", async function () {
            server.handler = (req, res) => { res.writeHead(200, { "Set-Cookie": "JSESSIONID=abc", "Content-Type": "application/json" }); res.end("{}"); };
            await send({ url: server.baseUrl + "x" });
            await send({ url: server.baseUrl + "x" });
            assert.strictEqual(server.requests[1].headers.cookie, undefined);
        });

        it("reports connection failures", async function () {
            const { err } = await send({ url: "http://127.0.0.1:59999/x" });
            assert.match(err.message, /ECONNREFUSED/);
        });

        it("times out", async function () {
            server.handler = () => { /* never respond */ };
            const { err } = await send({ url: server.baseUrl + "x", timeout: 100 });
            assert.match(err.message, /timed out after 100ms/);
        });
    });
});
