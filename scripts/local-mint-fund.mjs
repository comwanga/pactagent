import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Mint, Wallet, getEncodedToken } from "@cashu/cashu-ts";

import { PROJECT_ROOT, loadLocalEnvironment } from "./local-env.mjs";

const FUNDING_AMOUNT = 400;
const ENV_PATH = resolve(PROJECT_ROOT, ".env");

const environment = loadLocalEnvironment();
const mintUrl = environment.PACTAGENT_CASHU_TEST_MINT_URL;
if (!mintUrl) {
  console.error("PACTAGENT_CASHU_TEST_MINT_URL is not set in .env");
  process.exit(1);
}

console.log(`Minting ${FUNDING_AMOUNT} sat from ${mintUrl} ...`);

const quote = await (await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ amount: FUNDING_AMOUNT, unit: "sat" }),
})).json();

await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quote.quote}`);

const mint = new Mint(mintUrl);
const wallet = new Wallet(mint, { unit: "sat" });
await wallet.loadMint();
const proofs = await wallet.mintProofsBolt11(FUNDING_AMOUNT, quote.quote);

const token = getEncodedToken({ mint: mintUrl, proofs });
const total = proofs.reduce((sum, proof) => sum + proof.amount.toBigInt(), 0n);

const lines = readFileSync(ENV_PATH, "utf8").split("\n");
const tokenLine = `PACTAGENT_LIVE_FUNDING_TOKEN=${token}`;
const index = lines.findIndex((line) => line.startsWith("PACTAGENT_LIVE_FUNDING_TOKEN="));
if (index === -1) {
  lines.push(tokenLine);
} else {
  lines[index] = tokenLine;
}
writeFileSync(ENV_PATH, lines.join("\n"));

console.log(`PASS: minted ${total} sat in ${proofs.length} proof(s)`);
console.log(`PASS: funding token written to .env`);
