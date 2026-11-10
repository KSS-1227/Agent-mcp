import {
  isAuthConfigured,
  readSessionCookie,
  verifySessionToken,
} from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type DataScope =
  | { kind: "operator" }
  | { kind: "user"; supabase: SupabaseServerClient; userId: string; email: string | null };

export async function getScope(request: Request): Promise<DataScope | null> {
  const operatorToken = readSessionCookie(request);
  if (
    isAuthConfigured() &&
    operatorToken &&
    (await verifySessionToken(operatorToken))
  ) {
    return { kind: "operator" };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) return null;

    return {
      kind: "user",
      supabase,
      userId: user.id,
      email: user.email ?? null,
    };
  } catch {
    return null;
  }
}
