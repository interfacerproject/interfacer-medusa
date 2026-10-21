import { defineConfig, loadEnv } from "@medusajs/framework/utils"
import { DEV_GUI_ORIGINS } from "./src/dev-origins"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      // /dev uses the same exact GUI origins explicitly (not auto-CORS in v2).
      storeCors: ["http://localhost:8000", ...DEV_GUI_ORIGINS].join(","),
      adminCors: "http://localhost:9000",
      authCors: "http://localhost:9000",
      jwtSecret: process.env.JWT_SECRET || "local-only-do-not-deploy",
      cookieSecret: process.env.COOKIE_SECRET || "local-only-do-not-deploy",
    },
  },
  admin: { disable: true },
  modules: [{ resolve: "./src/modules/interfacer" }],
})
