import { useAccount } from "../lib/account";
import { deployment } from "../lib/chain";
import { Activity } from "../components/Activity";

export function ActivityView() {
  const a = useAccount();
  const s = a.snap!;
  const as = a.assignment;
  return (
    <section className="card" aria-labelledby="feedTitle">
      <div className="head">
        <h2 id="feedTitle">Activity</h2>
        <span className="label">your account, your agent, the risk engine and your broker</span>
      </div>
      <Activity events={a.events} decisions={as && as.facility.toLowerCase() === a.facility?.toLowerCase() ? as.history : []} agent={s.agent ?? as?.agent ?? null} deployment={deployment!} />
    </section>
  );
}
