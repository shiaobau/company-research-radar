import { readFile } from "node:fs/promises";

export async function loadEventTaxonomy(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function normalizedTitle(event) {
  return String(event?.title || "").replace(/\s+/g, " ").trim();
}

function firstMatch(title, categories) {
  for (const category of categories || []) {
    const matchedPatterns = (category.patterns || []).filter((pattern) => title.includes(pattern));
    if (matchedPatterns.length) return { category, matchedPatterns };
  }
  return null;
}

export function classifyMaterialEvent(event, taxonomy) {
  const title = normalizedTitle(event);
  const reviewMatch = firstMatch(title, taxonomy?.review_categories);
  if (reviewMatch && taxonomy?.matching?.review_overrides_negative !== false) {
    return {
      ...event,
      sentiment: "review",
      risk_class: "review",
      risk_category: reviewMatch.category.id,
      risk_category_label: reviewMatch.category.label,
      risk_points: 0,
      matched_patterns: reviewMatch.matchedPatterns
    };
  }

  const negativeMatch = firstMatch(title, taxonomy?.negative_categories);
  if (negativeMatch) {
    return {
      ...event,
      sentiment: "negative",
      risk_class: "negative",
      risk_category: negativeMatch.category.id,
      risk_category_label: negativeMatch.category.label,
      risk_points: Number(negativeMatch.category.risk_points || 0),
      matched_patterns: negativeMatch.matchedPatterns
    };
  }

  return {
    ...event,
    sentiment: event?.sentiment || "neutral",
    risk_class: "neutral",
    risk_category: null,
    risk_category_label: null,
    risk_points: 0,
    matched_patterns: []
  };
}

export function classifyMaterialEvents(events, taxonomy) {
  const tagged = (events || []).map((event) => classifyMaterialEvent(event, taxonomy));
  const negativeEvents = tagged.filter((event) => event.risk_class === "negative");
  const reviewEvents = tagged.filter((event) => event.risk_class === "review");
  const categories = Object.fromEntries(negativeEvents.reduce((acc, event) => {
    acc.set(event.risk_category, (acc.get(event.risk_category) || 0) + 1);
    return acc;
  }, new Map()));
  return {
    events: tagged,
    negative_event_count: negativeEvents.length,
    review_event_count: reviewEvents.length,
    negative_event_points: negativeEvents.reduce((sum, event) => sum + Number(event.risk_points || 0), 0),
    negative_event_categories: categories
  };
}

export function thresholdScore(value, definition) {
  const bands = definition?.bands || [];
  if (definition?.direction === "lower") {
    const match = [...bands].sort((left, right) => Number(left.max) - Number(right.max))
      .find((band) => value <= Number(band.max));
    return match ? Number(match.score) : null;
  }
  const match = [...bands].sort((left, right) => Number(right.min) - Number(left.min))
    .find((band) => value >= Number(band.min));
  return match ? Number(match.score) : null;
}

export function scoreRiskDimension(record, riskDefinition) {
  const submetrics = riskDefinition?.submetrics || [];
  const evaluated = submetrics.map((definition) => {
    const value = Number(record?.[definition.field]);
    return {
      weight: Number(definition.weight || 0),
      score: Number.isFinite(value) ? thresholdScore(value, definition) : null
    };
  });
  if (evaluated.some((item) => !Number.isFinite(item.score))) return null;
  const weightSum = evaluated.reduce((sum, item) => sum + item.weight, 0);
  if (!weightSum) return null;
  return Math.round(evaluated.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum);
}
