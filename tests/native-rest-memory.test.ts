import test from "node:test";
import assert from "node:assert/strict";
import { restSession } from "../src/katafit/restSession.js";
test("optional memory is acquired once, cached internally, explicit search is new and persistence fails visibly", async () => {
  let reads = 0,
    opens = 0;
  const items: any[] = [{ text: "Synthetic acquired memory" }];
  const session = restSession(
    () => true,
    async () => {
      opens++;
      return {
        recallMemories: async () => {
          reads++;
          return items;
        },
        memoryPartial: () => false,
        dispose: async () => {},
      } as any;
    },
  );
  assert.equal(opens, 0);
  assert.equal(await session.recallMemories("first"), items);
  assert.equal(await session.recallMemories("continuation"), items);
  assert.equal(reads, 1);
  await session.tools
    .find((t) => t.name === "coach_memory_search")!
    .execute("id", { query: "explicit new fetch" });
  assert.equal(reads, 2);
  await assert.rejects(
    session.recordInteraction({ human_text: "a", assistant_text: "b" }),
    /MEMORY_UNAVAILABLE/,
  );
  assert.match(session.capabilityGuidance, /persistence is not yet supported/);
  await session.dispose();
});
test("memory denial never revokes REST lifetime and reopen makes no implicit memory request", async () => {
  let opens = 0;
  const open = async (): Promise<any> => {
    opens++;
    throw Error("OPERATOR_NOT_AUTHORIZED");
  };
  const session = restSession(() => true, open);
  await assert.rejects(session.recallMemories("first"), /MEMORY_UNAVAILABLE/);
  await assert.rejects(
    session.recallMemories("continued"),
    /MEMORY_UNAVAILABLE/,
  );
  await session.authorize();
  assert.equal(opens, 1);
  const resumed = restSession(() => true, open, false);
  await assert.rejects(
    resumed.recallMemories("retained"),
    /MEMORY_UNAVAILABLE/,
  );
  assert.equal(opens, 1);
  await resumed.authorize();
  await session.dispose();
  await resumed.dispose();
});
