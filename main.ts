import { agent, post } from "./bsky.ts";
import { dob2Bsky, fetchDobArticles } from "./dob/mod.ts";

const kv = await Deno.openKv();

if (Deno.env.get("ENABLE")) {
  await kv.set(["enable"], true);
}

Deno.cron("dob", { minute: { every: 10 } }, { backoffSchedule: [] }, async () => {
  if (!(await kv.get<boolean>(["enable"])).value) {
    console.log("Invocation skipped");
    return;
  }
  try {
    await main();
  } catch (err: any) {
    const text = `@me\n${err}${
      err?.cause
        ? `\nCaused by ${err.cause instanceof Error ? err.cause : JSON.stringify(err.cause)}`
        : ""
    }`.slice(0, 300);
    console.error(err);
    await kv.set(["enable"], false);
    await agent.post({
      text,
      facets: [{
        index: { byteStart: 0, byteEnd: 3 },
        features: [{
          $type: "app.bsky.richtext.facet#mention",
          did: "did:plc:adt6lkfilisp26px7ivmpy7l",
        }],
      }],
    });
    return await Promise.reject(err);
  }
});

async function main() {
  const LATEST = (await kv.get<{ id: number; at: Date }>(["latest"])).value ??
    { id: 3350, at: new Date(1712398894000) };
  console.log(`Latest id: ${LATEST.id}, time: ${LATEST.at.getTime()}`);

  const dobs = await fetchDobArticles(LATEST.at);
  console.log("Fetched");

  let prev_at: Date | undefined;
  let latest = { ...LATEST };
  for (let i = dobs.length - 1; i >= 0; i--) {
    const dob_raw = dobs[i];
    if (dob_raw.id <= LATEST.id && dob_raw.post_date <= LATEST.at) {
      prev_at = dob_raw.post_date;
      continue;
    }
    const dob = dob_raw.post_date <= prev_at!
      ? { ...dob_raw, post_date: new Date(prev_at!.getTime() + 1000) }
      : dob_raw;
    prev_at = dob.post_date;
    console.log(`Process id: ${dob.id}, time: ${dob.post_date.getTime()}`);
    console.debug(dob);
    await (async () => post(await dob2Bsky(dob)))().then(() => {
      console.log(`Posted id: ${dob.id}, time: ${dob.post_date.getTime()}`);
      return new Promise((resolve) => setTimeout(resolve, 10000));
    }, (err) => {
      if (err instanceof Error && err.message === "Skipped as reply") {
        console.log(err.message);
      } else {
        return Promise.reject(err);
      }
    });
    latest = {
      id: Math.max(dob_raw.id, latest.id),
      at: new Date(Math.max(dob_raw.post_date.getTime(), latest.at.getTime())),
    };
    await kv.set(["latest"], latest);
  }

  console.log("End");
}
