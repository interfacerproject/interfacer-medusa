import { defineConfig, loadEnv } from "@medusajs/framework/utils"
import { DEV_GUI_ORIGINS } from "./src/dev-origins"
import { assertDeploymentConfig } from "./src/modules/interfacer/deployment"

loadEnv(process.env.NODE_ENV || "development", process.cwd())
// A pilot refuses to start (or migrate) with a missing secret or a fixture switch.
assertDeploymentConfig()

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      // /dev uses the same exact GUI origins explicitly (not auto-CORS in v2).
      // A pilot is called server-to-server by the GUI proxy: no browser origin.
      storeCors: process.env.STORE_CORS ?? ["http://localhost:8000", ...DEV_GUI_ORIGINS].join(","),
      adminCors: process.env.ADMIN_CORS ?? "http://localhost:9000",
      authCors: process.env.AUTH_CORS ?? ["http://localhost:9000", ...DEV_GUI_ORIGINS].join(","),
      jwtSecret: process.env.JWT_SECRET || "local-only-do-not-deploy",
      cookieSecret: process.env.COOKIE_SECRET || "local-only-do-not-deploy",
    },
  },
  // Operators only (an SSH tunnel in a pilot); off unless MEDUSA_ADMIN=true.
  admin: { disable: process.env.MEDUSA_ADMIN !== "true" },
  modules: [
    { resolve: "./src/modules/interfacer" },
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: { providers: [{ resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" }] },
    },
    {
      resolve: "@medusajs/medusa/locking",
      options: { providers: [{
        resolve: "@medusajs/medusa/locking-postgres", id: "postgres", is_default: true,
      }] },
    },
  ],
})
