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
  } catch (err) {
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
  const LAST_POST = (await kv.get<{ id: number; at: Date }>(["last_post"])).value ??
    { id: 2916, at: new Date(1708693530000) };
  console.log(`Last id: ${LAST_POST.id}, time: ${LAST_POST.at.getTime()}`);

  const dobs = await fetchDobArticles(LAST_POST.at);
  console.log("Fetched");

  let skip = true;
  for (let i = dobs.length - 1; i >= 0; i--) {
    const dob = dobs[i];
    if (skip) {
      skip = !(dob.id === LAST_POST.id && dob.post_date.getTime() === LAST_POST.at.getTime());
      continue;
    }
    console.log(`Process id: ${dob.id}, time: ${dob.post_date.getTime()}`);
    console.debug(dob);
    await post(await dob2Bsky(dob)).then(() => {
      console.log(`Posted id: ${dob.id}, time: ${dob.post_date.getTime()}`);
      return new Promise((resolve) => setTimeout(resolve, 10000));
    }, (err) => {
      if (err instanceof Error && err.message === "Skipped as reply") {
        console.log(err.message);
      } else {
        return Promise.reject(err);
      }
    });
    await kv.set(["last_post"], { id: dob.id, at: dob.post_date });
  }

  console.log("End");
}
