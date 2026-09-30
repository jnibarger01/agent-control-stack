import { escapeHtml } from "./html.js";
import { pill } from "./format.js";
import { redactSecrets } from "./redaction.js";

/**
 * PR-style approval bundle review.
 *
 * Renders one change set: what was requested, what was already approved, and what is
 * new since that approval. The two lists are kept visually and structurally separate
 * on purpose, because "approve the delta" is only a safe offer if a reviewer can see
 * precisely which entries are new.
 *
 * High-risk operations are never folded into a bare count. A destructive action, a
 * service restart and a command are each rendered as their own row with their target
 * spelled out.
 */

export interface ApprovalBundleChangeView {
  id: string;
  type: string;
  summary: string;
  target: string;
  risk: "low" | "medium" | "high" | "critical";
  destructive: boolean;
  network: boolean;
  dependsOn: string[];
  actionHash: string;
  actionKind: string;
  command: string[] | null;
  paths: string[] | null;
  cwd: string | null;
}

export interface ApprovalBundleDecisionView {
  id: string;
  revision: number;
  kind: "approve_all" | "approve_selected" | "reject" | "invalidate";
  approvedByActorId: string;
  reason: string;
  changeIds: string[];
  manifestHash: string;
  decidedAt: string;
}

export interface ApprovalBundleView {
  bundleId: string;
  missionId: string;
  executionId: string;
  agentId: string;
  title: string;
  rationale: string;
  revision: number;
  status: string;
  manifestHash: string;
  parentManifestHash: string | null;
  scope: { files?: string[]; repos?: string[]; services?: string[]; tools?: string[]; hosts?: string[] };
  baseState: { gitSha?: string; configHash?: string };
  createdAt: string;
  createdByActorId: string;
  changes: ApprovalBundleChangeView[];
  approvals: ApprovalBundleDecisionView[];
}

export type ApprovalDeltaClass = "unchanged" | "modified" | "added" | "removed";

export interface ApprovalDeltaEntryView {
  changeId: string;
  digest: string;
  classification: ApprovalDeltaClass;
  /** Null rather than absent: the API serializes JSON, and `undefined` would drop the key. */
  previousDigest: string | null;
  /** A removed change has no row to render, so this is explicitly null. */
  change: ApprovalBundleChangeView | null;
}

export interface ApprovalDeltaView {
  fromRevision: number;
  toRevision: number;
  fromManifestHash: string;
  toManifestHash: string;
  unchanged: ApprovalDeltaEntryView[];
  modified: ApprovalDeltaEntryView[];
  added: ApprovalDeltaEntryView[];
  removed: ApprovalDeltaEntryView[];
  requiresApproval: ApprovalDeltaEntryView[];
}

export interface ApprovalBundleReview {
  bundle: ApprovalBundleView;
  /** Delta against the last approved revision, or null for the first review. */
  delta: ApprovalDeltaView | null;
  grants: Array<{ changeId: string; status: string; approvedByActorId: string; manifestHash: string }>;
}

const RISK_RANK: Record<ApprovalBundleChangeView["risk"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

function changeFor(review: ApprovalBundleReview, changeId: string): ApprovalBundleChangeView | undefined {
  return review.bundle.changes.find((change) => change.id === changeId);
}

function deltaLabel(classification: ApprovalDeltaClass): string {
  switch (classification) {
    case "unchanged":
      return "carried over";
    case "modified":
      return "changed since approval";
    case "added":
      return "new";
    case "removed":
      return "removed";
  }
}

/** One change row. Destructive and command changes are called out, never summarised. */
function changeRow(change: ApprovalBundleChangeView, options: { classification?: ApprovalDeltaClass } = {}): string {
  const flags: string[] = [];
  if (change.destructive) {
    flags.push('<span class="chip chip-danger">destructive</span>');
  }
  if (change.network) {
    flags.push('<span class="chip chip-warn">external write</span>');
  }
  if (change.command) {
    flags.push('<span class="chip">command</span>');
  }
  if (change.paths && change.paths.length > 0) {
    flags.push('<span class="chip">file</span>');
  }
  const classification = options.classification
    ? `<span class="chip chip-${options.classification === "unchanged" ? "ok" : "warn"}">${escapeHtml(deltaLabel(options.classification))}</span>`
    : "";
  const command = change.command ? `<pre class="bundle-command">${escapeHtml(change.command.join(" "))}</pre>` : "";
  const dependencies =
    change.dependsOn.length > 0
      ? `<small class="muted">depends on ${escapeHtml(change.dependsOn.join(", "))}</small>`
      : "";
  return `<li class="bundle-change" data-bundle-change="${escapeHtml(change.id)}" data-risk="${escapeHtml(change.risk)}" data-action-hash="${escapeHtml(change.actionHash)}">
    <label class="bundle-change-select"><input type="checkbox" data-bundle-select="${escapeHtml(change.id)}" checked /> <span class="bundle-change-title">${escapeHtml(change.summary)}</span></label>
    <span class="bundle-change-meta">${pill(change.risk)} ${escapeHtml(change.type)} ${classification} ${flags.join(" ")}</span>
    <code class="bundle-change-target">${escapeHtml(change.target)}</code>
    ${command}
    ${dependencies}
  </li>`;
}

function changeList(entries: ApprovalDeltaEntryView[], review: ApprovalBundleReview, emptyText: string): string {
  const rendered = entries
    .map((entry) => {
      const change = entry.change ?? changeFor(review, entry.changeId);
      return change ? changeRow(change, { classification: entry.classification }) : "";
    })
    .filter((html) => html.length > 0)
    .join("");
  if (rendered.length === 0) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul class="bundle-change-list">${rendered}</ul>`;
}

/** The `Files / Services / Commands / Destructive / External` summary strip. */
function scopeSummary(bundle: ApprovalBundleView): string {
  const changes = bundle.changes;
  const commands = changes.filter((change) => change.command !== null).length;
  const services = changes.filter(
    (change) => change.type === "service_restart" || change.type === "service_control"
  ).length;
  const destructive = changes.filter((change) => change.destructive).length;
  const external = changes.filter((change) => change.network).length;
  const files = new Set<string>();
  for (const change of changes) {
    for (const path of change.paths ?? []) {
      files.add(path);
    }
  }
  const row = (label: string, value: string | number) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
  return `<dl class="bundle-scope">
    ${row("Changes", String(changes.length))}
    ${row("Files", files.size)}
    ${row("Services", services)}
    ${row("Commands", commands)}
    ${row("Destructive", destructive > 0 ? "Yes" : "No")}
    ${row("External", external > 0 ? "Yes" : "No")}
  </dl>`;
}

function decisionHistory(bundle: ApprovalBundleView): string {
  if (bundle.approvals.length === 0) {
    return `<p class="empty">No decisions recorded yet.</p>`;
  }
  return `<ul class="bundle-history">${bundle.approvals
    .map(
      (decision) =>
        `<li><span>${pill(decision.kind)}</span> rev ${decision.revision} &middot; ${escapeHtml(decision.approvedByActorId)} &middot; ${escapeHtml(String(decision.changeIds.length))} change(s) &middot; <code class="hash-prefix">${escapeHtml(decision.manifestHash.slice(0, 12))}</code><br /><small class="muted">${escapeHtml(redactSecrets(decision.reason))}</small></li>`
    )
    .join("")}</ul>`;
}

const TABS = ["Changes", "Risk", "History", "Audit"] as const;

function tabPanel(review: ApprovalBundleReview, tab: (typeof TABS)[number]): string {
  switch (tab) {
    case "Changes":
      return changeList(
        review.bundle.changes.map((change) => ({
          changeId: change.id,
          digest: "",
          classification: "unchanged" as const,
          previousDigest: null,
          change
        })),
        review,
        "No changes proposed."
      );
    case "Risk": {
      const ordered = [...review.bundle.changes].sort((left, right) => RISK_RANK[left.risk] - RISK_RANK[right.risk]);
      return `<ul class="bundle-change-list">${ordered
        .map(
          (change) =>
            `<li class="bundle-change" data-risk="${escapeHtml(change.risk)}"><span class="bundle-change-title">${escapeHtml(change.summary)}</span> ${pill(change.risk)} <code class="bundle-change-target">${escapeHtml(change.target)}</code></li>`
        )
        .join("")}</ul>`;
    }
    case "History":
      return decisionHistory(review.bundle);
    case "Audit":
      return `<dl class="bundle-scope">
        <div><dt>Bundle</dt><dd>${escapeHtml(review.bundle.bundleId)}</dd></div>
        <div><dt>Revision</dt><dd>${review.bundle.revision}</dd></div>
        <div><dt>Manifest</dt><dd><code class="hash-prefix">${escapeHtml(review.bundle.manifestHash)}</code></dd></div>
        <div><dt>Parent manifest</dt><dd><code class="hash-prefix">${escapeHtml(review.bundle.parentManifestHash ?? "none")}</code></dd></div>
        <div><dt>Requested by</dt><dd>${escapeHtml(review.bundle.agentId)}</dd></div>
        <div><dt>Mission</dt><dd>${escapeHtml(review.bundle.missionId)}</dd></div>
        <div><dt>Execution</dt><dd>${escapeHtml(review.bundle.executionId)}</dd></div>
        ${Object.entries(review.bundle.scope)
          .filter(([, value]) => Array.isArray(value) && value.length > 0)
          .map(
            ([key, value]) =>
              `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml((value as string[]).join(", "))}</dd></div>`
          )
          .join("")}
        ${Object.entries(review.bundle.baseState)
          .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
          .join("")}
      </dl>`;
  }
}

/**
 * One approval bundle card.
 *
 * Structure mirrors a pull request: identity and risk at the top, previously
 * approved separated from new work, then the decision controls.
 */
export function approvalBundleReviewCard(review: ApprovalBundleReview): string {
  const { bundle, delta } = review;
  const carriedOver = delta ? [...delta.unchanged, ...delta.modified] : [];
  const added: ApprovalDeltaEntryView[] = delta
    ? delta.added
    : bundle.changes.map((change) => ({
        changeId: change.id,
        digest: "",
        classification: "unchanged" as const,
        previousDigest: null,
        change
      }));
  const awaiting = bundle.status === "pending" || bundle.status === "modified" || bundle.status === "draft";
  const reasonId = `bundle-reason-${escapeHtml(bundle.bundleId)}`;

  const controls = awaiting
    ? `<div class="approval-actions" role="group" aria-label="Actions for ${escapeHtml(bundle.title)}">
        <label class="reason-field" for="${reasonId}"><span class="reason-label">Reason <span class="req">(required)</span></span><input id="${reasonId}" data-bundle-reason="${escapeHtml(bundle.bundleId)}" required placeholder="Why approve, reject, or narrow this change set" autocomplete="off" /></label>
        <button type="button" class="tool-button" data-bundle-decision="reject" data-bundle-id="${escapeHtml(bundle.bundleId)}" data-bundle-revision="${bundle.revision}" aria-describedby="${reasonId}">Reject</button>
        <button type="button" class="tool-button" data-bundle-decision="approve_selected" data-bundle-id="${escapeHtml(bundle.bundleId)}" data-bundle-revision="${bundle.revision}" aria-describedby="${reasonId}">Approve selected</button>
        <button type="button" data-bundle-decision="approve_all" data-bundle-id="${escapeHtml(bundle.bundleId)}" data-bundle-revision="${bundle.revision}" aria-describedby="${reasonId}">Approve all</button>
      </div>
      <output id="bundle-result-${escapeHtml(bundle.bundleId)}" class="approval-result" aria-live="polite"></output>`
    : `<p class="muted">This change set is ${escapeHtml(bundle.status)}.</p>`;

  return `<article class="approval-item bundle-review" data-bundle-ref="${escapeHtml(bundle.bundleId)}" data-bundle-revision="${bundle.revision}" data-bundle-status="${escapeHtml(bundle.status)}">
    <div class="bundle-head">
      <strong>${escapeHtml(bundle.bundleId)}</strong> ${pill(bundle.status)} ${pill(highestRisk(bundle))}
      <span class="muted">Revision ${bundle.revision}</span>
    </div>
    <strong class="bundle-title">${escapeHtml(bundle.title)}</strong>
    <small class="muted">Agent: ${escapeHtml(bundle.agentId)} &middot; Mission: ${escapeHtml(bundle.missionId)} &middot; Execution: ${escapeHtml(bundle.executionId)} &middot; <code class="hash-prefix">${escapeHtml(bundle.manifestHash.slice(0, 12))}</code></small>
    <p class="bundle-rationale">${escapeHtml(redactSecrets(bundle.rationale))}</p>
    ${scopeSummary(bundle)}
    <div class="bundle-tabs" role="tablist" aria-label="Change set sections">${TABS.map(
      (tab, index) =>
        `<button type="button" role="tab" class="tool-button" data-bundle-tab="${tab}" data-bundle-id="${escapeHtml(bundle.bundleId)}" aria-selected="${index === 0}">${tab}</button>`
    ).join("")}</div>
    <div class="bundle-tabpanel" data-bundle-panel="Changes" data-bundle-id="${escapeHtml(bundle.bundleId)}">${tabPanel(review, "Changes")}</div>
    ${TABS.filter((tab) => tab !== "Changes")
      .map(
        (tab) =>
          `<div class="bundle-tabpanel" data-bundle-panel="${tab}" data-bundle-id="${escapeHtml(bundle.bundleId)}" hidden>${tabPanel(review, tab)}</div>`
      )
      .join("")}
    <section class="detail-section">
      <h4>Previously approved</h4>
      ${changeList(carriedOver, review, "Nothing approved in an earlier revision yet.")}
    </section>
    <section class="detail-section">
      <h4>New since approval</h4>
      ${changeList(added, review, "No new work since the last approval.")}
    </section>
    ${controls}
  </article>`;
}

function highestRisk(bundle: ApprovalBundleView): ApprovalBundleChangeView["risk"] {
  let overall: ApprovalBundleChangeView["risk"] = "low";
  for (const change of bundle.changes) {
    if (RISK_RANK[change.risk] < RISK_RANK[overall]) {
      overall = change.risk;
    }
  }
  return overall;
}

/** The panel: bundle reviews first, then the approval strategy control. */
export function approvalBundlePanel(
  reviews: readonly ApprovalBundleReview[],
  approvalStrategy: string | undefined
): string {
  const cards =
    reviews.length === 0
      ? `<p class="empty">No approval bundles are awaiting review.</p>`
      : reviews
          .slice()
          .sort((left, right) => RISK_RANK[highestRisk(left.bundle)] - RISK_RANK[highestRisk(right.bundle)])
          .map(approvalBundleReviewCard)
          .join("");
  return `<div id="approval-bundles-body">
    ${approvalStrategyFieldset(approvalStrategy)}
    <div id="approval-bundles-list">${cards}</div>
  </div>`;
}

/**
 * Approval strategy selector.
 *
 * Renders as a fieldset inside the same panel, using the existing control classes,
 * so it does not read as a separate legacy-styled page.
 */
export function approvalStrategyFieldset(strategy: string | undefined): string {
  const current = strategy ?? "PER_ACTION";
  const option = (value: string, label: string, hint: string) =>
    `<label class="strategy-option"><input type="radio" name="approval-strategy" value="${value}" data-approval-strategy${current === value ? " checked" : ""} /> <span>${escapeHtml(label)}</span><small class="muted">${escapeHtml(hint)}</small></label>`;
  return `<fieldset class="approval-strategy" id="approval-strategy">
    <legend>Approval strategy</legend>
    ${option("PER_ACTION", "Per action", "Each privileged operation is approved on its own. Unchanged ACS behaviour.")}
    ${option("BUNDLE", "Change-set approval", "Privileged work is collected into one reviewable change set and approved together.")}
    ${option("POLICY_AUTONOMOUS", "Policy autonomous", "Executes without a human only where policy already allows it. Never allow-all.")}
    <output id="approval-strategy-result" class="approval-result" aria-live="polite"></output>
  </fieldset>`;
}
