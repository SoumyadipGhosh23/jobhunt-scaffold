// Entry point. Usage: tsx src/main.ts <verify|dry-run|run>
//
// This is a stub for now — each command will be wired up as we build the
// corresponding module (sources.ts, filters.ts, rank.ts, report.ts).

const command = process.argv[2];

async function main() {
  switch (command) {
    case "verify":
      console.log("verify: not implemented yet (Step 2: ATS fetcher)");
      break;
    case "dry-run":
      console.log("dry-run: not implemented yet (Step 3: filters)");
      break;
    case "run":
      console.log("run: not implemented yet (Step 5: ranking + report)");
      break;
    default:
      console.error(`Unknown command: "${command}"`);
      console.error("Usage: tsx src/main.ts <verify|dry-run|run>");
      process.exit(1);
  }
}

main();
