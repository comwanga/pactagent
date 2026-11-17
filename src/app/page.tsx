import { RequesterTransactionApp } from "./requester-transaction-app";
import { connection } from "next/server";
import { privateDataRetentionDays } from "@/lib/private-data-policy";

export default async function Home() {
  await connection();
  return <RequesterTransactionApp retentionDays={privateDataRetentionDays()} />;
}
