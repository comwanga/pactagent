import { evaluateServiceOffer } from "@/domain/pact-agents";
import { createPactDemoFixtures } from "@/lib/pact-fixtures";
import { getProjectStatus } from "@/lib/status";

export default function Home() {
  const status = getProjectStatus();
  const demo = createPactDemoFixtures();
  const evaluation = evaluateServiceOffer({
    requester: demo.requester,
    provider: demo.provider,
    offer: demo.offer,
    escrowDescriptor: demo.escrowDescriptor,
  });

  return (
    <main>
      <section className="hero">
        <nav aria-label="Project identity">
          <span className="mark" aria-hidden="true">P</span>
          <span>PACTAGENT</span>
          <span className="phase">APPLICATION ON OPEN PROTOCOLS</span>
        </nav>

        <div className="heroCopy">
          <p className="eyebrow">Application-level machine economy</p>
          <h1>Agents make pacts.<br /><em>Protocols keep the truth.</em></h1>
          <p className="lede">
            PactAgent is an application for autonomous agents contracting and settling over
            open Bitcoin protocols. It builds on Pontmore, Nostr, and Cashu.
          </p>
        </div>

        <div className="signal" aria-hidden="true">
          <span>NOSTR</span><i /><span>PONTMORE</span><i /><span>CASHU</span>
        </div>
      </section>

      <section className="statusSection" aria-labelledby="status-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow dark">Application status</p>
            <h2 id="status-heading">Implemented foundation. Offline demo.</h2>
          </div>
          <p>The repository includes relay and isolated-signer integrations. This page renders deterministic fixtures without connecting to a relay, mint, AI model, signer, or funds.</p>
        </div>

        <dl className="statusGrid">
          <div><dt>Application</dt><dd><span className="dot active" />{status.application}</dd></div>
          <div><dt>Nostr</dt><dd><span className="dot modeled" />Adapters ready</dd></div>
          <div><dt>Cashu</dt><dd><span className="dot modeled" />Descriptor only</dd></div>
          <div><dt>AI execution</dt><dd><span className="dot neutral" />Not implemented</dd></div>
        </dl>
      </section>

      <section className="modelSection" aria-labelledby="agents-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow dark">One bounded service</p>
            <h2 id="agents-heading">Summarize a document for ≤ 500 sats.</h2>
          </div>
          <p>Issue #9 selects P002 using signed relay records. Issue #10 revalidates those references before P001 creates the agreement proposal.</p>
        </div>

        <div className="projectionGrid">
          <article>
            <p className="cardLabel">P001 · Requester</p>
            <strong>Discover &amp; verify</strong>
            <span>Budget: 500 sats</span>
            <small>Independent Nostr identity · cashu only · 15-minute escrow maximum</small>
          </article>
          <article className="swapCard">
            <p className="cardLabel">#9 to #10 boundary</p>
            <strong>1 selected provider</strong>
            <span>{demo.serviceOffer.content.amount_sats} sats · {evaluation.authorized ? "authorized" : "rejected"}</span>
            <small>The authenticated offer supplies price and execution terms. P002 must still sign a separate acceptance.</small>
          </article>
          <article>
            <p className="cardLabel">P002 · Provider</p>
            <strong>document-summary</strong>
            <span>Minimum: 200 sats</span>
            <small>Text/PDF · 1 MB maximum · 5-minute execution maximum</small>
          </article>
        </div>
      </section>

      <section className="boundary" aria-labelledby="boundary-heading">
        <div>
          <p className="eyebrow dark">Application and protocol boundary</p>
          <h2 id="boundary-heading">Public history. Private payloads.</h2>
          <p className="boundaryNote">Current fixture state: <strong>proposal inputs validated; provider acceptance required</strong></p>
        </div>
        <ol>
          <li><span>00</span><strong>Identity</strong><p>PIP-00 definitions advertise capabilities and reference a default escrow.</p></li>
          <li><span>01</span><strong>Escrow</strong><p>PIP-01 declares Cashu compatibility; tokens and secrets stay private.</p></li>
          <li><span>PA</span><strong>History</strong><p>PactAgent application events carry the service lifecycle; they are not Pontmore PIPs or a Nostr standard.</p></li>
          <li><span>03</span><strong>Swap policy</strong><p>PIP-03 remains associated with Pontmore swap disputes and timeouts; it does not define PactAgent agreement recovery.</p></li>
        </ol>
      </section>

      <footer><span>PactAgent</span><span>BOSS Battle 2026 · Freedom Stack + Machine Money</span></footer>
    </main>
  );
}
