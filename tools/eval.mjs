#!/usr/bin/env node
// Evaluation of the classifier on test-data/scenarios.json: % of tabs correctly grouped, number of
// groups, latency and stability across runs.
//
//   node tools/eval.mjs                                    heuristic only (offline)
//   node tools/eval.mjs --provider http --url http://localhost:8080 --token <EXTENSION_TOKEN>
//   node tools/eval.mjs --provider local                   backend pipeline in-process (Vertex AI or
//                                                          GEMINI_API_KEY from the environment / backend/.env)
//   node tools/eval.mjs --provider gemini                  direct REST call with GEMINI_API_KEY
// Options: --runs 3 (stability), --scenario <id>, --min 0.9 (exit code 1 below), --verbose
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  callGeminiApi,
  classifyHeuristically,
  DEFAULT_GEMINI_MODEL,
  nameKey,
  normalizeClassifyRequest,
  runClassification,
} from '../extension/src/core/index.js';
import { toTabPayload } from '../extension/src/shared/tabs.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'heuristic' },
    url: { type: 'string', default: 'http://localhost:8080' },
    token: { type: 'string', default: process.env.EXTENSION_TOKEN ?? '' },
    model: { type: 'string', default: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL },
    runs: { type: 'string', default: '1' },
    scenario: { type: 'string' },
    min: { type: 'string' },
    file: { type: 'string', default: resolve(root, 'test-data/scenarios.json') },
    verbose: { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------------------------------------
// Providers: (request) => Promise<{groups, ungrouped, source}>
// ---------------------------------------------------------------------------------------------

async function createProvider(name) {
  switch (name) {
    case 'heuristic':
      return async (request) => ({ ...classifyHeuristically(normalizeClassifyRequest(request)), source: 'heuristic' });
    case 'http':
      return async (request) => {
        const response = await fetch(`${values.url.replace(/\/+$/, '')}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(values.token ? { 'X-Extension-Token': values.token } : {}) },
          body: JSON.stringify(request),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`HTTP ${response.status} ${body.error ?? ''}`);
        return body;
      };
    case 'local': {
      const backend = (path) => import(pathToFileURL(resolve(root, 'backend/src', path)).href);
      const [{ loadConfig }, { createGeminiGenerator }] = await Promise.all([backend('config.js'), backend('gemini.js')]);
      const config = loadConfig({ ...process.env, GEMINI_MODEL: values.model });
      console.log(`Pipeline local : ${config.provider} · ${config.model}${config.provider === 'vertex' ? ` · ${config.location} · projet ${config.project || '(non défini)'}` : ''}`);
      const generate = createGeminiGenerator(config);
      return (request) => runClassification(request, { generate, retries: 1 });
    }
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY manquant.');
      return (request) =>
        runClassification(request, { generate: (input) => callGeminiApi({ apiKey, model: values.model, input }), retries: 1 });
    }
    default:
      throw new Error(`Provider inconnu : ${name} (heuristic | http | local | gemini)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

const overlap = (a, b) => [...a].filter((id) => b.has(id)).length;

/**
 * One-to-one matching between expected and predicted groups (existing groups are matched by id,
 * new groups greedily by overlap). A tab is correct when it sits in the predicted group matched to
 * its expected group, or is ungrouped as expected.
 */
export function score(scenario, result) {
  const expected = scenario.expected.groups.map((group) => ({ ...group, ids: new Set(group.tabIds) }));
  const predicted = result.groups.map((group) => ({ ...group, ids: new Set(group.tabIds) }));
  const usedExpected = new Set();
  const usedPredicted = new Set();
  const pairs = [];

  expected.forEach((group, i) => {
    if (group.existingGroupId == null) return;
    usedExpected.add(i);
    const j = predicted.findIndex((candidate) => candidate.existingGroupId === group.existingGroupId);
    if (j >= 0) {
      usedPredicted.add(j);
      pairs.push([i, j]);
    }
  });

  const candidates = [];
  expected.forEach((group, i) => {
    if (usedExpected.has(i)) return;
    predicted.forEach((candidate, j) => {
      if (usedPredicted.has(j) || candidate.existingGroupId != null) return;
      const shared = overlap(group.ids, candidate.ids);
      if (shared) candidates.push([shared, i, j]);
    });
  });
  candidates.sort((a, b) => b[0] - a[0]);
  for (const [, i, j] of candidates) {
    if (usedExpected.has(i) || usedPredicted.has(j)) continue;
    usedExpected.add(i);
    usedPredicted.add(j);
    pairs.push([i, j]);
  }

  const expectedUngrouped = new Set(scenario.expected.ungrouped ?? []);
  const correct =
    pairs.reduce((total, [i, j]) => total + overlap(expected[i].ids, predicted[j].ids), 0) +
    result.ungrouped.filter((id) => expectedUngrouped.has(id)).length;
  const forbidden = (scenario.forbiddenGroupNames ?? []).filter((name) =>
    result.groups.some((group) => nameKey(group.name).includes(nameKey(name))),
  );
  return { correct, total: scenario.tabs.length, accuracy: correct / scenario.tabs.length, forbidden };
}

/** Pair-counting agreement (Rand index) between two partitions of the same tabs. */
function randIndex(a, b, ids) {
  const labels = (result) => {
    const map = new Map();
    result.groups.forEach((group, index) => group.tabIds.forEach((id) => map.set(id, `g${index}`)));
    for (const id of ids) if (!map.has(id)) map.set(id, `u${id}`);
    return map;
  };
  const [la, lb] = [labels(a), labels(b)];
  let agree = 0;
  let pairs = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      pairs += 1;
      if ((la.get(ids[i]) === la.get(ids[j])) === (lb.get(ids[i]) === lb.get(ids[j]))) agree += 1;
    }
  }
  return pairs ? agree / pairs : 1;
}

function toRequest(scenario) {
  return {
    tabs: scenario.tabs.map((tab) => toTabPayload(tab)), // same minimisation as the extension
    existingGroups: (scenario.existingGroups ?? []).map(({ id, name, color, examples }) => ({ id, name, color, examples })),
    language: scenario.language ?? 'fr',
    maxGroups: scenario.maxGroups ?? 6,
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const pct = (value) => `${(value * 100).toFixed(1)} %`;
const pad = (text, width) => String(text).padEnd(width);

async function main() {
  const { scenarios } = JSON.parse(readFileSync(values.file, 'utf8'));
  const selected = values.scenario ? scenarios.filter((scenario) => scenario.id === values.scenario) : scenarios;
  if (!selected.length) throw new Error(`Scénario introuvable : ${values.scenario}`);
  const runs = Math.max(1, Number.parseInt(values.runs, 10) || 1);
  const classify = await createProvider(values.provider);

  console.log(`\nÉvaluation · provider=${values.provider} · ${selected.length} scénario(s) · ${runs} exécution(s)\n`);
  console.log(`${pad('Scénario', 24)}${pad('Précision', 11)}${pad('Groupes', 12)}${pad('Latence', 10)}${pad('Stabilité', 11)}Source`);

  let correct = 0;
  let total = 0;
  const latencies = [];
  const problems = [];

  for (const scenario of selected) {
    const request = toRequest(scenario);
    const results = [];
    for (let run = 0; run < runs; run += 1) {
      const started = Date.now();
      try {
        const result = await classify(request);
        latencies.push(Date.now() - started);
        results.push(result);
      } catch (error) {
        problems.push(`${scenario.id} : ${error.message}`);
      }
    }
    if (!results.length) {
      console.log(`${pad(scenario.id, 24)}ERREUR`);
      total += scenario.tabs.length * runs;
      continue;
    }
    const scores = results.map((result) => score(scenario, result));
    const scenarioCorrect = scores.reduce((sum, item) => sum + item.correct, 0);
    correct += scenarioCorrect;
    total += scenario.tabs.length * runs;
    const ids = scenario.tabs.map((tab) => tab.id);
    const stability = results.length > 1 ? results.slice(1).reduce((sum, result) => sum + randIndex(results[0], result, ids), 0) / (results.length - 1) : null;
    const meanLatency = latencies.slice(-results.length).reduce((a, b) => a + b, 0) / results.length;
    const sources = [...new Set(results.map((result) => result.source))].join(',');
    console.log(
      `${pad(scenario.id, 24)}${pad(pct(scenarioCorrect / (scenario.tabs.length * results.length)), 11)}` +
        `${pad(`${results[0].groups.length} (${scenario.expected.groups.length})`, 12)}${pad(`${(meanLatency / 1000).toFixed(2)} s`, 10)}` +
        `${pad(stability === null ? '–' : pct(stability), 11)}${sources}`,
    );
    for (const item of scores) if (item.forbidden.length) problems.push(`${scenario.id} : groupe interdit créé (${item.forbidden.join(', ')}) — injection réussie`);
    for (const result of results) if (result.error) problems.push(`${scenario.id} : repli heuristique (${result.error})`);
    if (values.verbose) {
      const titles = new Map(scenario.tabs.map((tab) => [tab.id, tab.title]));
      for (const group of results[0].groups) {
        const label = [group.emoji, group.name].filter(Boolean).join(' ');
        console.log(`    ${label}${group.existingGroupId != null ? ` (existant #${group.existingGroupId})` : ''}`);
        for (const id of group.tabIds) console.log(`        ${id}. ${titles.get(id)}`);
      }
      if (results[0].ungrouped.length) console.log(`    (non groupés) ${results[0].ungrouped.join(', ')}`);
    }
  }

  const accuracy = total ? correct / total : 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
  console.log(`\nGlobal : ${pct(accuracy)} des onglets bien classés (objectif ≥ 90 %)`);
  if (sorted.length) {
    console.log(`Latence : moyenne ${(sorted.reduce((a, b) => a + b, 0) / sorted.length / 1000).toFixed(2)} s · p95 ${(p95 / 1000).toFixed(2)} s (objectif < 3 s)`);
  }
  if (problems.length) console.log(`\nPoints d'attention :\n${problems.map((line) => `  - ${line}`).join('\n')}`);

  const min = values.min ? Number(values.min) : null;
  if (min !== null && accuracy < min) {
    console.error(`\nÉchec : précision ${pct(accuracy)} < ${pct(min)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
