import { defineConfig, loadEnv } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: "http://localhost:8000",
      adminCors: "http://localhost:9000",
      authCors: "http://localhost:9000",
      jwtSecret: process.env.JWT_SECRET || "local-only-do-not-deploy",
      cookieSecret: process.env.COOKIE_SECRET || "local-only-do-not-deploy",
    },
  },
  admin: { disable: true },
  modules: [{ resolve: "./src/modules/interfacer" }],
})
