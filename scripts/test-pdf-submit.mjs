import { readFileSync } from "node:fs";

const b64 = readFileSync(".local/real-pdf.b64", "utf-8").trim();
const body = JSON.stringify({
  privateDocument: b64,
  mediaType: "application/pdf",
  maximumBudgetSats: "500",
  fundingReference: "cashu-mint001",
  privatePrompt: "Summarize concisely",
});

async function main() {
  const bootstrapResp = await fetch("http://localhost:3000/api/runtime/bootstrap", {
    method: "POST",
    headers: { Authorization: "Bearer e5a141db428bc322e38382f404ee92c0dcae6fc7fa7bea84fa01d74d0fd89d94", "Content-Type": "application/json" },
  });
  console.log("Bootstrap:", bootstrapResp.status, await bootstrapResp.text());

  const txnResp = await fetch("http://localhost:3000/api/transactions", {
    method: "POST",
    headers: {
      Authorization: "Bearer e5a141db428bc322e38382f404ee92c0dcae6fc7fa7bea84fa01d74d0fd89d94",
      "Content-Type": "application/json",
      "Idempotency-Key": "real-pdf-node-001",
    },
    body,
  });
  console.log("Transaction:", txnResp.status, await txnResp.text());
}

main().catch(err => { console.error(err); process.exit(1); });
