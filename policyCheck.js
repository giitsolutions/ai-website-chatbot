"use strict";

/*
    Deterministic policy checks.

    A small language model is unreliable at comparing a visitor's situation with
    a rule ("I bought it 45 days ago" vs "refundable within 30 days"). When the
    situation and a matching rule can both be read unambiguously, the comparison
    is computed here instead of by the model. Nothing is specific to one website:
    rules are read from the retrieved website text, and answers quote them.

    evaluatePolicyQuestion(question, chunks) returns null (not a comparison this
    module can decide; the model answers normally) or:
      { kind, eligible, ruleText, chunkIndex, explanation, answer }
    kind:
      "window"       a time limit compared with the elapsed time   eligible true/false
      "exclusion"    the product is excluded ("not refundable")    eligible false
      "cap"          an amount compared with a maximum             eligible true/false
      "needs-detail" the question is ambiguous (no product, two
                     products, or too close to the limit to tell)  eligible null
      "undetermined" the website has rules, but none for this      eligible null
                     product; the caller shows the standard fallback
*/

const NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15,
    twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60, ninety: 90
};
const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const NUMBER = "(\\d+(?:\\.\\d+)?|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty|forty-five|forty|fifty|sixty|ninety)";
const UNIT = "(day|week|month|year)s?";
// Months and years are converted approximately; this close to a limit, ask instead.
const APPROXIMATE_MARGIN_DAYS = 3;

// Questions this module may decide: refunds, cancellations, returns, claims, eligibility.
const POLICY_TOPIC = /\b(refund\w*|money back|return\w*|cancel\w*|eligib\w*|qualify|claim\w*|reimburs\w*|cover(ed|s)?|warranty|exchange\w*)\b/i;
const REFUND_TOPIC = /\b(refund\w*|money back|return\w*|reimburs\w*)\b/i;

const STOP = new Set([
    "the", "and", "for", "can", "get", "you", "your", "our", "still", "will", "would", "could", "should", "have",
    "has", "had", "bought", "buy", "purchased", "ordered", "paid", "pay", "ago", "since",
    "day", "days", "week", "weeks", "month", "months", "year", "years", "with", "this", "that", "what", "when",
    "how", "are", "was", "were", "been", "refund", "refunds", "refunded", "refundable", "money", "back",
    "return", "returned", "cancel", "cancelled", "canceled", "eligible", "qualify", "full", "within", "after",
    "before", "only", "most", "all", "any", "from", "about", "receive", "request", "claim", "cover", "covered",
    "covers", "much", "able", "there", "here", "too", "late", "possible", "allowed", "policy", "need", "want",
    "did", "does", "not", "ask", "who", "which", "may", "might", "just", "yet", "now", "today", "last", "ever"
]);

// Words that do not name a product, so they cannot pick a rule.
const GENERIC = new Set([
    "something", "anything", "product", "products", "item", "items", "thing", "things", "stuff",
    "service", "services", "subscription", "subscriptions", "account", "purchase", "purchases", "order", "orders"
]);

function toNumber(value) {
    const key = String(value).toLowerCase();
    return key in NUMBER_WORDS ? NUMBER_WORDS[key] : Number(value);
}

function unitOf(unit) {
    return unit.toLowerCase().replace(/s$/, "");
}

function toDays(amount, unit) {
    return Math.round(toNumber(amount) * UNIT_DAYS[unitOf(unit)]);
}

// "45 days ago", "3 weeks ago", "it has been 10 days", "after 40 days", "had it for 2 weeks".
function parseElapsed(question) {
    const patterns = [
        new RegExp(`\\b${NUMBER}\\s+${UNIT}\\s+(?:ago|back|earlier)\\b`, "i"),
        new RegExp(`\\b(?:it\\s+(?:has|'s)\\s+been|been|after)\\s+${NUMBER}\\s+${UNIT}\\b`, "i"),
        new RegExp(`\\bhad\\b[^.?!]{0,30}?\\bfor\\s+${NUMBER}\\s+${UNIT}\\b`, "i"),
        new RegExp(`\\b${NUMBER}\\s+${UNIT}\\s+(?:since|after)\\b`, "i")
    ];
    for (const pattern of patterns) {
        const match = String(question).match(pattern);
        if (match) {
            const days = toDays(match[1], match[2]);
            if (Number.isFinite(days) && days >= 0) {
                return { days, approximate: !["day", "week"].includes(unitOf(match[2])), text: match[0].trim() };
            }
        }
    }
    return null;
}

// "$250", "250 USD", "USD 250", "250 dollars".
function parseAmount(text) {
    const match = String(text).match(/\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars)\b|\busd\s?(\d[\d,]*(?:\.\d+)?)/i);
    if (!match) return null;
    return Number(String(match[1] || match[2] || match[3]).replace(/,/g, ""));
}

function words(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
        .filter(word => word.length >= 3 && !/^\d+$/.test(word) && !STOP.has(word));
}

// "certificates" and "certificate" share a stem; so do "registration" and "registered".
function stem(word) {
    return word.replace(/(es|s)$/, "").slice(0, 5);
}

// The visitor's words that the rule line names.
function overlap(questionWords, line) {
    const stems = new Set(words(line).map(stem));
    return new Set(questionWords.filter(word => stems.has(stem(word))));
}

// One rule per bullet or sentence, remembering which chunk it came from.
function ruleLines(chunks) {
    const lines = [];
    chunks.forEach((chunk, chunkIndex) => {
        const body = String(chunk || "").replace(/^[^\n]*:\n/, "");
        for (const rawLine of body.split(/\n|(?<=\.)\s+(?=[A-Z])/)) {
            const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
            if (line.length >= 8) lines.push({ line, chunkIndex });
        }
    });
    return lines;
}

function classifyRule(line) {
    const exclusion = /\b(not refundable|non-refundable|cannot be refunded|can't be refunded|are not eligible|is not eligible|no refunds?|are excluded|is excluded)\b/i.test(line);
    const within = line.match(new RegExp(`\\bwithin\\s+(?:the\\s+first\\s+)?${NUMBER}\\s+${UNIT}\\b`, "i"));
    const after = line.match(new RegExp(`\\bafter\\s+${NUMBER}\\s+${UNIT}\\b`, "i"));
    const cap = line.match(/\b(?:up to|maximum of|at most|no more than)\s+(\$\s?|usd\s?)?(\d[\d,]*(?:\.\d+)?)/i);
    // A rule with a vague scope ("most products") is not precise enough to decide with.
    const vague = /\b(most|many|some|usually|generally|typically|often)\b/i.test(line);

    if (within) return { type: "window", days: toDays(within[1], within[2]), vague };
    // "Annual plans cancelled after 30 days: no refund" is a 30-day window too.
    if (after && exclusion) return { type: "window", days: toDays(after[1], after[2]), vague };
    if (exclusion) return { type: "exclusion", vague };
    if (cap) return { type: "cap", amount: Number(cap[2].replace(/,/g, "")), currency: cap[1] ? "$" : "", vague };
    return null;
}

function quote(line) {
    return `"${line.replace(/\s+/g, " ").trim().replace(/"/g, "'")}"`;
}

function needsDetail(rules, reason) {
    const listed = rules.slice(0, 4);
    return {
        kind: "needs-detail",
        eligible: null,
        ruleText: listed.map(rule => rule.line).join("\n"),
        chunkIndex: listed[0].chunkIndex,
        explanation: reason,
        answer: `It depends on the details of your purchase. The policy says: ${listed.map(rule => quote(rule.line)).join(" ")} ` +
            "Please tell me which product it was and exactly how many days ago you bought it."
    };
}

function evaluatePolicyQuestion(question, chunks) {
    const text = String(question || "");
    if (!POLICY_TOPIC.test(text)) return null;

    const elapsed = parseElapsed(text);
    const amount = parseAmount(text);
    const asksRefund = REFUND_TOPIC.test(text);
    // Without a date, an amount or a refund question there is nothing to decide here.
    if (!elapsed && amount === null && !asksRefund) return null;

    const productWords = words(text).filter(word => !GENERIC.has(word));
    const rules = ruleLines(chunks)
        .map(entry => ({ ...entry, rule: classifyRule(entry.line) }))
        .filter(entry => entry.rule && !entry.rule.vague);
    if (!rules.length) return null;

    const matching = rules
        .map(entry => {
            const named = overlap(productWords, entry.line);
            return { ...entry, named, score: named.size };
        })
        .filter(entry => entry.score > 0);
    const ranked = (type) => matching.filter(entry => entry.rule.type === type).sort((a, b) => b.score - a.score);
    const [exclusion] = ranked("exclusion");
    const windows = ranked("window");
    const [cap] = ranked("cap");
    const timeRules = rules.filter(entry => entry.rule.type !== "cap");

    // 1. An exclusion that names the product overrides any general time window.
    if (asksRefund && exclusion && (!windows.length || exclusion.score >= windows[0].score)) {
        return {
            kind: "exclusion",
            eligible: false,
            ruleText: exclusion.line,
            chunkIndex: exclusion.chunkIndex,
            explanation: `The matching rule ${quote(exclusion.line)} excludes this product, so it is not eligible whatever the date.`,
            answer: `This is not eligible for a refund. The policy says: ${quote(exclusion.line)}`
        };
    }

    // 2. A time limit compared with the elapsed time.
    if (elapsed) {
        // No product named ("something I bought"): ask which one.
        if (!productWords.length) {
            return timeRules.length ? needsDetail(timeRules, "The question does not say which product was bought.") : null;
        }

        if (windows.length) {
            const [window] = windows;
            // Another rule with a different limit names a product the best rule does not:
            // the visitor mentioned two products ("hosting and an SSL certificate").
            const other = windows.find(entry => entry.rule.days !== window.rule.days &&
                [...entry.named].some(word => !window.named.has(word)));
            if (other) {
                return needsDetail([window, other], "The question matches two rules with different time limits.");
            }
            const limit = window.rule.days;
            if (elapsed.approximate && Math.abs(elapsed.days - limit) <= APPROXIMATE_MARGIN_DAYS) {
                return needsDetail([window], `"${elapsed.text}" is about ${elapsed.days} days, too close to the ${limit}-day limit to decide.`);
            }
            const eligible = elapsed.days <= limit;
            return {
                kind: "window",
                eligible,
                ruleText: window.line,
                chunkIndex: window.chunkIndex,
                explanation: `The visitor said "${elapsed.text}" (${elapsed.days} days). The matching rule is ${quote(window.line)}: a ${limit}-day limit. ` +
                    `${elapsed.days} ${eligible ? "<=" : ">"} ${limit}, so the visitor is ${eligible ? "" : "not "}eligible.`,
                answer: eligible
                    ? `You are still within the time limit. The policy says: ${quote(window.line)} You bought it ${elapsed.days} days ago, which is within that ${limit}-day period.`
                    : `You are past the time limit, so you are no longer eligible. The policy says: ${quote(window.line)} You bought it ${elapsed.days} days ago, which is more than ${limit} days.`
            };
        }
    }

    // 3. An amount compared with a maximum ("up to $200").
    if (amount !== null && cap) {
        const limit = cap.rule.amount;
        const money = value => `${cap.rule.currency}${value}`;
        const eligible = amount <= limit;
        return {
            kind: "cap",
            eligible,
            ruleText: cap.line,
            chunkIndex: cap.chunkIndex,
            explanation: `The visitor asked about ${money(amount)}. The matching rule is ${quote(cap.line)}: a maximum of ${money(limit)}. ` +
                `${amount} ${eligible ? "<=" : ">"} ${limit}.`,
            answer: eligible
                ? `That amount is within the limit. The policy says: ${quote(cap.line)}`
                : `Not in full. The policy says: ${quote(cap.line)} So at most ${money(limit)} is covered, not ${money(amount)}.`
        };
    }

    // 4. The website lists concrete rules, but none names this product.
    if (elapsed && productWords.length && timeRules.length && !matching.length) {
        return {
            kind: "undetermined",
            eligible: null,
            ruleText: "",
            chunkIndex: -1,
            explanation: `No rule on the website names "${productWords.join(" ")}".`,
            answer: null
        };
    }

    return null;
}

module.exports = { evaluatePolicyQuestion, parseElapsed, parseAmount };
