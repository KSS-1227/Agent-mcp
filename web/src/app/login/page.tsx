import { redirect } from "next/navigation";

/**
 * Public redirect: /login → /my/login (user front door).
 * The operator password form is at /operator/login (unlisted).
 */
export default function LoginRedirect() {
  redirect("/my/login");
}