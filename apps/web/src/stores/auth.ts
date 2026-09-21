import { defineStore } from "pinia";
import { request, ApiError } from "@/lib/api";
import type { AuthUser } from "@/types";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    initialized: false,
    loaded: false,
    user: null as AuthUser | null
  }),
  getters: {
    isAdmin: (state) => state.user?.role === "ADMIN"
  },
  actions: {
    async bootstrap() {
      if (this.loaded) return;
      const status = await request<{ data: { initialized: boolean } }>("/setup/status");
      this.initialized = status.data.initialized;
      if (this.initialized) {
        try {
          const session = await request<{ data: AuthUser }>("/auth/me");
          this.user = session.data;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          this.user = null;
        }
      }
      this.loaded = true;
    },
    async setup(loginName: string, displayName: string, password: string) {
      const result = await request<{ data: AuthUser }>("/setup", {
        method: "POST",
        body: { loginName, displayName, password }
      });
      this.initialized = true;
      this.user = result.data;
    },
    async login(loginName: string, password: string) {
      const result = await request<{ data: AuthUser }>("/auth/login", { method: "POST", body: { loginName, password } });
      this.user = result.data;
    },
    async logout() {
      await request<void>("/auth/logout", { method: "POST" });
      this.user = null;
    }
  }
});
