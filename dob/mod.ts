import { unescape } from "https://deno.land/std@0.215.0/html/entities.ts";

import atp from "npm:@atproto/api@^0.9.6";
import Graphemer from "npm:graphemer@^1.4.0";
import { DOMParser } from "npm:linkedom@^0.16.8";

import { dobSchema, twPhotoSchema, twVideoSchema } from "./schema.ts";
import { PostMediaUnresolved } from "../bsky.ts";
import { expandShortendLink } from "../utils.ts";

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

async function dobRequestRaw(
  path: string,
  { key, token }: { key: string; token?: string },
): Promise<unknown> {
  const { status, payload } = await fetch(
    `https://denonbu.jp/backend-api/v1.0.0/${path}`,
    { headers: { "X-API-KEY": key, ...token ? { Authorization: `Bearer ${token}` } : {} } },
  ).then((res) => res.json()) as { status: "SUCCESS" | "ERROR"; payload: unknown };
  return status === "SUCCESS"
    ? payload
    : Promise.reject(new Error(`Dob API request for ${path} failed`, { cause: payload }));
}

/**
 * Fetch Dob posts posted at `since` date and newer.
 *
 * @param since - Oldest date of posts
 * @returns Array of fetched Dob posts in reverse-chronological order
 */
export async function fetchDobArticles(since: Date): Promise<dobSchema[]> {
  const key = await getDobApiKey();
  console.log(`key: ${key}`);

  const { token } = await dobRequestRaw(
    "auths/token/get",
    { key },
  ) as { token: string; expires: number };
  console.log(`token: ${token}`);

  let total: number | undefined = undefined;
  let offset = 0;
  const dobs: dobSchema[] = [];
  do {
    const res = await dobRequestRaw(
      `contents/search?limit=60&offset=${offset}`,
      { key, token },
    ) as { result: { total: number; per_page: number }; items: unknown[] };
    total ??= res.result.total;
    if (total !== res.result.total) {
      throw new Error("Bad luck!");
    }
    dobs.push(...res.items.map((item) => dobSchema.parse(item)));
    offset += res.items.length;
  } while (dobs.at(-1)!.post_date >= since);

  return dobs.slice(0, dobs.findIndex((dob) => dob.post_date < since));
}

export async function dob2Bsky(dob: dobSchema): Promise<PostMediaUnresolved> {
  // const postDate;
  let text = "";
  let facets: PostMediaUnresolved["facets"] = [];
  let embed: PostMediaUnresolved["embed"];
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
        "ka___n000",
        "madoka0203_love",
        "tanimarika0105",
      ];
      const reply = dob.body.match(/^@(\w{1,15})/);
      if (reply && !knownAccounts.includes(reply[1])) {
        return Promise.reject(new Error("Skipped as reply"));
      }
      const body = unescape(dob.body);
      const textSegments: {
        text: string;
        data:
          & ({ type: "text" | "tag" } | { type: "tco"; tco: Promise<string>; padEnd: boolean })
          & { byteEnd?: number; graphemeEnd?: number };
      }[] = [];
      const facetRegex =
        /([#＃][\p{L}\p{N}\p{Pd}]+)|(https:\/\/t\.co\/[\w\-.~!$&'\(\)*+,;=:@]+)[\s--[\r\n]]*/vdg;
      let lastIndex = 0;
      for (const { "1": tag, "2": tco, indices } of body.matchAll(facetRegex)) {
        textSegments.push({ text: body.slice(lastIndex, indices![0][0]), data: { type: "text" } });
        textSegments.push(
          tag ? { text: tag, data: { type: "tag" } } : {
            text: "",
            data: {
              type: "tco",
              tco: expandShortendLink(tco),
              padEnd: indices![0][1] !== indices![2][1],
            },
          },
        );
        lastIndex = indices![0][1];
      }
      textSegments.push({ text: body.slice(lastIndex), data: { type: "text" } });
      const encoder = new TextEncoder();
      const graphemer = new Graphemer.default();
      let byteLength = 0;
      let graphemeLength = 0;
      for (const segments of textSegments) {
        switch (segments.data.type) {
          case "text":
            byteLength += encoder.encode(segments.text).byteLength;
            graphemeLength += graphemer.countGraphemes(segments.text);
            break;
          case "tag": {
            const byteStart = byteLength;
            byteLength += encoder.encode(segments.text).byteLength;
            graphemeLength += graphemer.countGraphemes(segments.text);
            facets.push({
              index: { byteStart, byteEnd: byteLength },
              features: [{ $type: "app.bsky.richtext.facet#tag", tag: segments.text.slice(1) }],
            });
            break;
          }
          case "tco": {
            const url = await segments.data.tco;
            if (
              !url.startsWith(`https://twitter.com/i/web/status/${dob.uid}`) &&
              !url.startsWith(`${dob.account.url}/status/${dob.uid}`)
            ) {
              const hostname = new URL(url).hostname;
              const byteStart = byteLength;
              byteLength += encoder.encode(hostname).byteLength;
              graphemeLength += graphemer.countGraphemes(hostname);
              segments.text = hostname;
              facets.push({
                index: { byteStart, byteEnd: byteLength },
                features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
              });
              if (segments.data.padEnd) {
                byteLength++;
                graphemeLength++;
                segments.text += " ";
              }
            }
            break;
          }
          default:
            break;
        }
        segments.data.byteEnd = byteLength;
        segments.data.graphemeEnd = graphemeLength;
      }
      const account = `${dob.account.account_name}@${dob.account.account_id}`;
      const footer = `${account} ⧉🐦︎`;
      const allowedGraphemeLength = 300 - graphemer.countGraphemes(footer) - 3; // …\n\n
      if (graphemeLength > allowedGraphemeLength + 1) { // …
        let end = textSegments.findIndex((segment) =>
          segment.data.graphemeEnd! > allowedGraphemeLength - 1
        );
        const segment = textSegments[end];
        const prevSegment = textSegments[end - 1];
        if (segment.data.type === "text") {
          const leftGraphemeLength = allowedGraphemeLength - prevSegment.data.graphemeEnd!;
          const iter = graphemer.iterateGraphemes(segment.text);
          segment.text = Array.from({ length: leftGraphemeLength }, () => iter.next().value)
            .join("");
          segment.data.byteEnd = prevSegment.data.byteEnd! +
            encoder.encode(segment.text).byteLength;
          segment.data.graphemeEnd = allowedGraphemeLength;
          end++;
        } else if (
          segment.data.type === "tco" && segment.data.padEnd &&
          segment.data.graphemeEnd === allowedGraphemeLength + 1
        ) {
          segment.text = segment.text.slice(0, -1);
          segment.data.byteEnd!--;
          segment.data.graphemeEnd!--;
          end++;
        }
        textSegments.splice(end, Infinity, { text: "…", data: { type: "text" } });
        byteLength = textSegments[end - 1].data.byteEnd!;
        graphemeLength = textSegments[end - 1].data.graphemeEnd!;
      }
      if (textSegments.some(({ text }) => text)) {
        byteLength += 2;
        textSegments.push({ text: "\n\n", data: { type: "tag" } });
      }
      const byteStart = byteLength;
      byteLength += encoder.encode(account).byteLength;
      textSegments.push({ text: footer, data: { type: "text" } });
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
      text = textSegments.map(({ text }) => text).join("");
      const video = dob.media?.filter((media): media is twVideoSchema => media.type !== "photo")[0];
      embed = (dob.media && (video
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
        : { images: (dob.media as twPhotoSchema[]).map((photo) => photo.url) })) ?? undefined;
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
  return { text, facets, createdAt: dob.post_date, embed };
}
