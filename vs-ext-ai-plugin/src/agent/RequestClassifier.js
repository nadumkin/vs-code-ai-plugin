"use strict";
// Heuristic bilingual (ru/en) classifier for user prompts.
// Output: { type, confidence, signals } — purely metadata, never shown in chat.
//
// Categories (priority high → low when tied):
//   bug_fix   — исправление ошибки/упавших тестов
//   test      — написание/прогон тестов
//   refactor  — рефакторинг
//   code_write— написание нового кода
//   explain   — объяснение/документация
//   question  — общий вопрос
//   other     — ничего не подошло

const CATEGORIES = [
  "bug_fix",
  "test",
  "refactor",
  "code_write",
  "explain",
  "question",
  "other",
];

// Each rule: { type, weight, re }
// Order in this list doesn't matter — scoring sums weights per category.
const RULES = [
  // bug_fix
  { type: "bug_fix", weight: 4, re: /\b(fix|debug|patch|repair|resolve)\b/i },
  { type: "bug_fix", weight: 4, re: /\b(bug|error|exception|stack ?trace|crash|fail(ed|ing|ure)?|broken|regression)\b/i },
  { type: "bug_fix", weight: 4, re: /(исправ|почини|пофикс|устран|разбер|поправ|не работает|сломал|поломал|свалил)/iu },
  { type: "bug_fix", weight: 3, re: /(пада[еюя]т|падают|падает|падал[аио]?|упал[аио]?|вывалива)/iu },
  { type: "bug_fix", weight: 3, re: /(тест[ыова]* (?:пада[еюя]т|падают|не прох|упал|свалил))/iu },
  { type: "bug_fix", weight: 3, re: /\b(why (is|does|isn'?t|doesn'?t))\b/i },

  // test
  { type: "test", weight: 4, re: /\b(write|add|create|generate)\b.{0,30}\btests?\b/i },
  { type: "test", weight: 4, re: /\b(unit ?tests?|junit|pytest|jest|mocha|spec(ifications)?)\b/i },
  { type: "test", weight: 3, re: /\b(run|execute)\b.{0,20}\btests?\b/i },
  { type: "test", weight: 3, re: /(напиши|добавь|создай|сгенерируй).{0,30}тест/iu },
  { type: "test", weight: 3, re: /(прогоня|запусти).{0,30}тест/iu },
  { type: "test", weight: 2, re: /\btest coverage\b/i },

  // refactor
  { type: "refactor", weight: 4, re: /\b(refactor|restructure|reorganize|simplify|clean ?up|tidy|deduplicate|extract\b.{0,40}(method|function|class)|rename)\b/i },
  { type: "refactor", weight: 4, re: /(рефактор|почисти|упрост|реорганиз|вынеси|переименуй|перепиши)/iu },
  { type: "refactor", weight: 3, re: /\b(improve|optimi[sz]e)\b/i },
  { type: "refactor", weight: 2, re: /(улучш|оптимизир)/iu },

  // code_write
  { type: "code_write", weight: 4, re: /\b(write|create|implement|build|generate|add)\b.{0,40}\b(function|method|class|module|feature|component|endpoint|route|api|script)\b/i },
  { type: "code_write", weight: 4, re: /(напиши|реализуй|создай|добавь|сгенерируй).{0,60}(функци|метод|класс|модул|компонент|фич|эндпоинт|скрипт)/iu },
  { type: "code_write", weight: 3, re: /\bscaffold\b/i },
  { type: "code_write", weight: 2, re: /\bnew (file|class|function)\b/i },

  // explain
  { type: "explain", weight: 4, re: /\b(explain|describe|document|what does|how does|how is|how do)\b/i },
  { type: "explain", weight: 4, re: /(объясни|опиши|задокументируй|что делает|как работает|как реализован)/iu },
  { type: "explain", weight: 3, re: /\b(summari[sz]e|walk me through|overview)\b/i },
  { type: "explain", weight: 3, re: /(объяснение|краткое описание|разбор)/iu },

  // question
  { type: "question", weight: 2, re: /\?\s*$/ },
  { type: "question", weight: 2, re: /\b(why|where|when|who|which|can|could|should|will|is|are|does|do)\b.{0,80}\?/i },
  { type: "question", weight: 2, re: /(почему|где|когда|кто|зачем|можно ли|можешь ли)/iu },
];

class RequestClassifier {
  classify(prompt) {
    const text = String(prompt || "").trim();
    if (!text) {
      return { type: "other", confidence: 0, signals: [], promptLength: 0 };
    }

    const scores = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    const signals = [];

    for (const rule of RULES) {
      const match = text.match(rule.re);
      if (match) {
        scores[rule.type] += rule.weight;
        signals.push({
          type: rule.type,
          weight: rule.weight,
          match: snippet(match[0], 80),
        });
      }
    }

    // pick the category with highest score; if all zero → other
    let best = "other";
    let bestScore = 0;
    for (const cat of CATEGORIES) {
      if (scores[cat] > bestScore) {
        bestScore = scores[cat];
        best = cat;
      }
    }
    if (bestScore === 0) {
      best = "other";
    }

    // confidence: best score over sum of all (∈ [0,1])
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const confidence = total > 0 ? +(bestScore / total).toFixed(3) : 0;

    return {
      type: best,
      confidence,
      signals,
      scores,
      promptLength: text.length,
    };
  }
}

function snippet(s, n) {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

module.exports = {
  RequestClassifier,
  CATEGORIES,
};
