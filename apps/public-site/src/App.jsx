import { useEffect, useMemo, useState } from "react";
import { fixtures, scenarioOrder } from "./fixtures.js";

const caseStudies = [
  {
    number: "01",
    title: "Exact-action approval boundary",
    problem: "Broad approval can authorize an action other than the one an operator reviewed.",
    constraints: "Evaluate each action independently, deny unknown or unsafe actions, and preserve exact request context.",
    pattern: "Requester → per-action policy decision → operator approval → worker recheck at claim.",
    control: "Action fingerprint plus request hash; approval records expire and are consumed once.",
    verification: "Tests cover missing and partial approvals, mismatched fingerprints, expiry, consumption, and replay.",
    result: "The repository implements an action-scoped approval lifecycle before dry-run worker claim.",
    limitations: "Approver identity is not universally enforced as human or out-of-band; policy is static; execution remains dry-run."
  },
  {
    number: "02",
    title: "Tamper-detecting audit boundary",
    problem: "A control decision is weak evidence if its recorded history can change unnoticed.",
    constraints: "Commit state and event together, detect modified history, and stop subsequent writes.",
    pattern: "Lifecycle action → structured event → linked hash → local verifier → health and write gate.",
    control: "The store disables writes after an invalid audit chain is detected.",
    verification: "Tests alter a stored event and assert a mismatch, unhealthy status, and rejected writes.",
    result: "The repository implements locally verifiable, hash-chained lifecycle evidence with fail-closed writes.",
    limitations: "Detection is local and hash-based. SQLite files are not OS-protected, hashes are not externally anchored, and redaction is pattern-based."
  },
  {
    number: "03",
    title: "Independent maker–verifier loop",
    problem: "A maker’s self-assessment cannot prove that its output meets the rubric.",
    constraints: "Use a fresh verifier context, structured results, bounded iterations, and per-call budget and timeout controls.",
    pattern: "Maker → isolated verifier → structured failures → bounded retry.",
    control: "Only a verifier pass clears the loop; maker confidence has no authority.",
    verification: "Tests cover context isolation, failure-only feedback, iteration caps, malformed output, and false confidence.",
    result: "The repository implements a typed verification loop with typed failure codes and spend receipts.",
    limitations: "Most tests use scripted providers; production reliability and model quality are unproven."
  }
];

const metricDefinitions = [
  ["agentsObserved", "Agents observed"],
  ["agentsOnline", "Online agents"],
  ["runningWorkItems", "Running work"],
  ["pendingApprovals", "Pending approvals"],
  ["failedOrBlocked", "Failed or blocked"]
];

export function App() {
  const [scenarioKey, setScenarioKey] = useState("populated");
  const scenario = fixtures[scenarioKey];
  const [selectedWorkItemId, setSelectedWorkItemId] = useState(scenario.focusId);

  useEffect(() => {
    setSelectedWorkItemId(scenario.focusId);
  }, [scenario.focusId, scenarioKey]);

  const selectedWorkItem = useMemo(
    () => scenario.workItems.find((item) => item.id === selectedWorkItemId) ?? null,
    [scenario.workItems, selectedWorkItemId]
  );

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <ReleaseBar />
      <SiteHeader />
      <main id="main">
        <Hero />
        <TrustRail />
        <OperationsDemo
          scenarioKey={scenarioKey}
          scenario={scenario}
          selectedWorkItem={selectedWorkItem}
          onScenarioChange={setScenarioKey}
          onWorkItemSelect={setSelectedWorkItemId}
        />
        <CaseStudies />
        <Boundaries />
      </main>
      <SiteFooter />
    </>
  );
}

function ReleaseBar() {
  return (
    <div className="release-bar">
      <div className="shell release-bar__inner">
        <span>v0.1.0-alpha</span>
        <span>Approved work-item execution: dry-run</span>
        <strong>SYNTHETIC DEMO</strong>
      </div>
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <a className="brand" href="#main" aria-label="Agent Control Stack home">
          <span className="brand__mark" aria-hidden="true">ACS</span>
          <span>Agent Control Stack</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#operations">Operations demo</a>
          <a href="#work">Agent work</a>
          <a href="#boundaries">Boundaries</a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero shell" id="product">
      <div className="hero__copy">
        <h1>Agent work you can inspect, approve, and verify.</h1>
        <p className="hero__lede">
          Agent Control Stack is a local-first control plane for policy-gated agent work. Requested actions become
          durable work items, policy decisions, exact-action approval records, leased worker claims, and
          tamper-detecting audit history.
        </p>
        <div className="hero__actions">
          <a className="button button--primary" href="#control-loop">Explore the control loop</a>
          <a className="button button--secondary" href="#operations">View synthetic operations</a>
        </div>
        <p className="alpha-note">
          <strong>Release boundary:</strong> governed work-item execution remains dry-run. Hardened OS isolation is not implemented.
        </p>
      </div>
      <ControlReceipt />
    </section>
  );
}

function ControlReceipt() {
  const rows = [
    ["Work item", "DEMO-WRK-204"],
    ["Requested action", "fs.write"],
    ["Risk", "medium"],
    ["Policy", "require approval"],
    ["Fingerprint", "recorded · value withheld"],
    ["Execution", "dry-run only"]
  ];
  return (
    <aside className="receipt" aria-label="Illustrative synthetic control receipt">
      <div className="receipt__head">
        <span>Illustrative control receipt</span>
        <strong>SYNTHETIC</strong>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>No action can be sent from this public demonstration.</p>
    </aside>
  );
}

function TrustRail() {
  const controls = [
    ["01", "Policy", "Allow, deny, or require approval for each requested action."],
    ["02", "Approval", "Bind approval records to canonical action fingerprints."],
    ["03", "Worker", "Claim approved work through a short local lease."],
    ["04", "Audit", "Verify hash-chained history and fail closed on detected inconsistency."],
    ["05", "Redaction", "Apply pattern-based redaction at audit and result boundaries."]
  ];
  return (
    <section className="control-loop shell" id="control-loop" aria-labelledby="control-loop-title">
      <div className="section-intro">
        <p>Control model</p>
        <h2 id="control-loop-title">Policy before power.</h2>
        <p>Trust is granted at explicit boundaries, not inferred from an agent request.</p>
      </div>
      <ol className="control-rail">
        {controls.map(([number, title, description]) => (
          <li key={number}>
            <span>{number}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function OperationsDemo({ scenarioKey, scenario, selectedWorkItem, onScenarioChange, onWorkItemSelect }) {
  const unavailable = scenario.metrics === null;
  return (
    <section className="operations-section" id="operations" aria-labelledby="operations-title">
      <div className="shell operations-shell">
        <div className="operations-disclosure">
          <strong>SYNTHETIC DEMO</strong>
          <span>Illustrative records. Not connected to a control-plane runtime.</span>
        </div>
        <div className="operations-heading">
          <div>
            <p>Operations proof</p>
            <h2 id="operations-title">Control states, without operational exposure.</h2>
          </div>
          <p>
            This static snapshot demonstrates how agent, work, approval, and audit states can be reviewed. It loads
            no production, user, repository, or agent-run data.
          </p>
        </div>

        <ScenarioSelector selected={scenarioKey} onChange={onScenarioChange} />

        <div className={`scenario-banner scenario-banner--${unavailable ? "unknown" : scenarioKey}`} role="status" aria-live="polite">
          <span>SYNTHETIC DATA</span>
          <p>{scenario.banner}</p>
        </div>

        {unavailable ? (
          <UnavailableState scenario={scenario} />
        ) : (
          <div id="operations-panel" className="operations-panel" role="tabpanel" aria-label={`${scenario.label} synthetic preview`}>
            <Metrics metrics={scenario.metrics} />
            <HealthChecks checks={scenario.checks} />
            <div className="ops-grid ops-grid--primary">
              <AgentRoster agents={scenario.agents} />
              <WorkQueue workItems={scenario.workItems} selectedId={selectedWorkItem?.id} onSelect={onWorkItemSelect} />
            </div>
            <div className="ops-grid ops-grid--secondary">
              <WorkItemDetail workItem={selectedWorkItem} scenario={scenario} />
              <ActivityTimeline activity={scenario.activity} />
            </div>
          </div>
        )}
        <p className="operations-footer-disclosure">
          SYNTHETIC DEMO · STATIC SNAPSHOT · NO PRODUCTION, USER, REPOSITORY, OR AGENT-RUN DATA IS LOADED
        </p>
      </div>
    </section>
  );
}

function ScenarioSelector({ selected, onChange }) {
  return (
    <div className="scenario-selector" role="tablist" aria-label="Preview state">
      <span>Preview state</span>
      <div>
        {scenarioOrder.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected === key}
            aria-controls="operations-panel"
            className={selected === key ? "is-selected" : ""}
            onClick={() => onChange(key)}
          >
            {fixtures[key].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Metrics({ metrics }) {
  return (
    <div className="metric-grid" aria-label="Synthetic operations metrics">
      {metricDefinitions.map(([key, label]) => (
        <article className="metric" key={key}>
          <span>Demo snapshot</span>
          <strong>{metrics[key]}</strong>
          <p>{label}</p>
        </article>
      ))}
      <article className={`metric metric--${metrics.auditIntegrity.status}`}>
        <span>Demo snapshot</span>
        <strong>{metrics.auditIntegrity.status}</strong>
        <p>Audit integrity · {metrics.auditIntegrity.eventCount} synthetic events</p>
      </article>
    </div>
  );
}

function HealthChecks({ checks }) {
  return (
    <section className="health-checks" aria-labelledby="health-checks-title">
      <div>
        <span>Backend contract</span>
        <h3 id="health-checks-title">Health checks</h3>
      </div>
      <dl>
        {checks.map((check) => (
          <div key={check.id}>
            <dt>{check.label}</dt>
            <dd className={`status-text status-text--${check.status}`}>{check.status}</dd>
            {check.publicCode ? <small>{check.publicCode}</small> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

function AgentRoster({ agents }) {
  return (
    <section className="ops-panel" aria-labelledby="agent-roster-title">
      <PanelHeading title="Agent roster" meta={`${agents.length} demo roles`} id="agent-roster-title" />
      {agents.length === 0 ? <EmptyMessage>No demo agents observed.</EmptyMessage> : (
        <div className="agent-list">
          {agents.map((agent) => (
            <article key={agent.id}>
              <div>
                <strong>{agent.label}</strong>
                <span>{agent.id}</span>
              </div>
              <p>{agent.role}</p>
              <div className="agent-state">
                <StatusPill value={agent.status} />
                <StatusPill value={agent.health} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkQueue({ workItems, selectedId, onSelect }) {
  return (
    <section className="ops-panel" aria-labelledby="work-queue-title">
      <PanelHeading title="Work queue" meta={`${workItems.length} demo items`} id="work-queue-title" />
      {workItems.length === 0 ? <EmptyMessage>No demo work items in this scenario.</EmptyMessage> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Work item</th><th>Status</th><th>Risk</th><th>Action</th></tr></thead>
            <tbody>
              {workItems.map((item) => (
                <tr key={item.id} className={selectedId === item.id ? "is-selected" : ""}>
                  <td>
                    <button type="button" onClick={() => onSelect(item.id)} aria-pressed={selectedId === item.id}>
                      <strong>{item.title}</strong>
                      <span>{item.id}</span>
                    </button>
                  </td>
                  <td><StatusPill value={item.status} /></td>
                  <td>{item.risk}</td>
                  <td><code>{item.actionKinds.join(", ")}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WorkItemDetail({ workItem, scenario }) {
  return (
    <section className="ops-panel detail-panel" aria-labelledby="work-detail-title">
      <PanelHeading title="Selected detail" meta="Public demo — no action sent" id="work-detail-title" />
      {!workItem ? <EmptyMessage>No demo work item selected.</EmptyMessage> : (
        <div className="detail-content">
          <div className="detail-title">
            <span>{workItem.id}</span>
            <h3>{workItem.title}</h3>
            <StatusPill value={workItem.status} />
          </div>
          <dl>
            <DetailRow label="Risk" value={workItem.risk} />
            <DetailRow label="Requester class" value={workItem.requesterClass} />
            <DetailRow label="Action" value={workItem.actionKinds.join(", ")} mono />
            <DetailRow label="Target class" value={workItem.targetClass} />
            <DetailRow label="Assigned role" value={workItem.assignedAgentId ?? "unassigned"} mono />
            {workItem.approval ? <DetailRow label="Approval" value={workItem.approval.summary} /> : null}
            {workItem.approval ? <DetailRow label="Fingerprint" value="recorded · value withheld" /> : null}
            {workItem.result ? <DetailRow label="Result category" value={workItem.result.category} mono /> : null}
            {workItem.result ? <DetailRow label="Result" value={workItem.result.summary} /> : null}
            {workItem.result?.executionMode ? <DetailRow label="Execution mode" value={workItem.result.executionMode} mono /> : null}
          </dl>
          <p className="scenario-note">{scenario.summary}</p>
        </div>
      )}
    </section>
  );
}

function ActivityTimeline({ activity }) {
  return (
    <section className="ops-panel" aria-labelledby="activity-title">
      <PanelHeading title="Activity" meta={`${activity.length} curated events`} id="activity-title" />
      {activity.length === 0 ? <EmptyMessage>No demo activity records.</EmptyMessage> : (
        <ol className="activity-list">
          {activity.map((event) => (
            <li key={event.id} className={`activity-list__item activity-list__item--${event.tone}`}>
              <time>{event.scenarioOffset}</time>
              <div>
                <strong>{event.eventType}</strong>
                <p>{event.summary}</p>
                <span>{event.subjectId}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function UnavailableState({ scenario }) {
  return (
    <div id="operations-panel" className="unavailable-state" role="tabpanel">
      <span>SYNTHETIC DATA</span>
      <h3>Demo snapshot unavailable.</h3>
      <p>{scenario.summary} No zero values or healthy state have been substituted.</p>
      <div className="unavailable-checks">
        {scenario.checks.map((check) => <span key={check.id}>{check.label}: unknown</span>)}
      </div>
    </div>
  );
}

function PanelHeading({ title, meta, id }) {
  return <div className="panel-heading"><h3 id={id}>{title}</h3><span>{meta}</span></div>;
}

function StatusPill({ value }) {
  const normalized = String(value).replaceAll("_", " ");
  return <span className={`status-pill status-pill--${value}`}>{normalized}</span>;
}

function DetailRow({ label, value, mono = false }) {
  return <div><dt>{label}</dt><dd className={mono ? "mono" : ""}>{value}</dd></div>;
}

function EmptyMessage({ children }) {
  return <p className="empty-message">{children}</p>;
}

function CaseStudies() {
  return (
    <section className="case-studies shell" id="work" aria-labelledby="work-title">
      <div className="section-intro section-intro--wide">
        <p>Selected agent-system work</p>
        <h2 id="work-title">Evidence behind the control plane.</h2>
        <p>Repository-backed control patterns, not production case studies or attributed historical accomplishments.</p>
      </div>
      <div className="case-study-list">
        {caseStudies.map((study) => (
          <article className="case-study" key={study.number}>
            <header><span>{study.number}</span><h3>{study.title}</h3></header>
            <dl>
              <CaseField label="Problem" value={study.problem} />
              <CaseField label="Constraints" value={study.constraints} />
              <CaseField label="Agent pattern" value={study.pattern} />
              <CaseField label="Approval / control" value={study.control} />
              <CaseField label="Verification" value={study.verification} />
              <CaseField label="Result" value={study.result} />
              <CaseField label="Honest limitation" value={study.limitations} />
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function CaseField({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Boundaries() {
  const current = [
    "Per-action policy decisions: allow, deny, or require approval.",
    "Exact-action approval records with expiry and consumption.",
    "Local SQLite work-item lifecycle and lease-bound worker claims.",
    "Pattern-based redaction at audit and terminal-result boundaries.",
    "Hash-chained, tamper-detecting audit verification."
  ];
  const roadmap = [
    "Governed real mutation execution behind a hardened isolation boundary.",
    "OS sandbox acceptance tests for path, network, privilege, and resource controls.",
    "Production connector hardening and public worker-result handling.",
    "Multi-user enterprise authorization and distributed worker coordination.",
    "Externally anchored or signed audit attestations."
  ];
  return (
    <section className="boundaries-section" id="boundaries" aria-labelledby="boundaries-title">
      <div className="shell boundaries-shell">
        <div className="section-intro section-intro--wide">
          <p>Boundaries and roadmap</p>
          <h2 id="boundaries-title">The alpha proves the control loop. It does not claim the machine.</h2>
          <p>Current capability and future work stay visually separate so the release boundary remains obvious.</p>
        </div>
        <div className="boundary-columns">
          <BoundaryList title="Implemented now" items={current} />
          <BoundaryList title="Roadmap — not current capability" items={roadmap} roadmap />
        </div>
        <div className="release-truth">
          <strong>Release truth</strong>
          <p>v0.1.0-alpha · approved work-item execution is dry-run · hardened OS isolation is not implemented.</p>
        </div>
      </div>
    </section>
  );
}

function BoundaryList({ title, items, roadmap = false }) {
  return (
    <article className={roadmap ? "boundary-list boundary-list--roadmap" : "boundary-list"}>
      <h3>{title}</h3>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </article>
  );
}

function SiteFooter() {
  return (
    <footer>
      <div className="shell footer-inner">
        <div><strong>Agent Control Stack</strong><span>Quiet control for agent-requested work.</span></div>
        <p>Public source link pending privacy, secret, and license review.</p>
        <p>SYNTHETIC DEMO · STATIC DATA ONLY</p>
      </div>
    </footer>
  );
}
