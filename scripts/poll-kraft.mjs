#!/usr/bin/env node
/**
 * Poll the PRIVATE kraft repo and dispatch its own CI here, on kraft-ci.
 *
 * WHY THIS EXISTS
 * ──────────────
 * The private repo cannot run ANY Actions job — it is out of minutes, so even a
 * two-second dispatcher fails with `steps: []` and `runner_id: 0`. Verified
 * against a pre-existing workflow that has nothing to do with this change.
 *
 * So the trigger moves here, where runners are free. On each tick this script
 * asks kraft for the commits it cares about, dispatches `ci.yml` for the ones
 * that have not been tested yet, and records the outcome by reading back the
 * commit status that ci.yml's `report` job posts.
 *
 * DESIGN
 * ──────
 * One writer (this script) to one state file, so there is no race. Dedup is by
 * SHA: a commit is tested once, whether it passes or fails. A run that never
 * reports is re-dispatched after STALE_MS, so a lost run recovers on its own
 * instead of waiting for the next push.
 *
 * The state file is the only thing this workflow ever commits back. Nothing here
 * writes to kraft — ci.yml's `report` job owns that side.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const KRAFT_REPO = "rakay-technology/kraft";
const STATE_PATH = resolve(process.cwd(), ".ci-state/state.json");
const STATE_CONTEXT = "kraft-ci"; // the context ci.yml's `report` job posts

/** Re-dispatch a run that has been "pending" longer than this. */
const STALE_MS = 25 * 60 * 1000;
/** Drop history beyond this, so the file cannot grow without bound. */
const MAX_HISTORY = 200;

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
};

/** Fire a repository_dispatch on THIS repo. GITHUB_TOKEN first (contents:write
 *  is enough), falling back to the kraft PAT if this org restricts it. */
const dispatch = async (sha) => {
  for (const tok of [process.env.GITHUB_TOKEN, token].filter(Boolean)) {
    const res = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok}`,
          accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ event_type: "kraft-ci", client_payload: { sha } }),
      },
    );
    if (res.ok) return;
    const why = await res.text();
    console.log(`  dispatch with ${tok === process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "KRAFT_PAT"} → ${res.status} ${why}`);
  }
  throw new Error(`could not dispatch ${sha} on ${process.env.GITHUB_REPOSITORY}`);
};

// ─── state ────────────────────────────────────────────────────────────────
const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { version: 1, runs: {} };
  }
};
const state = loadState();

// ─── 1. what does kraft want tested? ──────────────────────────────────────
const targets = [];

const branch = process.env.KRAFT_BRANCH || "main";
try {
  const { sha } = await api(`/repos/${KRAFT_REPO}/commits/${branch}`);
  targets.push({ sha, ref: `refs/heads/${branch}`, kind: "branch" });
} catch (err) {
  console.log(`branch ${branch}: ${err.message}`);
}

try {
  const pulls = await api(`/repos/${KRAFT_REPO}/pulls?state=open&per_page=50`);
  for (const pr of pulls) {
    targets.push({
      sha: pr.head.sha,
      ref: pr.head.ref,
      kind: `pr#${pr.number}`,
    });
  }
} catch (err) {
  console.log(`pulls: ${err.message}`);
}

if (targets.length === 0) {
  console.log("nothing to poll");
  process.exit(0);
}
console.log(`polling ${targets.length} target(s) on ${KRAFT_REPO}`);

// ─── 2. decide, and read back what has finished ───────────────────────────
const now = Date.now();
let dispatched = 0;

for (const t of targets) {
  const known = state.runs[t.sha];

  // Already settled — this exact commit has been reported. Never re-test the
  // same SHA, pass or fail: only a NEW commit earns a new run.
  if (known && known.state !== "pending") continue;

  // `known.at` is an ISO STRING. Subtracting it from a number yields NaN, and
  // `NaN < STALE_MS` is false — so this guard was dead code and every tick
  // re-dispatched commits that were still running. Parse it.
  const dispatchedAt = known?.at ? new Date(known.at).getTime() : 0;
  if (known && now - dispatchedAt < STALE_MS) {
    console.log(`  ${t.sha.slice(0, 8)} (${t.kind}) still running`);
    continue;
  }

  // Either never seen, or the previous run went quiet. Ask kraft what it has.
  let reported = null;
  try {
    const statuses = await api(`/repos/${KRAFT_REPO}/commits/${t.sha}/status`);
    reported = statuses.find((s) => s.context === STATE_CONTEXT) ?? null;
  } catch {
    reported = null;
  }

  console.log(
    `  ${t.sha.slice(0, 8)} (${t.kind}) kraft says: ` +
      `${reported ? reported.state : "no status"}`,
  );

  if (reported && reported.state !== "pending") {
    state.runs[t.sha] = {
      ref: t.ref,
      kind: t.kind,
      state: reported.state,
      desc: reported.description ?? "",
      at: new Date().toISOString(),
    };
    console.log(`  ${t.sha.slice(0, 8)} (${t.kind}) → ${reported.state}`);
    continue;
  }

  if (reported?.target_url) {
    // A run exists but has not concluded: leave it alone and retry on a later
    // tick rather than starting a second one for the same commit.
    console.log(`  ${t.sha.slice(0, 8)} (${t.kind}) in flight — leaving it`);
    continue;
  }

  await dispatch(t.sha);
  dispatched += 1;
  state.runs[t.sha] = {
    ref: t.ref,
    kind: t.kind,
    state: "pending",
    at: new Date().toISOString(),
  };
  console.log(`  ${t.sha.slice(0, 8)} (${t.kind}) → dispatched`);
}

// ─── 3. prune + persist ───────────────────────────────────────────────────
const entries = Object.entries(state.runs)
  .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
  .slice(0, MAX_HISTORY);
state.runs = Object.fromEntries(entries);

if (dispatched > 0 || JSON.stringify(loadState()) !== JSON.stringify(state)) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`state written (${entries.length} entries, ${dispatched} dispatched)`);
} else {
  console.log("state unchanged");
}
