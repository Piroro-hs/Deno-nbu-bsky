import { agent, post } from "./bsky.ts";
import { dob2Bsky, fetchDobArticles } from "./dob/mod.ts";

const kv = await Deno.openKv();

if (Deno.env.get("ENABLE")) {
  await kv.set(["enable"], true);
} else if (Deno.env.get("DISABLE")) {
  await kv.set(["enable"], false);
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
  const identifier = Deno.env.get("BSKY_ID")!;
  const password = Deno.env.get("BSKY_PASSWORD")!;
  await agent.login({ identifier, password });

  const latest = (await kv.get<{ id: number; at: Date }>(["latest"])).value ??
    { id: 3350, at: new Date(1712398894000) };
  console.log(`Latest id: ${latest.id}, time: ${latest.at.getTime()}`);

  const dobs = await fetchDobArticles(latest.at);
  console.log("Fetched");

  let prev_at: Date | undefined;
  let latest_processed = { ...latest };
  for (let i = dobs.length - 1; i >= 0; i--) {
    const dob_raw = dobs[i];
    if (dob_raw.id <= latest.id && dob_raw.post_date <= latest.at) {
      prev_at = dob_raw.post_date;
      continue;
    }
    const dob = dob_raw.post_date <= prev_at!
      ? { ...dob_raw, post_date: new Date(prev_at!.getTime() + 1000) }
      : dob_raw;
    prev_at = dob.post_date;
    console.log(`Process id: ${dob.id}, time: ${dob.post_date.getTime()}`);
    console.debug(dob);
    if (dob.source_type !== "yt") {
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
    }
    latest_processed = {
      id: Math.max(dob_raw.id, latest_processed.id),
      at: new Date(Math.max(dob_raw.post_date.getTime(), latest_processed.at.getTime())),
    };
    await kv.set(["latest"], latest_processed);
  }

  console.log("End");
}
