import { DOMParser } from "npm:linkedom@^0.16.8";

import { dobSchema } from "./schema.ts";

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
  const res: dobSchema[] = [];
  do {
    const dob = await dobRequestRaw(
      `contents/search?limit=60&offset=${offset}`,
      { key, token },
    ) as { result: { total: number; per_page: number }; items: unknown[] };
    total ??= dob.result.total;
    if (total !== dob.result.total) {
      throw new Error("Bad luck!");
    }
    res.push(...dob.items.map((item) => dobSchema.parse(item)));
    offset += dob.items.length;
  } while (res.at(-1)!.post_date >= since);

  return res.slice(0, res.findLastIndex((post) => post.post_date >= since) + 1);
}
