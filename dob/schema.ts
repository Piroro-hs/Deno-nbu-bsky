import { z } from "npm:zod@^3.24.1";

const slugSchema = z.enum([
  "akiba",
  "harajuku",
  "shibuya",
  "azabu",
  "kabuki",
  "ikebukuro",
  "shinsaibashi",
  "deep-okubo",
  "neotokyo",
  "daiba",
  "neonakano",
  "deep-okubo-k",
  "all",
  "comic",
  "event",
  "goods",
  "livearchives",
  "movie",
  "music",
  "news",
  "novel",
]);

const categorySchema = z.object({
  // name: nameSchema,
  name: z.string(),
  slug: slugSchema,
});

const twVideoVariantSchema = z.object({
  url: z.string().url(),
  bit_rate: z.number().optional(),
  content_type: z.enum(["video/mp4", "application/x-mpegURL"]),
});

const twVideoSchema = z.object({
  type: z.enum(["video", "animated_gif"]),
  variants: z.array(twVideoVariantSchema),
  media_key: z.string(),
  preview_image_url: z.string().url(),
});
export type TwVideo = z.infer<typeof twVideoSchema>;

const twPhotoSchema = z.object({
  type: z.literal("photo"),
  media_key: z.string(),
  url: z.string().url(),
});
export type TwPhoto = z.infer<typeof twPhotoSchema>;

const twMediaSchema = z.discriminatedUnion("type", [
  twVideoSchema,
  twPhotoSchema,
]);

const imageSchema = z.object({
  url: z.string().url(),
  width: z.number(),
  height: z.number(),
});

const imageSetSchema = z.object({
  high: imageSchema,
  medium: imageSchema,
  default: imageSchema,
});

const accountSchema = z.object({
  url: z.string().url(),
  account_id: z.string(),
  account_name: z.string(),
});

const linktypeSchema = z.object({
  // url: z.literal("").or(z.string().url()),
  url: z.string(), // Fix for id 258 (url: "/area/kabuki")
  linktype: z.enum(["_default", "_blank", "_self"]),
});

const dobCommonSchema = z.object({
  id: z.number(),
  sid: z.number(),
  uid: z.string(),
  body: z.string(),
  post_date: z.string().regex(/^\d{4}-[01]\d-[0-3]\d [0-2]\d:[0-5]\d:[0-6]\d$/)
    .transform((date) => new Date(`${date.replace(" ", "T")}+09:00`)),
  category: z.array(categorySchema),
  is_fixed: z.number().min(0).max(1).transform(Boolean),
  view_count: z.number().nullable(),
});

const twSchema = dobCommonSchema.merge(z.object({
  source_type: z.literal("tw"),
  title: z.null(),
  media: z.array(twMediaSchema).nonempty().nullable(),
  account: accountSchema,
  icon: z.array(z.string().url()).length(1),
  linktype: z.null(),
}));

const ytSchema = dobCommonSchema.merge(z.object({
  source_type: z.literal("yt"),
  title: z.string(),
  media: imageSetSchema,
  account: accountSchema,
  icon: imageSetSchema,
  linktype: z.null(),
}));

const articleSchema = dobCommonSchema.merge(z.object({
  // source_type: z.string(), // z.discriminatedUnion supports only literalls and enums, https://github.com/colinhacks/zod/issues/2106
  source_type: z.enum(["main", "deep-okubo", "shinsaibashi"]),
  title: z.string(),
  media: z.array(z.string().url()),
  account: z.null(),
  icon: z.null(),
  linktype: linktypeSchema.nullable(),
}));

export const dobSchema = z.discriminatedUnion("source_type", [
  twSchema,
  ytSchema,
  articleSchema,
]);
export type Dob = z.infer<typeof dobSchema>;
