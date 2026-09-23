// Render a Sideworld CI result (the single JSON object ops/ci-entry.sh prints) as the pull
// request comment. Required by .github/workflows/sideworld.yml through actions/github-script,
// and runnable on its own so the exact text can be reproduced outside a workflow:
//
//     node comment.js result.json
//
// Pure: no network, no Octokit, no environment. The workflow does the posting.

const MARKER = (world) => `<!-- sideworld-ci:${world} -->`;

const secs = (v) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (n < 90) return `${n.toFixed(1)} s`;
  const m = Math.floor(n / 60);
  return `${m} m ${(n - m * 60).toFixed(0)} s`;
};

const code = (s) => "`" + String(s).replace(/`/g, "") + "`";
const list = (names, limit = 20) => {
  if (!names || names.length === 0) return "_none_";
  const shown = names.slice(0, limit).map(code).join(", ");
  return names.length > limit ? `${shown} … and ${names.length - limit} more` : shown;
};

const PHASE_LABEL = {
  unpack: "unpack checkout",
  queue: "queued behind another run",
  plan: "plan (changed paths → services)",
  prebuild: "prepare the build context",
  build: "build image(s)",
  restore: "restore fork from baseline",
  ship: "ship image(s) into the fork",
  swap: "recreate the swapped container(s)",
  "migration-check": "migration check (replayed under load)",
  migrate: "migrations forward",
  sessions: "mint sessions",
  suite: "suite",
  compare: "confirm candidate regressions",
  teardown: "teardown",
};

function render(r) {
  const out = [];
  const world = r.world || "?";

  if (r.status !== "ok") {
    out.push(`### Sideworld — the run did not complete`);
    out.push("");
    out.push(`\`\`\`\n${r.error || "unknown error"}\n\`\`\``);
    out.push("");
    out.push(`No verdict was produced for ${code(r.head_sha ? r.head_sha.slice(0, 12) : "?")}, so nothing is claimed about this pull request.`);
    out.push("");
    if (r.migration_check) { out.push(renderMigrationCheck(r.migration_check)); }
    out.push(footer(r));
    out.push(MARKER(world));
    return out.join("\n");
  }

  const c = r.compare || {};
  const mc = r.migration_check;
  const mcRed = !!(mc && mc.verdict && mc.verdict.red);
  let verdict = r.red
    ? `**🔴 ${c.new.length} new failure${c.new.length === 1 ? "" : "s"}**`
    : "**🟢 no new failures**";
  if (mcRed) {
    const why = (mc.verdict.reasons || []).slice(0, 2).join("; ");
    verdict = `**🔴 migration check failed** — ${why}${c.new?.length ? ` · ${c.new.length} new suite failure${c.new.length === 1 ? "" : "s"}` : ""}`;
  } else if (mc && mc.replayed && !r.red) {
    verdict = "**🟢 no new failures · migration check passed**";
  }

  out.push(`### Sideworld — \`${world}\` forked at production scale`);
  out.push("");
  out.push(`${verdict} · suite ${code(r.suite)} · ${secs(r.total_s)} wall-clock${r.queued ? " · queued behind another run" : ""}`);
  out.push("");
  // The Migration Check comes first: when the pull request adds a migration, what it does to the
  // database under load is the thing to read before the timings.
  if (mc) { out.push(renderCiMigrationCheck(mc)); out.push(""); }

  // ---- timings
  out.push("| phase | |");
  out.push("|---|--:|");
  for (const p of r.phase_order || []) {
    let label = PHASE_LABEL[p] || p;
    if (p === "build" && r.services_built?.length) label = `build ${r.services_built.map(code).join(", ")}`;
    if (p === "queue" && !r.queued) continue;
    if (p === "sessions" && !r.sessions) continue;   // worlds without personas to mint
    if (p === "migration-check" && !r.migration_check) continue;   // the pull request adds no migration
    out.push(`| ${label} | ${secs(r.phases[p])} |`);
    // The restore phase is mostly a file copy, and saying so is the difference between a useful
    // number and a misleading one.
    if (p === "restore" && r.restore_detail?.serving_s) {
      const d = r.restore_detail;
      out.push(`| &nbsp;&nbsp;↳ snapshot load → first 200 | ${secs(d.serving_s)} |`);
      if (d.disks_s !== null && d.disks_s !== undefined) {
        const label = d.rootfs_mode === "zvol" ? "data + root disk, cloned" : "root-disk copy";
        out.push(`| &nbsp;&nbsp;↳ ${label} | ${secs(d.disks_s)} |`);
        if (d.netns_s != null) out.push(`| &nbsp;&nbsp;↳ network namespace | ${secs(d.netns_s)} |`);
      } else {
        out.push(`| &nbsp;&nbsp;↳ root-disk copy and setup | ${secs(r.phases[p] - d.serving_s)} |`);
      }
    }
  }
  out.push(`| **total** | **${secs(r.total_s)}** |`);
  out.push("");

  // ---- per-image build detail, when more than one was built
  if ((r.build || []).length > 1) {
    out.push("<details><summary>build, per image</summary>");
    out.push("");
    out.push("| image | |");
    out.push("|---|--:|");
    for (const b of r.build) out.push(`| ${code(b.service)} | ${secs(b.seconds)} |`);
    out.push("");
    out.push("</details>");
    out.push("");
  }

  // ---- migrations
  const migs = r.migrations || [];
  out.push(`**Migrations** — run forward on the fork when the swapped service restarted`);
  out.push("");
  if (migs.length === 0) {
    out.push("_the swapped service reported none_");
  } else {
    const applied = migs.reduce((n, m) => n + (m.applied || 0), 0);
    const total = migs.reduce((n, m) => n + (m.ms || 0), 0);
    out.push(`${applied} applied across ${migs.length} database(s), ${total} ms in total.`);
    out.push("");
    out.push("<details><summary>per database</summary>");
    out.push("");
    out.push("| service | target | applied | |");
    out.push("|---|---|--:|--:|");
    for (const m of migs) {
      out.push(`| ${code(m.service)} | ${m.target ? code(m.target) : "—"} | ${m.applied ?? "—"} | ${m.ms} ms |`);
    }
    out.push("");
    out.push("</details>");
  }
  out.push("");

  // ---- suite
  const s = r.suite_result || {};
  out.push(`**Suite ${code(r.suite)}** — ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.tests}`);
  out.push("");
  // Only worth saying when the baseline actually fails something. A world whose baseline is
  // clean does not need a paragraph explaining that nothing is being excused.
  if (c.baseline_failing > 0) {
    out.push(
      `> The baseline fails **${c.baseline_failing} of ${c.baseline_tests}** on this snapshot ` +
        `(${c.baseline_always} of them every time). Those are a property of the data this fork carries, ` +
        `not of this pull request, so they are reported but never counted against it.`
    );
    out.push("");
  }
  // A probe-style suite carries what each check measured; a test binary does not. When it is
  // there, show it: for these worlds the value of a green run is in the numbers, not the tick.
  if (s.status && Object.keys(s.status).length <= 20) {
    out.push("| check | | |");
    out.push("|---|:--:|---|");
    for (const [name, verdict] of Object.entries(s.status)) {
      const icon = verdict === "pass" ? "✅" : verdict === "skip" ? "⏭️" : "❌";
      const d = (s.detail || {})[name] || "";
      const secs_ = (s.slowest || []).find(([n]) => n === name);
      const when = secs_ ? `${secs_[1].toFixed(1)} s` : "";
      out.push(`| ${code(name)} | ${icon} | ${[d, when].filter(Boolean).join(" · ")} |`);
    }
    out.push("");
  }

  out.push(`- 🆕 **new failures** (${c.new.length}) — the verdict: ${list(c.new)}`);
  if (c.baseline_failing > 0) {
    out.push(`- ➖ unchanged (${c.unchanged.length}), already failing on the baseline: ${list(c.unchanged, 6)}`);
    out.push(
      `- ✅ passed here but fails on the baseline (${c.fixed.length}): ${list(c.fixed)}` +
        (c.fixed.length ? " — worth a look, but this set moves on its own at this scale; only `new` is a verdict" : "")
    );
  }
  if (c.new_cleared_on_retry?.length) {
    out.push(
      `- 🔁 cleared on retry (${c.new_cleared_on_retry.length}): ${list(c.new_cleared_on_retry)} ` +
        `— failed in the sharded run, passed when run alone, so not counted as new`
    );
  }
  out.push("");
  out.push(footer(r));
  out.push(MARKER(world));
  return out.join("\n");
}

// ---- Migration Check: an optional section, present when the run carried result.migration_check
// (the shape ops/migration-check-assemble.py writes). The same fixed format as
// benchmarks/<world>/MIGRATION-CHECK.md, shorter. Says what was measured under which workload;
// claims nothing else.
function renderMigrationCheck(mc) {
  const out = [];
  const secs = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(1)} ms`);
  const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
  const n = mc.naive, s = mc.safe, w = mc.workload, sm = mc.smoke, d = mc.database, L = n.locks.longest;
  out.push(`### Migration Check — ${mc.label}`);
  out.push("");
  out.push(`Measured against a fork of the baseline (restored in ${mc.fork.restore_a_s.toFixed(1)} s) under **${w.rps} requests/s** across ${w.probes.length} probes, ${w.window_s} s before (after a ${w.warmup_s || 0} s warm-up, not counted), throughout, and ${w.window_s} s after. What this migration did to this database under that load — not a prediction.`);
  out.push("");
  out.push("| | |"); out.push("|---|---|");
  out.push(`| migration file | ${code(mc.migration_file)} |`);
  out.push(`| database | ${code(d.table)}: **${d.table_size}**, **${d.rows.toLocaleString()} rows**; database ${d.database_size} |`);
  out.push(`| duration | **${n.duration_s.toFixed(1)} s** ${n.transaction ? "(one transaction)" : "(statements committed one by one)"} |`);
  out.push(`| longest lock | **${code(L.mode || "none")} held ${L.held_s.toFixed(1)} s** on ${code(d.table)}${L.waited_s ? `, after queueing ${L.waited_s.toFixed(1)} s for it` : ""} |`);
  out.push(`| estimated rewrite | **${gb(mc.estimated_rewrite.bytes)}** — ${mc.estimated_rewrite.basis} |`);
  out.push("");
  out.push("| # | statement | time |"); out.push("|--:|---|--:|");
  n.statements.forEach((st, i) => out.push(`| ${i + 1} | ${code(st.sql.replace(/\s+/g, " ").slice(0, 100))} | ${secs(st.ms)} |`));
  out.push("");
  out.push(`**Workload replay** — p99 per probe (ms), before / during / after; requests time out at ${w.timeout_s || 30} s and a timeout is an error`);
  out.push(""); out.push("| probe | before | during | after |"); out.push("|---|--:|--:|--:|");
  for (const p of w.probes) {
    const c = ["before", "during", "after"].map((k) => { const x = (w.naive[k] || {})[p]; return !x ? "—" : `${Math.round(x.p99)}${x.errors ? ` (${x.errors} err / ${x.n})` : ""}`; });
    out.push(`| ${code(p)} | ${c.join(" | ")} |`);
  }
  out.push("");
  if (n.drain) out.push(n.drain.settled ? `After the last statement returned, the backlog took **${Math.round(n.drain.s)} s** to drain.` : `After the last statement returned, the app had **not settled after ${Math.round(n.drain.s)} s**.`), out.push("");
  if (n.after) out.push(`Table after: **${n.after.table_size}** (was ${d.table_size}), ${n.after.dead_tuples.toLocaleString()} dead tuples awaiting vacuum.`), out.push("");
  out.push(`During it: **${n.locks.blocked_max} backends waiting on a lock at peak**, max ${n.locks.backends_max_during} client connections; waiting lock modes: ${n.locks.waiting_modes_seen.map(code).join(", ") || "none"}.`);
  out.push("");
  const sl = (x) => {
    if (x.tests == null) return "not run";
    let t = x.new_failures ? `**${x.passed} passed, ${x.failed} failed of ${x.tests}** — **${x.new_failures.length} new** against the unmodified fork${x.new_failures.length ? `: ${x.new_failures.slice(0, 8).map(code).join(", ")}` : ""}`
                           : `**${x.passed} passed, ${x.failed} failed of ${x.tests}**${x.failing?.length ? ` — ${x.failing.slice(0, 6).map(code).join(", ")}` : ""}`;
    if (x.reasons?.length) t += `; the suite's own words: ${x.reasons.map((r) => `${r.n}× ${code(r.text)}`).join("; ")}`;
    return t;
  };
  if (sm.known) out.push(`Unmodified fork, for reference: ${sm.known.failing.length} of ${sm.known.tests} tests fail before any migration (CI baseline, ${sm.known.repeats} repeats).`), out.push("");
  out.push(`**Smoke** ${code(sm.suite)}: old app on the new schema ${sl(sm.old_app_new_schema)}; new app on the new schema ${sl(sm.new_app_new_schema)}${sm.new_image ? ` (${code(sm.new_image)})` : " (same image, recreated)"}.`);
  out.push("");
  const SL = s.locks.longest;
  out.push(`**Safe pattern** (${s.description || ""}): **${s.duration_s.toFixed(1)} s**, longest lock ${code(SL.mode || "none")} ${SL.held_s.toFixed(1)} s, peak waiting backends ${s.locks.blocked_max}.`);
  out.push("");
  return out.join("\n");
}

// The CI form of the Migration Check (ops/ci-migration-verdict.py's object). Fixed order:
// files, duration, per-statement lock mode / waited / held, backends waiting at peak, per-probe
// p99 before / during / after, compatibility (old image and new image on the new schema), the
// verdict against the thresholds, the safe form's numbers if it ran, and the workload.
function renderCiMigrationCheck(mc) {
  const out = [];
  const files = (mc.files || []).map((f) => code(f.path)).join(", ") || "_none_";
  const v = mc.verdict || {};
  out.push(`**Migration Check** — ${files}`);
  out.push("");
  if (!mc.replayed || !mc.naive) {
    out.push(`_migration file(s) present, not replayed: ${mc.not_replayed_reason || v.not_run || "no workload configured"}_`);
    return out.join("\n");
  }
  const w = mc.workload || {};
  const ms1 = (v_) => (v_ == null ? "—" : v_ >= 1000 ? `${(v_ / 1000).toFixed(1)} s` : `${Number(v_).toFixed(1)} ms`);
  const lockCell = (L) => (!L || !L.mode ? "—" : `${code(L.mode)}${L.blocking ? "" : " (non-blocking)"}`);
  const block = (n, label, judged) => {
    const rows = [];
    rows.push(`**${label}** — ${n.duration_s.toFixed(1)} s ${n.transaction ? "in one transaction" : "statement by statement"}` +
              (n.after ? `; table after: ${n.after.table_size}, ${Number(n.after.dead_tuples).toLocaleString()} dead tuples` : ""));
    rows.push("");
    rows.push("| # | statement | time | lock | waited | held |");
    rows.push("|--:|---|--:|---|--:|--:|");
    (n.statements || []).forEach((s, i) => {
      const L = s.lock || {};
      const hot = judged && L.blocking && (L.held_s > (mc.thresholds?.lock_s ?? 5) || L.waited_s > (mc.thresholds?.lock_s ?? 5));
      rows.push(`| ${i + 1} | ${code(String(s.sql).replace(/\s+/g, " ").slice(0, 90))} | ${ms1(s.ms)} | ${lockCell(L)} | ${L.waited_s != null ? `${L.waited_s.toFixed(1)} s` : "—"} | ${L.held_s != null ? `${hot ? "**" : ""}${L.held_s.toFixed(1)} s${hot ? "**" : ""}` : "—"} |`);
    });
    if (n.errors?.length) rows.push(`\n> ${code(n.errors[0])}`);
    rows.push("");
    rows.push(`Backends waiting on a lock at peak: **${n.locks?.blocked_max ?? 0}**; client connections at most ${n.locks?.backends_max_during ?? "?"}; waiting modes seen: ${(n.locks?.waiting_modes_seen || []).map(code).join(", ") || "none"}.` +
              (n.drain ? (n.drain.settled ? ` Settled ${Math.round(n.drain.s)} s after the last statement.` : ` **Not settled ${Math.round(n.drain.s)} s after the last statement.**`) : ""));
    rows.push("");
    rows.push("| probe | p99 before | during | after |");
    rows.push("|---|--:|--:|--:|");
    for (const [p, x] of Object.entries(n.probes || {})) {
      const bad = judged && x.ratio != null && x.ratio > (mc.thresholds?.p99_factor ?? 10);
      rows.push(`| ${code(p)} | ${x.before_p99 == null ? "—" : Math.round(x.before_p99)} | ${x.during_p99 == null ? "—" : `${bad ? "**" : ""}${Math.round(x.during_p99)}${bad ? "**" : ""}`}${x.errors_during ? ` (${x.errors_during} err / ${x.n_during})` : ""} | ${x.after_p99 == null ? "—" : Math.round(x.after_p99)} |`);
    }
    return rows;
  };
  out.push(...block(mc.naive, "As written", true));
  out.push("");
  const sm = (x) => (!x ? "not run" : `${x.passed} passed, ${x.failed} failed of ${x.tests}` + (x.new_failures?.length ? ` — **${x.new_failures.length} new** vs the unmodified fork: ${list(x.new_failures, 6)}` : " — no new failures vs the unmodified fork"));
  out.push(`**Compatibility** — old image on the new schema: ${sm(mc.compat?.old_app_new_schema)}; new image on the new schema (the suite below): ${sm(mc.compat?.new_app_new_schema)}.`);
  out.push("");
  if (v.red) {
    out.push(`**Verdict: 🔴 fails the thresholds** — ${(v.reasons || []).map((r_) => `${r_}`).join("; ")}.`);
  } else {
    out.push(`**Verdict: 🟢 within the thresholds** (${(v.checked || []).join("; ")}).`);
  }
  out.push("");
  if (mc.safe) {
    out.push(...block(mc.safe, "The safe form, same workload", false));
    out.push("");
    if (mc.safe_form?.file_text || mc.safe_form?.statements?.length) {
      out.push("<details><summary>the safe form, as it would be written</summary>");
      out.push("");
      if (mc.safe_form.file_text) {
        out.push("```ruby"); out.push(mc.safe_form.file_text.trimEnd()); out.push("```");
      } else {
        out.push("```sql");
        if (mc.safe_form.preamble) out.push(mc.safe_form.preamble);
        for (const s of mc.safe_form.statements) out.push(s + ";");
        out.push("```");
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
  } else if (v.red) {
    out.push(`_No safe form was run: ${mc.safe_form?.reason || "the world config provides none"}._`);
    out.push("");
  }
  out.push(`<sub>Workload: ${w.rps ?? "?"} requests/s across ${(w.probes || []).length} probes (${(w.probes || []).map(code).join(", ")}), ${w.window_s ?? "?"} s before, throughout, ${w.window_s ?? "?"} s after, ${w.warmup_s ?? 0} s warm-up not counted, ${w.timeout_s ?? 30} s request timeout; thresholds: blocking lock waited or held ≤ ${mc.thresholds?.lock_s ?? 5} s, p99 during ≤ ${mc.thresholds?.p99_factor ?? 10}× before. Measured on a fork of the baseline; nothing here is a prediction.</sub>`);
  return out.join("\n");
}

function footer(r) {
  const b = r.baseline || {};
  const bits = [
    `forked from baseline ${code(b.name || "?")}`,
    b.zfs_snapshot ? `(${code(b.zfs_snapshot)})` : null,
    b.taken_at ? `taken ${b.taken_at}` : null,
    `run ${code(r.run_id || "?")}`,
    r.box ? `on ${code(r.box)}` : null,
  ].filter(Boolean);
  return `<sub>Sideworld: ${bits.join(" · ")}</sub>`;
}

module.exports = { render, MARKER, renderMigrationCheck, renderCiMigrationCheck };

if (require.main === module) {
  const fs = require("fs");
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node comment.js <result.json>");
    process.exit(2);
  }
  process.stdout.write(render(JSON.parse(fs.readFileSync(path, "utf8"))) + "\n");
}
