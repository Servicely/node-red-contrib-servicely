const js = require("@eslint/js");
const globals = require("globals");
const html = require("eslint-plugin-html");

module.exports = [
    {
        ignores: ["node_modules/", "_docker_config_volume/", "docs/", "examples/"]
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: globals.node
        }
    },
    {
        files: ["test/**/*.js"],
        languageOptions: {
            globals: globals.mocha
        }
    },
    {
        // Scripts the editor loads from resources/
        files: ["resources/**/*.js"],
        languageOptions: {
            sourceType: "script",
            globals: Object.assign({}, globals.browser, globals.jquery, { RED: "readonly" })
        }
    },
    {
        // Editor definitions: inline <script> blocks run in the Node-RED editor
        files: ["**/*.html"],
        plugins: { html },
        languageOptions: {
            sourceType: "script",
            globals: Object.assign({}, globals.browser, globals.jquery, { RED: "readonly" })
        }
    }
];
