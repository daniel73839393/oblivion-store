// Servidor web simples para keep-alive (UptimeRobot, etc.)
import express from "express";

export function startKeepAliveServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.get("/", (req, res) => {
    res.send("Bot online!");
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`🌐 Servidor web ativo na porta ${port}!`);
  });
}
