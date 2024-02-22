import { unescape } from "https://deno.land/std@0.215.0/html/entities.ts";

import atp from "npm:@atproto/api@^0.9.6";
// import { XRPCError } from "npm:@atproto/xrpc@^0.4.1";
import Graphemer from "npm:graphemer@^1.4.0";
import { DOMParser } from "npm:linkedom@^0.16.8";
import { z } from "npm:zod@^3.21.4";

import { agent, post as bskyPost } from "./bsky.ts";
import { dobSchema, twPhotoSchema, twVideoSchema } from "./schema.ts";

const kv = await Deno.openKv();

if (Deno.env.get("ENABLE")) {
  await kv.set(["enable"], true);
}

Deno.cron("dob", { hour: { every: 1 } }, { backoffSchedule: [] }, async () => {
  if (!((await kv.get<boolean>(["enable"])).value ?? true)) {
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
    }`.slice(0,300);
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

async function getDobApiKey(): Promise<string> {
  const document = (new DOMParser()).parseFromString(
    await fetch("https://denonbu.jp").then((res) => res.text()),
    "text/html",
  );
  return Promise.any(
    Array.from(
      document.querySelectorAll("script[src^=/_next/static/chunks/]") as ArrayLike<{ src: string }>,
    ).map(async (script) => {
      const chunk = await fetch(`https://denonbu.jp${script.src}`).then((res) => res.text());
      const match = /"X-API-KEY":"(\w+)"/.exec(chunk);
      return match?.[1] ?? Promise.reject(new Error("X-API-KEY not found"));
    }),
  );
}

async function dobRequest(
  path: string,
  { key, token }: { key: string; token?: string },
): Promise<unknown> {
  const { status, payload } = await fetch(
    `https://denonbu.jp/backend-api/v1.0.0/${path}`,
    { headers: { "X-API-KEY": key, ...token ? { Authorization: `Bearer ${token}` } : {} } },
  ).then((res) => res.json()) as { status: "SUCCESS" | "ERROR"; payload: unknown };
  return status === "SUCCESS"
    ? payload
    : Promise.reject(new Error(`API request for ${path} failed`, { cause: payload }));
}

async function expandShortendLink(link: string): Promise<string> {
  return (await fetch(link, { redirect: "manual" })).headers.get("Location") || link;
}

async function dob2bsky(dob: z.infer<typeof dobSchema>): Promise<void> {
  // const postDate;
  let text = "";
  let facets: atp.AppBskyRichtextFacet.Main[] = [];
  let embed;
  switch (dob.source_type) {
    case "tw": {
      const knownAccounts = [
        "Okubo_denonbu",
        "denonbu_world",
        "Shinsaibashi_dn",
        "IKEBUKURO_WRLD",
        "denonbu",
        "Divermy_mn",
        "BUKURO_denonbu",
        "AKIBA_denonbu",
        "neotokyo_dn",
        "Reml_xxx",
        "Ema_Toramaru",
        "Neri_Amemura",
        "Momoko_Shoji",
      ];
      const reply = dob.body.match(/^@(\w{1,15})/);
      if (reply && !knownAccounts.includes(reply[1])) {
        return Promise.reject(new Error("Skipped as reply"));
      }
      const body = unescape(dob.body);
      const account = `${dob.account.account_name}@${dob.account.account_id}`;
      const footer = `${account} ⧉🐦︎`;
      const textSegments: string[] = [];
      const textSegmentsInfo = [];
      const facetRegex = /(https:\/\/t\.co\/[\w\-.~!$&'\(\)*+,;=:@]+)[\s--[\r\n]]*|([#＃]\S+)/vdg;
      let lastIndex = 0;
      for (const { "1": tco, "2": tag, indices } of body.matchAll(facetRegex)) {
        textSegments.push(body.slice(lastIndex, indices![0][0]));
        textSegmentsInfo.push({ type: "text" });
        if (tco) {
          textSegments.push("");
          textSegmentsInfo.push({
            type: "tco",
            tco: expandShortendLink(tco),
            padEnd: indices![0][1] !== indices![1][1],
          });
        } else {
          textSegments.push(tag);
          textSegmentsInfo.push({ type: "tag" });
        }
        lastIndex = indices![0][1];
      }
      textSegments.push(body.slice(lastIndex));
      textSegmentsInfo.push({ type: "text" });
      const encoder = new TextEncoder();
      const graphemer = new Graphemer.default();
      const allowedGraphemeLength = 300 - graphemer.countGraphemes(footer) - 2; // \n\n
      let byteLength = 0;
      let graphemeLength = 0;
      let skip = false;
      for (let i = 0; i < textSegments.length; i++) {
        if (skip) {
          textSegments[i] = "";
          continue;
        }
        switch (textSegmentsInfo[i].type) {
          case "text": {
            const nextGraphemeLength = graphemer.countGraphemes(textSegments[i]);
            if (graphemeLength + nextGraphemeLength > allowedGraphemeLength) {
              const leftGraphemeLength = allowedGraphemeLength - graphemeLength - 1;
              const iter = graphemer.iterateGraphemes(textSegments[i]);
              graphemeLength = allowedGraphemeLength;
              textSegments[i] = `${
                Array.from({ length: leftGraphemeLength }, () => iter.next().value).join("")
              }…`;
              skip = true;
            } else {
              graphemeLength += nextGraphemeLength;
            }
            byteLength += encoder.encode(textSegments[i]).byteLength;
            break;
          }
          case "tco": {
            const url = await textSegmentsInfo[i].tco!;
            if (
              !url.startsWith(`https://twitter.com/i/web/status/${dob.uid}`) &&
              !url.startsWith(`${dob.account.url}/status/${dob.uid}`)
            ) {
              const hostname = new URL(url).hostname;
              const nextGraphemeLength = graphemer.countGraphemes(hostname);
              if (graphemeLength + nextGraphemeLength > allowedGraphemeLength) {
                skip = true;
                break;
              }
              const byteStart = byteLength;
              byteLength += encoder.encode(hostname).byteLength;
              facets.push({
                index: { byteStart, byteEnd: byteLength },
                features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
              });
              graphemeLength += nextGraphemeLength;
              textSegments[i] = hostname;
              if (textSegmentsInfo[i].padEnd && graphemeLength < allowedGraphemeLength) {
                byteLength++;
                graphemeLength++;
                textSegments[i] += " ";
              }
            }
            break;
          }
          case "tag": {
            const tag = textSegments[i];
            const nextGraphemeLength = graphemer.countGraphemes(tag);
            if (graphemeLength + nextGraphemeLength > allowedGraphemeLength) {
              skip = true;
              break;
            }
            const byteStart = byteLength;
            byteLength += encoder.encode(tag).byteLength;
            facets.push({
              index: { byteStart, byteEnd: byteLength },
              features: [{ $type: "app.bsky.richtext.facet#tag", tag: tag.slice(1) }],
            });
            graphemeLength += nextGraphemeLength;
            break;
          }
          default:
            break;
        }
      }
      if (textSegments.some((text) => text)) {
        byteLength += 2;
        textSegments.push("\n\n");
      }
      const byteStart = byteLength;
      byteLength += encoder.encode(account).byteLength;
      facets.push({
        index: { byteStart, byteEnd: byteLength },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: dob.account.url }],
      });
      facets.push({
        index: { byteStart: byteLength + 1, byteEnd: byteLength + 1 + 10 },
        features: [{
          $type: "app.bsky.richtext.facet#link",
          uri: `${dob.account.url}/status/${dob.uid}`,
        }],
      });
      textSegments.push(footer);
      const video = dob.media
        ?.filter((media): media is z.infer<typeof twVideoSchema> => media.type !== "photo")[0];
      text = textSegments.join("");
      embed = dob.media && video
        ? {
          uri: video.variants.filter((variant) => variant.content_type === "video/mp4")
            .reduce<[number, string?]>(
              (acc, cur) => cur.bit_rate! > acc[0] ? [cur.bit_rate!, cur.url] : acc,
              [0, undefined],
            )[1]!,
          title: "📼 Video",
          description: `from ${dob.account.account_name}`,
          thumb: video.preview_image_url,
        }
        : { images: (dob.media as z.infer<typeof twPhotoSchema>[]).map((photo) => photo.url) };
      break;
    }
    case "yt": {
      const title = unescape(dob.title);
      const body = unescape(dob.body);
      const rt = new atp.RichText({ text: `${title}\n\n${body}` });
      rt.detectFacetsWithoutResolution();
      text = rt.text;
      let byteLength = rt.unicodeText.length;
      facets =
        rt.facets?.filter((facet) =>
          facet.features.some((feat) =>
            atp.AppBskyRichtextFacet.isLink(feat) ||
            atp.AppBskyRichtextFacet.isTag(feat)
          )
        ) ?? [];
      if (rt.graphemeLength > 300) {
        const iter = new Graphemer.default().iterateGraphemes(text);
        byteLength = rt.unicodeText.utf16IndexToUtf8Index(
          Array.from({ length: 299 }, () => iter.next().value).join("").length,
        );
        byteLength = Math.min(
          facets
            .filter(({ index: { byteStart, byteEnd } }) =>
              byteStart < byteLength && byteLength < byteEnd
            )
            .reduce(
              (a, { index: { byteStart: b } }) => Math.min(a, b),
              Infinity,
            ),
          byteLength,
        );
        text = `${rt.unicodeText.slice(0, byteLength)}…`;
        facets = facets.filter((facet) => facet.index.byteEnd <= byteLength);
      }
      embed = {
        uri: `https://www.youtube.com/watch?v=${dob.uid}`,
        title: title,
        description: `from ${dob.account.account_name}`,
        thumb: dob.media.high.url,
      };
      break;
    }
    default: {
      const url = dob.linktype && dob.linktype.linktype !== "_default"
        ? new URL(dob.linktype.url, "https://denonbu.jp").href // Fix for id 258
        : `https://denonbu.jp/detail/${dob.sid}/${dob.uid}`;
      embed = {
        uri: url,
        title: dob.title,
        description: "",
        thumb: dob.media[0],
      };
      break;
    }
  }
  await bskyPost(text, facets, dob.post_date, embed);
}

async function main() {
  const LAST_POST_ID = (await kv.get<number>(["last_post", "id"])).value ?? 2905;
  const LAST_POST_AT = (await kv.get<Date>(["last_post", "at"])).value ?? new Date(1708601676000);
  console.log(`Last id: ${LAST_POST_ID}, time: ${LAST_POST_AT.getTime()}`);

  const key = await getDobApiKey();
  console.log(`key: ${key}`);

  const { token } = await dobRequest(
    "auths/token/get",
    { key },
  ) as { token: string; expires: number };
  console.log(`token: ${token}`);

  let total: number | undefined = undefined;
  let offset = 0;
  const res: z.infer<typeof dobSchema>[] = [];
  do {
    const dob = await dobRequest(
      `contents/search?limit=60&offset=${offset}`,
      { key, token },
    ) as { result: { total: number; per_page: number }; items: unknown[] };
    total ??= dob.result.total;
    if (total !== dob.result.total) {
      throw new Error("Bad luck!");
    }
    res.push(...dob.items.map((item) => dobSchema.parse(item)));
    offset += dob.items.length;
  } while (res.at(-1)!.post_date >= LAST_POST_AT);

  console.log("Fetched");

  let skip = true;
  for (let i = res.length - 1; i >= 0; i--) {
    const post = res[i];
    if (skip) {
      skip = !(post.id === LAST_POST_ID && post.post_date.getTime() === LAST_POST_AT.getTime());
      continue;
    }
    console.log(`Process id: ${post.id}, time: ${post.post_date.getTime()}`);
    console.debug(post);
    await dob2bsky(post).then(() => {
      console.log(`Posted id: ${post.id}, time: ${post.post_date.getTime()}`);
      return new Promise((resolve) => setTimeout(resolve, 10000));
    }, (err) => {
      if (err instanceof Error && err.message === "Skipped as reply") {
        console.log(err.message);
      } else {
        return Promise.reject(err);
      }
    });
    await kv.set(["last_post", "id"], post.id);
    await kv.set(["last_post", "at"], post.post_date);
  }

  console.log("End");
}
