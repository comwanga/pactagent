/*
 * Live demonstration configuration reader.
 *
 * This module reads environment variables only. It deliberately imports no
 * workflow, relay, signer, Cashu, or settlement modules so that browser
 * acceptance tests can depend on it without pulling application logic into
 * the test boundary.
 */

export interface PactAgentLiveDemoConfig {
  readonly relayUrl: string;
  readonly testMintUrl: string;
  readonly requesterPrivateKeyHex: string;
  readonly providerPrivateKeyHex: string;
  readonly escrowAuthorityPrivateKeyHex: string;
  readonly normalSpendKeyHex: string;
  readonly refundSpendKeyHex: string;
  readonly fundingToken: string;
  readonly fundingReference: string;
  readonly stateDirectory: string;
}

export function readLiveDemoConfigFromEnv(): PactAgentLiveDemoConfig | undefined {
  const relayUrl = process.env.PACTAGENT_LIVE_RELAY_URL;
  const testMintUrl = process.env.PACTAGENT_CASHU_TEST_MINT_URL;
  const requesterPrivateKeyHex = process.env.PACTAGENT_LIVE_REQUESTER_PRIVATE_KEY;
  const providerPrivateKeyHex = process.env.PACTAGENT_LIVE_PROVIDER_PRIVATE_KEY;
  const escrowAuthorityPrivateKeyHex = process.env.PACTAGENT_LIVE_ESCROW_AUTHORITY_PRIVATE_KEY;
  const normalSpendKeyHex = process.env.PACTAGENT_LIVE_NORMAL_SPEND_KEY;
  const refundSpendKeyHex = process.env.PACTAGENT_LIVE_REFUND_SPEND_KEY;
  const fundingToken = process.env.PACTAGENT_LIVE_FUNDING_TOKEN;
  const fundingReference = process.env.PACTAGENT_LIVE_FUNDING_REFERENCE;
  const stateDirectory = process.env.PACTAGENT_LIVE_STATE_DIRECTORY;

  if (
    !relayUrl ||
    !testMintUrl ||
    !requesterPrivateKeyHex ||
    !providerPrivateKeyHex ||
    !escrowAuthorityPrivateKeyHex ||
    !normalSpendKeyHex ||
    !refundSpendKeyHex ||
    !fundingToken ||
    !fundingReference ||
    !stateDirectory
  ) {
    return undefined;
  }

  return {
    relayUrl,
    testMintUrl,
    requesterPrivateKeyHex,
    providerPrivateKeyHex,
    escrowAuthorityPrivateKeyHex,
    normalSpendKeyHex,
    refundSpendKeyHex,
    fundingToken,
    fundingReference,
    stateDirectory,
  };
}
