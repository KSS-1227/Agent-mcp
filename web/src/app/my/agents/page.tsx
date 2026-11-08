import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function MyAgentsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/my/login");

  // Row-level security returns only agents whose owner_id is this user.
  const { data: agents, error } = await supabase
    .from("agents")
    .select("id, key, name, created_at")
    .order("created_at", { ascending: false });

  return (
    <main style={{ maxWidth: 720, margin: "60px auto", fontFamily: "sans-serif" }}>
      <h1>My agents</h1>
      <p>Signed in as {user.email}</p>
      {error && <p>Could not load agents: {error.message}</p>}
      {!error && agents?.length === 0 && <p>You have no agents yet.</p>}
      <ul>
        {agents?.map((a) => (
          <li key={a.id}>{a.name} <small>({a.key})</small></li>
        ))}
      </ul>
    </main>
  );
}