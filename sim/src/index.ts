// Weekend-gap simulator. Serves the broker-only-margin vs Hapax comparison as JSON so the write-up,
// the dashboard, or a reviewer can reproduce the lender-loss numbers. Pure computation, no chain access.
//
//   GET  /sim            run the default demo scenario
//   POST /sim {..params} override any SimParams field (holdings, weekendPath, haircuts, ...)
import { env } from "@hapax/shared/env";
import { log as mkLog, serve } from "@hapax/shared/http";
import { defaultParams, simulate, type SimParams } from "./scenario.ts";

const log = mkLog("sim");

serve("sim", Number(env("SIM_PORT", "8790")), {
  "GET /sim": () => simulate(defaultParams()),
  "POST /sim": (body: Partial<SimParams>) => simulate({ ...defaultParams(), ...body }),
});

const d = simulate(defaultParams());
log(`weekend-gap simulator ready. default scenario: ${d.verdict.summary}`);
