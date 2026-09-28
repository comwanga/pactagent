"use client";

import { useState } from "react";

import { PactAgentApiClient, friendlyErrorMessage, type SessionInfo } from "@/lib/pactagent-api-client";

export interface ConnectResult {
  readonly client: PactAgentApiClient;
  readonly session: SessionInfo;
}

export function ConnectPanel({
  demoAvailable,
  onConnected,
  busy,
}: {
  demoAvailable: boolean;
  onConnected: (result: ConnectResult) => void;
  busy: boolean;
}): React.ReactElement {
  const [mode, setMode] = useState<"demo" | "token">(demoAvailable ? "demo" : "token");
  const [demoCode, setDemoCode] = useState("");
  const [token, setToken] = useState("");
  const [fundingReference, setFundingReference] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [connecting, setConnecting] = useState(false);

  async function handleDemo(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setConnecting(true);
    const client = new PactAgentApiClient();
    try {
      const session = await client.startSession(demoCode ? { demoCode } : {});
      if (!session.authenticated) {
        setError("Demo session was rejected by the runtime.");
        return;
      }
      onConnected({ client, session });
    } catch (err) {
      setError(friendlyErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleTokenConnect(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setConnecting(true);
    const client = new PactAgentApiClient();
    try {
      // The funding reference is sent to the server and stored in an httpOnly
      // cookie — never in JS-accessible browser storage.
      const session = await client.startSession({ token, fundingReference });
      if (!session.authenticated) {
        setError("Invalid runtime token.");
        return;
      }
      onConnected({ client, session });
    } catch (err) {
      setError(friendlyErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  const inFlight = connecting || busy;

  return (
    <section className="section connectPanel" aria-labelledby="connect-heading">
      <h2 id="connect-heading">Connect to the PactAgent runtime</h2>
      <p className="sectionNote">
        The runtime holds the bearer token and ecash; the browser never sees either secret.
        Authentication is via an httpOnly session cookie.
      </p>

      {demoAvailable && (
        <form onSubmit={handleDemo} className="connectForm demoForm">
          <h3 className="connectSubhead">One-click demo</h3>
          <p className="inputHelp">
            Connect to a pre-configured Cashu test mint with test ecash. No credentials to type.
          </p>
          <label htmlFor="demo-code">Demo code {demoCodeOptional()}</label>
          <input
            id="demo-code"
            type="text"
            value={demoCode}
            onChange={(e) => setDemoCode(e.target.value)}
            autoComplete="off"
            placeholder="Leave blank if no code is required"
            aria-describedby="demo-code-help"
          />
          <small id="demo-code-help" className="inputHelp">
            Shown on the demo slide if the operator set PACTAGENT_DEMO_CODE.
          </small>
          {error && mode === "demo" && <p role="alert" className="errorText">{error}</p>}
          <button type="submit" className="primaryBtn" disabled={inFlight}>
            {connecting ? "Connecting…" : "Enter demo"}
          </button>
        </form>
      )}

      <div className="connectDivider" role="separator" aria-label="or">
        <span>or bring your own runtime</span>
      </div>

      <form
        onSubmit={handleTokenConnect}
        className="connectForm"
        onChange={() => setMode("token")}
      >
        <h3 className="connectSubhead">Use my own runtime</h3>
        <label htmlFor="api-token">Runtime API token</label>
        <input
          id="api-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoComplete="off"
          aria-describedby="api-token-help"
        />
        <small id="api-token-help" className="inputHelp">
          Exchanged for an httpOnly cookie — never stored in JavaScript.
        </small>

        <label htmlFor="funding-ref">Funding reference</label>
        <input
          id="funding-ref"
          type="text"
          value={fundingReference}
          onChange={(e) => setFundingReference(e.target.value)}
          required
          autoComplete="off"
          aria-describedby="funding-ref-help"
        />
        <small id="funding-ref-help" className="inputHelp">
          Opaque reference to pre-acquired test ecash resolved by the runtime.
        </small>

        {error && mode === "token" && <p role="alert" className="errorText">{error}</p>}

        <button type="submit" disabled={inFlight || !token || !fundingReference}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </form>
    </section>
  );
}

function demoCodeOptional(): string {
  return "(optional)";
}
