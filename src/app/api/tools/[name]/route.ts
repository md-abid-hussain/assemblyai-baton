import { postTool } from "@/server/tools/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** #14 POST /api/tools/[name] (DESIGN §4.4, §5.8). Logic: src/server/tools/route.ts. */
export const POST = postTool;
