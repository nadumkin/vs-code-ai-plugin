"use strict";
// Intercept `require("vscode")` so the agent core (src/*) loads our headless
// shim instead of the real editor API. Require THIS module before requiring
// any src/* module.

const Module = require("module");
const shim = require("./vscode-shim");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return shim;
  }
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = shim;
