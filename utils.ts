export async function expandShortendLink(link: string): Promise<string> {
  return (await fetch(link, { redirect: "manual" })).headers.get("Location") || link;
}
