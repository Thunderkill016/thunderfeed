import { redirect } from "next/navigation";

/* Radar is the product — it lives at /. Keep the old path working. */
export default function RadarRedirect() {
  redirect("/");
}
