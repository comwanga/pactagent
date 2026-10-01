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
  const [showToken, setShowToken] = useState(false);
  const [demoError, setDemoError] = useState<string | undefined>();
  const [token, setToken] = useState("");
  const [fundingReference, setFundingReference] = useState("");
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [connecting, setConnecting] = useState(false);

  async function handleDemo(): Promise<void> {
    setDemoError(undefined);
    setConnecting(true);
    const client = new PactAgentApiClient();
    try {
      const session = await client.startSession({});
      if (!session.authenticated) {
        setDemoError("Demo session was rejected by the runtime.");
        return;
      }
      onConnected({ client, session });
    } catch (err) {
      setDemoError(friendlyErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleTokenConnect(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setTokenError(undefined);
    setConnecting(true);
    const client = new PactAgentApiClient();
    try {
      const session = await client.startSession({ token, fundingReference });
      if (!session.authenticated) {
        setTokenError("Invalid runtime token.");
        return;
      }
      onConnected({ client, session });
    } catch (err) {
      setTokenError(friendlyErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  const inFlight = connecting || busy;

  return (
    <div className="connectView">
      <div className="connectCard">
        <p className="eyebrow">Application-level machine economy</p>
        <h1>Agents make pacts.<br /><em>Protocols keep the truth.</em></h1>
        <p className="lede">
          Submit a private document. An autonomous agent discovers a provider, signs a service
          agreement, funds Cashu escrow, executes the summary, and settles — all over Nostr and Cashu.
        </p>

        {demoAvailable ? (
          <>
            <button type="button" className="demoBtn" onClick={handleDemo} disabled={inFlight}>
              {connecting ? "Connecting…" : "Enter demo"}
            </button>
            {demoError && <p className="connectError">{demoError}</p>}
            <button type="button" className="tokenToggle" onClick={() => setShowToken(!showToken)}>
              {showToken ? "Hide token connect" : "Use my own runtime"}
            </button>
          </>
        ) : (
          <p className="connectError">Demo mode is not enabled. Set PACTAGENT_DEMO_MODE=1.</p>
        )}

        {showToken && (
          <form onSubmit={handleTokenConnect} className="tokenForm">
            <label htmlFor="api-token">Runtime API token</label>
            <input
              id="api-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
            />
            <label htmlFor="funding-ref">Funding reference</label>
            <input
              id="funding-ref"
              type="text"
              value={fundingReference}
              onChange={(e) => setFundingReference(e.target.value)}
              required
              autoComplete="off"
            />
            {tokenError && <p className="connectError">{tokenError}</p>}
            <button type="submit" disabled={inFlight || !token || !fundingReference}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
