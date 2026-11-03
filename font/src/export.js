// node src/export.js [params.json] > glyphs.json — 字形の木を JSON で書き出す
const fs = require("fs"), path = require("path");
require(path.join(__dirname, "kana.js"));
const U = require(path.join(__dirname, "glyphs.js"));
const params = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : {};
process.stdout.write(JSON.stringify(U.build(params)));
