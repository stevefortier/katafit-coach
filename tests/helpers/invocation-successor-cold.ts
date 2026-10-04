// Actual cold OS-process read-only recovery control. Input contains no token;
// the disposable installation Store supplies its own authenticated credential.
import { readFile } from "node:fs/promises";
import { Store } from "../../src/config/store.js";
import { Actions } from "../../src/chat/actions.js";
import { InvocationActions } from "../../src/capability/invocationActions.js";
import { restRequest } from "../../src/katafit/restGet.js";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const store = new Store(input.home);
await store.init();
const adapter = new InvocationActions({
  origin: input.origin,
  token: store.secrets.token!,
  secrets: [],
  directory: input.home,
  admission: input.admission,
  ledger: new Actions(store),
  current: () => false,
});
const result = await adapter.execute(input.request);
const parsed = JSON.parse(result.content[0].text);
const canonical = parsed.observation?.local_effect?.resource_id
  ? JSON.parse(
      (
        (await restRequest(
          input.origin,
          store.secrets.token!,
          {
            method: "GET",
            path: "/api/plans/" + parsed.observation.local_effect.resource_id,
          },
          new AbortController().signal,
          [],
        )) as any
      ).content[0].text,
    )
  : undefined;
console.log(
  JSON.stringify({
    recovered: parsed.recovered,
    error: parsed.error,
    observation: parsed.observation,
    canonical_plan_id: canonical?._id,
    unresolved: new Actions(store).unresolved(),
  }),
);
