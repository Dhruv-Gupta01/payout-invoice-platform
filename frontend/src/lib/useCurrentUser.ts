import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "./api";

// LLD §2.1: GET /auth/me → { id, email, name, role }
export type CurrentUser = { id: string; email: string; name: string; role: "admin" | "resource" };

// Found live (Phase 9 manual browser check): AppSidebar/ResourceSidebar
// hardcoded a display name ("Admin User" / "Ritika Garg") straight from the
// Lovable mock — every logged-in user saw someone else's name in the
// sidebar. Backed by /auth/me, which already round-trips both roles.
export function useCurrentUser() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<CurrentUser>("/auth/me"),
  });
}

// LLD §2.1: POST /auth/logout — specified from the start but never built
// (no route, no frontend button) until the user asked "why is there no
// logout option" during manual testing.
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });
}
