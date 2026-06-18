"use strict";
// Full 2^3 ablation matrix over the three mechanisms.
//   iterative — agent loop + ./gradlew compile feedback (build tools available)
//   memory    — QKV similar-diff memory (src/memory/*)
//   rag       — ContextCollector retrieval of imports/related sources

function name(axes) {
  return `it${axes.iterative ? 1 : 0}_mem${axes.memory ? 1 : 0}_rag${axes.rag ? 1 : 0}`;
}

const CONFIGS = [];
for (const iterative of [false, true]) {
  for (const memory of [false, true]) {
    for (const rag of [false, true]) {
      const axes = { iterative, memory, rag };
      CONFIGS.push({ name: name(axes), axes });
    }
  }
}

module.exports = { CONFIGS, name };
