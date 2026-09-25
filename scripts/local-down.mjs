import { COMPOSE_FILE } from "./local-env.mjs";
import { runChecked } from "./local-process.mjs";

await runChecked("docker", ["compose", "-f", COMPOSE_FILE, "down", "--remove-orphans"]);
console.log("PASS: PactAgent local Caddy and Strfry are stopped");
console.log("PASS: local CA, relay database, environment, and SQLite state were preserved");
