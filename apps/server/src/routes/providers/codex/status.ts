import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { codexStatus } from "@/utils/codex/models";

export default Router().get("/", async (_req, res) => {
  res.set("Cache-Control", "no-store").json(success(await codexStatus(true)));
});
