import atp from "npm:@atproto/api@^0.13.29";

const service = "https://bsky.social";

export const agent = new atp.AtpAgent({ service });

function fetchUploadImageBlob(
  url: string,
): Promise<atp.ComAtprotoRepoUploadBlob.Response> {
  return fetch(url).then((res) =>
    !res.body ? Promise.reject(new Error("Thumbnail fetch returns null")) : agent.uploadBlob(
      res.body as unknown as Parameters<atp.AtpAgent["uploadBlob"]>[0], // Force ReadableStream for input
      { encoding: res.headers.get("Content-Type") || "image/*" },
    ).catch((err) =>
      // This happens for larger blob
      err.error === "PayloadTooLarge" ? fetchResizeUploadImageBlob(url) : Promise.reject(err)
    )
  );
}

async function fetchResizeUploadImageBlob(
  url: string,
): Promise<atp.ComAtprotoRepoUploadBlob.Response> {
  console.log("ImageMagick!!!");
  const [{ ImageMagick, MagickFormat }, buf] = await Promise.all([
    await import("https://deno.land/x/imagemagick_deno@0.0.31/mod.ts").then(async (im) => {
      await im.initialize();
      return im;
    }) as typeof import("https://deno.land/x/imagemagick_deno@0.0.31/mod.ts"),
    fetch(url).then((res) => res.arrayBuffer()),
  ]);
  const arr = new Uint8Array(buf);
  let resized = arr;
  let i = 0;
  let step = 0.2;
  while (resized.byteLength > 1000000) {
    if (i === 1 && resized.byteLength > 1000000 * 10) {
      step = 1;
    }
    resized = await new Promise((res) =>
      ImageMagick.read(arr, (img) => {
        const ratio = 1 + step * i;
        const { width, height } = img;
        img.resize(width / ratio, height / ratio);
        // img.sharpen()
        img.strip();
        img.quality = 90;
        img.write(MagickFormat.Jpeg, res);
      })
    );
    i++;
  }
  return agent.uploadBlob(resized, { encoding: "image/jpeg" });
}

export type PostMediaUnresolved = {
  text: string;
  facets: atp.AppBskyRichtextFacet.Main[];
  createdAt: Date;
  embed?: { images: string[] } | {
    uri: string;
    title: string;
    description: string;
    thumb?: string;
  };
};

export async function post(
  { text, facets, createdAt, embed }: PostMediaUnresolved,
): Promise<{ uri: string; cid: string }> {
  const embedFactory = embed &&
    (async (fetchUploadBlob: (url: string) => Promise<atp.ComAtprotoRepoUploadBlob.Response>) => (
      "images" in embed
        ? {
          $type: "app.bsky.embed.images",
          images: (await Promise.all(embed.images.map((image) => fetchUploadBlob(image))))
            .map((image, i) => ({ image: image.data.blob, alt: embed.images[i] })),
        }
        : {
          $type: "app.bsky.embed.external",
          external: {
            ...embed,
            ...embed.thumb
              ? {
                thumb: (await fetchUploadBlob(embed.thumb)).data.blob,
              }
              : {},
          },
        }
    ));
  return agent.post({
    text,
    facets,
    embed: await embedFactory?.(fetchUploadImageBlob),
    langs: ["ja"],
    createdAt: createdAt.toISOString(),
  }).catch(async (err) =>
    // BlobTooLarge and PayloadTooLarge happens for around 2.5% of posts
    // if (err instanceof XRPCError && err.error === "BlobTooLarge") {
    err.error === "BlobTooLarge"
      ? agent.post({
        text,
        facets,
        embed: await embedFactory?.(fetchResizeUploadImageBlob),
        langs: ["ja"],
        createdAt: createdAt.toISOString(),
      })
      : Promise.reject(err)
  );
}
