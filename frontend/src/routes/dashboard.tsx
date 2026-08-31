import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/routes/index";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Admin Dashboard — Payouts Console" },
      {
        name: "description",
        content:
          "Review synced freelance payout rows, generate invoices by row range, and track approval status.",
      },
      { property: "og:title", content: "Admin Dashboard — Payouts Console" },
      {
        property: "og:description",
        content: "Review synced payout rows and generate invoices for freelance resources.",
      },
    ],
  }),
  component: Dashboard,
});
