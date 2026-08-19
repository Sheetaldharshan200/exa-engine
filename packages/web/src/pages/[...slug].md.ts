import type { APIRoute, GetStaticPaths } from "astro"
import { getCollection } from "astro:content"

// Every doc page is also available as plain markdown at <page>.md — the form
// an agent or a curl can read without parsing HTML. The site builds statically,
// so the paths are enumerated up front from the docs collection.
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs")
  return docs.map((doc) => ({ params: { slug: doc.id === "index" ? undefined : doc.id }, props: { body: doc.body } }))
}

export const GET: APIRoute = async ({ props }) => {
  const body = (props as { body?: string }).body
  if (!body) return new Response("Not found", { status: 404 })
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}
