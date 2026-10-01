const assert = require("node:assert");
const helper = require("node-red-node-test-helper");
const connectionNode = require("../servicely-connection.js");
const queueNodes = require("../servicely-queue.js");
const { createMockServer, json, text } = require("./helpers/mock-server");

helper.init(require.resolve("node-red"));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe("servicely-queue", function () {
    const server = createMockServer();

    before(() => server.start());
    after(() => server.stop());
    afterEach(() => {
        server.reset();
        return helper.unload();
    });

    function loadFlow(nodes) {
        const flow = [{ id: "conn", type: "servicely-connection", baseUrl: server.baseUrl, queue: "node-red.default.queue", authtype: "token_hmac_header" }].concat(nodes);
        return new Promise(resolve => helper.load([connectionNode, queueNodes], flow, { conn: { apiToken: "tok", apiSecret: "sec" } }, resolve));
    }

    /** A queue node with polling disabled (interval far in the future); tests trigger polls explicitly. */
    async function loadQueue(extra) {
        await loadFlow([
            Object.assign({ id: "q", type: "servicely-queue", connection: "conn", subject: "ping", pollingInterval: 3600, wires: [["out"]] }, extra),
            { id: "out", type: "helper" }
        ]);
        const q = helper.getNode("q");
        clearTimeout(q.timeout_id);
        return { q, out: helper.getNode("out") };
    }

    function dequeueReturns(items) {
        server.handler = (req, res) => json(res, 200, { data: req.body.action === "dequeue" ? items : {} });
    }

    function collect(out, count) {
        return new Promise(resolve => {
            const messages = [];
            out.on("input", msg => {
                messages.push(msg);
                if (messages.length === count) {
                    resolve(messages);
                }
            });
        });
    }

    describe("Queue", function () {
        it("dequeues with the configured subject, batch size and identifier", async function () {
            const { q } = await loadQueue({ requestCount: 5, identifier: "nr-1" });
            q.receive({});
            await wait(200);
            assert.deepStrictEqual(server.requests[0].body, {
                action: "dequeue", identifier: "nr-1", queue: "node-red.default.queue", subject: "ping", request_count: 5
            });
            assert.strictEqual(server.requests[0].url, "/controller/AsyncIntegration");
        });

        it("sends one message per action with reply details and Join-compatible parts", async function () {
            dequeueReturns([{ id: "a1", payload: '{"x":1}' }, { id: "a2", payload: "plain" }, { id: "a3", payload: null }]);
            const { q, out } = await loadQueue();
            const received = collect(out, 3);
            q.receive({});
            const [m1, m2, m3] = await received;

            assert.deepStrictEqual(m1.payload, { x: 1 });
            assert.deepStrictEqual(m1.original_payload_fields, { x: 1 });
            assert.strictEqual(m1._reply_to, "a1");
            assert.strictEqual(m1._connectionNode, "conn");
            assert.strictEqual(m2.payload, "plain");
            assert.strictEqual(m2.original_payload_fields, undefined);
            assert.strictEqual(m3.payload, null);

            assert.ok(m1.parts.id);
            assert.strictEqual(m1.parts.id, m3.parts.id);
            assert.strictEqual(m1.parts.type, "array");
            assert.deepStrictEqual([m1.parts.index, m2.parts.index, m3.parts.index], [0, 1, 2]);
            assert.strictEqual(m1.parts.count, 3);
        });

        it("reports a malformed JSON payload against its message instead of crashing", async function () {
            dequeueReturns([{ id: "bad", payload: "{not json" }, { id: "good", payload: '{"ok":true}' }]);
            const { q, out } = await loadQueue();
            const received = collect(out, 1);
            q.receive({});
            const [good] = await received;

            assert.strictEqual(good._reply_to, "good");
            const call = q.error.getCalls().find(c => /Invalid JSON payload/.test(c.args[0]));
            assert.ok(call, "expected an error for the malformed payload");
            assert.strictEqual(call.args[1]._reply_to, "bad");
        });

        it("reports HTTP errors with the status and backend message", async function () {
            server.handler = (req, res) => json(res, 403, { _error: "Forbidden" });
            const { q } = await loadQueue();
            q.receive({});
            await wait(200);
            const call = q.error.lastCall;
            assert.strictEqual(call.args[0], "Forbidden");
            assert.strictEqual(call.args[1].statusCode, 403);
        });

        it("reports HTML error pages without crashing", async function () {
            server.handler = (req, res) => text(res, 502, "<html>Bad Gateway</html>", "text/html");
            const { q } = await loadQueue();
            q.receive({});
            await wait(200);
            assert.match(q.error.lastCall.args[0], /^502: <html>Bad Gateway/);
        });

        it("never has more than one dequeue in flight", async function () {
            let release;
            server.handler = (req, res) => { release = () => json(res, 200, { data: [] }); };
            const { q } = await loadQueue();
            q.receive({});
            q.receive({});
            q.receive({});
            await wait(200);
            assert.strictEqual(server.requests.length, 1);
            release();
            await wait(100);
            clearTimeout(q.timeout_id);
        });

        it("polls again straight away after a full batch", async function () {
            dequeueReturns([{ id: "a", payload: "1" }, { id: "b", payload: "2" }]);
            const { q } = await loadQueue({ requestCount: 2 });
            q.receive({});
            await wait(300);
            clearTimeout(q.timeout_id);
            q._closed = true;
            assert.ok(server.requests.length >= 2, "expected an immediate follow-up poll, got " + server.requests.length);
        });

        it("stops polling when closed", async function () {
            const { q } = await loadQueue({ pollingInterval: 0.05 });
            q.scheduleNextPoll(0);
            await wait(200);
            await helper.unload();
            const count = server.requests.length;
            await wait(200);
            assert.ok(count >= 1);
            assert.strictEqual(server.requests.length, count);
        });

        it("reports a missing connection at startup", async function () {
            await loadFlow([{ id: "q", type: "servicely-queue", connection: "nope", subject: "ping", pollingInterval: 5, wires: [] }]);
            assert.match(helper.getNode("q").error.lastCall.args[0], /connection is not configured/);
        });
    });

    describe("Success, Failure and Progress", function () {
        const queueMsg = { _connectionNode: "conn", _reply_to: "a1", payload: { result: 1 } };

        async function loadReply(type, extra) {
            await loadFlow([Object.assign({ id: "r", type: type, wires: [["out"]] }, extra), { id: "out", type: "helper" }]);
            return helper.getNode("r");
        }

        it("Success replies with the payload", async function () {
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg));
            await wait(200);
            assert.deepStrictEqual(server.requests[0].body, { reply_to: "a1", action: "success", identifier: "node-red", status: "ok", payload: "{\"result\":1}" });
            assert.ok(r.error.notCalled);
        });

        it("Failure replies with msg.rc.message when a command failed", async function () {
            const r = await loadReply("servicely-failure");
            r.receive(Object.assign({}, queueMsg, { rc: { code: 1, message: "exit 1" } }));
            await wait(200);
            assert.strictEqual(server.requests[0].body.action, "fail");
            assert.strictEqual(server.requests[0].body.status, "error");
            assert.strictEqual(server.requests[0].body.payload, "exit 1");
            assert.strictEqual(server.requests[0].body.error, "exit 1");
        });

        it("Progress sends msg.progress (or the configured message) and passes the message on", async function () {
            const r = await loadReply("servicely-progress", { progressMessage: "configured" });
            const out = helper.getNode("out");
            const passed = new Promise(resolve => out.on("input", resolve));
            r.receive(Object.assign({}, queueMsg, { progress: "50% done" }));
            const msg = await passed;
            await wait(200);
            assert.strictEqual(server.requests[0].body.action, "status");
            assert.strictEqual(server.requests[0].body.payload, "50% done");
            assert.deepStrictEqual(msg.payload, { result: 1 });
        });

        it("Progress passes the message on only once the instance has the update", async function () {
            let respond;
            server.handler = (req, res) => { respond = () => json(res, 200, { data: {} }); };
            const r = await loadReply("servicely-progress");
            const out = helper.getNode("out");
            let passed = false;
            out.on("input", () => { passed = true; });
            r.receive(Object.assign({}, queueMsg, { progress: "step 1" }));
            await wait(200);
            assert.strictEqual(passed, false);
            respond();
            await wait(200);
            assert.strictEqual(passed, true);
        });

        it("Progress doesn't pass the message on when the update fails", async function () {
            server.handler = (req, res) => json(res, 400, { _error: "bad" });
            const r = await loadReply("servicely-progress", { progressMessage: "configured" });
            const out = helper.getNode("out");
            let passed = false;
            out.on("input", () => { passed = true; });
            r.receive(Object.assign({}, queueMsg));
            await wait(200);
            assert.strictEqual(passed, false);
            assert.strictEqual(server.requests[0].body.payload, "configured");
            assert.strictEqual(r.error.lastCall.args[0], "Error on reply: bad");
        });

        it("sends an object or array as JSON text, which Intelligent Actions need", async function () {
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg, { payload: { a: [1, 2] } }));
            await wait(200);
            assert.strictEqual(server.requests[0].body.payload, '{"a":[1,2]}');
            assert.strictEqual(server.requests[0].body.error, undefined);
        });

        it("replies with the identifier the action was claimed by", async function () {
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg, { _original_payload: { id: "a1", claimed_by: "nr-2" } }));
            await wait(200);
            assert.strictEqual(server.requests[0].body.identifier, "nr-2");
        });

        it("Failure sends its description as error: the caught error, else the payload", async function () {
            const r = await loadReply("servicely-failure");
            r.receive(Object.assign({}, queueMsg, { payload: { code: 7 } }));
            r.receive(Object.assign({}, queueMsg, { payload: "original", error: { message: "boom", source: {} } }));
            await wait(200);
            assert.deepStrictEqual(server.requests.map(q => [q.body.payload, q.body.error]), [['{"code":7}', '{"code":7}'], ["original", "boom"]]);
        });

        it("reports HTTP errors from the reply to Catch nodes", async function () {
            server.handler = (req, res) => json(res, 500, { _error: "boom" });
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg));
            await wait(200);
            assert.strictEqual(r.error.lastCall.args[0], "Error on reply (is msg._reply_to an action on this queue?): boom");
            assert.strictEqual(r.error.lastCall.args[1]._reply_to, "a1");
            assert.strictEqual(r.error.lastCall.args[1].statusCode, 500);
        });

        it("reports a missing connection", async function () {
            const r = await loadReply("servicely-failure");
            r.receive({ _reply_to: "a1", payload: "x" });
            await wait(50);
            assert.match(r.error.lastCall.args[0], /Connection node is missing/);
            assert.strictEqual(server.requests.length, 0);
        });
    });
});
