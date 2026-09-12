/* Gedeelde Playwright-helpers voor de browsertests. */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function laadPlaywright() {
    try {
        return require("playwright");
    } catch (e) {
        console.error("playwright niet gevonden. Bijvoorbeeld:");
        console.error("  npm install --no-save playwright");
        console.error("  NODE_PATH=<pad>/node_modules node tests/<test>.cjs");
        process.exit(2);
    }
}

// Playwright verwacht zijn eigen browserbuild; pak een Chromium die al in de
// cache staat, ongeacht het versienummer, zodat er niets gedownload wordt.
function chromiumPad() {
    const basis = path.join(os.homedir(), ".cache", "ms-playwright");
    if (!fs.existsSync(basis)) return undefined;
    const mappen = fs
        .readdirSync(basis)
        .filter((d) => d.startsWith("chromium-"))
        .sort()
        .reverse();
    for (const map of mappen) {
        for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
            const pad = path.join(basis, map, sub);
            if (fs.existsSync(pad)) return pad;
        }
    }
    return undefined;
}

module.exports = { laadPlaywright, chromiumPad };
