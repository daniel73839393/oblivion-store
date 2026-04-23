// Entrega automática de VIPs no Minecraft após pagamento aprovado.
// Fluxo:
// 1. Pagamento confirmado → DM no usuário pedindo o nick.
// 2. Usuário responde no privado → bot captura via message collector.
// 3. Bot executa via RCON: lp user NICK parent addtemp <grupo> 30d
// 4. Confirma na DM e envia log no canal configurado.
import { EmbedBuilder } from "discord.js";
import { rconExec } from "./rcon.js";
import { readJSON, writeJSON } from "./storage.js";

const RCON_HOST = process.env.RCON_HOST || null;
const RCON_PORT = Number.parseInt(process.env.RCON_PORT || "25575", 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD || null;
const MC_LOG_CHANNEL_ID = process.env.MC_LOG_CHANNEL_ID || null;
const VIP_DURATION = process.env.VIP_DURATION || "30d";

const NICK_WAIT_MS = 24 * 60 * 60 * 1000; // 24h pra responder
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;

const DELIVERIES_FILE = "deliveries.json";

// Catálogo de VIPs (preenchido pelo index.js no boot)
let VIPS_CATALOG = [];
export function setVipsCatalog(catalog) {
  VIPS_CATALOG = Array.isArray(catalog) ? catalog : [];
}

// Evita pedir o nick duas vezes pro mesmo ticket/usuário
const activeRequests = new Set(); // chave: `${userId}:${ticketChannelId}`

function getDeliverableItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const value of items) {
    const vip = VIPS_CATALOG.find((v) => v.value === value);
    if (!vip) continue;
    // Sem grupo definido (ex.: personalizado) → entrega manual
    if (!vip.mcGroup) continue;
    out.push({ value: vip.value, label: vip.label, mcGroup: vip.mcGroup });
  }
  return out;
}

function recordDelivery(entry) {
  const all = readJSON(DELIVERIES_FILE, []);
  all.push(entry);
  writeJSON(DELIVERIES_FILE, all);
}

async function sendLog(client, payload) {
  if (!MC_LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(MC_LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(payload);
  } catch (err) {
    console.error("Erro ao enviar log de entrega:", err.message);
  }
}

async function applyVipsViaRcon(nick, deliverables) {
  const results = [];
  for (const d of deliverables) {
    const command = `lp user ${nick} parent addtemp ${d.mcGroup} ${VIP_DURATION}`;
    try {
      const out = await rconExec({
        host: RCON_HOST,
        port: RCON_PORT,
        password: RCON_PASSWORD,
        command,
      });
      results.push({ ...d, ok: true, output: out.trim(), command });
    } catch (err) {
      results.push({ ...d, ok: false, error: err.message, command });
    }
  }
  return results;
}

// Coleta o nick do usuário no DM e dispara a entrega
async function awaitNickAndDeliver(client, dmChannel, ctx) {
  const filter = (m) => m.author.id === ctx.userId && !m.author.bot;
  const collector = dmChannel.createMessageCollector({
    filter,
    time: NICK_WAIT_MS,
  });

  collector.on("collect", async (msg) => {
    const nick = msg.content.trim();
    if (!NICK_REGEX.test(nick)) {
      await dmChannel
        .send(
          "❌ Nick inválido. Use entre **3 e 16 caracteres**, somente letras, números e `_`.\n" +
            "Envie o seu nick novamente."
        )
        .catch(() => {});
      return; // continua coletando
    }

    collector.stop("ok");

    await dmChannel
      .send(`⏳ Ativando o seu VIP para **${nick}**...`)
      .catch(() => {});

    if (!RCON_HOST || !RCON_PASSWORD) {
      await dmChannel
        .send(
          "⚠️ A entrega automática ainda não está configurada no servidor. " +
            "Já avisei a equipe — você receberá o VIP em breve."
        )
        .catch(() => {});
      await sendLog(client, {
        content: "⚠️ Pedido aguardando entrega manual (RCON não configurado).",
        embeds: [
          buildLogEmbed({
            ctx,
            nick,
            results: [],
            note: "RCON não configurado",
          }),
        ],
      });
      return;
    }

    const results = await applyVipsViaRcon(nick, ctx.deliverables);
    const allOk = results.every((r) => r.ok);

    recordDelivery({
      userId: ctx.userId,
      ticketChannelId: ctx.ticketChannelId,
      nick,
      results,
      deliveredAt: new Date().toISOString(),
    });

    if (allOk) {
      const list = results
        .map((r) => `✅ **${r.label}** — \`${r.command}\``)
        .join("\n");
      await dmChannel
        .send(
          `🎉 **VIP ativado com sucesso!**\n\n` +
            `Nick: **${nick}**\n` +
            `Duração: **${VIP_DURATION}**\n\n${list}\n\n` +
            `Aproveite! 💜`
        )
        .catch(() => {});
    } else {
      const list = results
        .map((r) =>
          r.ok
            ? `✅ **${r.label}**`
            : `❌ **${r.label}** — \`${r.error}\``
        )
        .join("\n");
      await dmChannel
        .send(
          `⚠️ Tive problemas pra ativar parte do seu pedido.\n\n` +
            `Nick: **${nick}**\n${list}\n\n` +
            `A equipe foi avisada e vai resolver no privado.`
        )
        .catch(() => {});
    }

    await sendLog(client, {
      embeds: [buildLogEmbed({ ctx, nick, results })],
    });
  });

  collector.on("end", (_collected, reason) => {
    activeRequests.delete(`${ctx.userId}:${ctx.ticketChannelId}`);
    if (reason === "time") {
      dmChannel
        .send(
          "⌛ Não recebi o seu nick a tempo. Quando puder, fale com a equipe " +
            "no seu ticket pra liberar o VIP manualmente."
        )
        .catch(() => {});
    }
  });
}

function buildLogEmbed({ ctx, nick, results, note }) {
  const lines = results.length
    ? results
        .map((r) =>
          r.ok
            ? `✅ ${r.label} (\`${r.mcGroup}\`)`
            : `❌ ${r.label} (\`${r.mcGroup}\`) — ${r.error}`
        )
        .join("\n")
    : "_(nenhum VIP processado)_";

  const embed = new EmbedBuilder()
    .setTitle("🎮 Entrega de VIP")
    .setColor(results.every?.((r) => r.ok) ? 0x57f287 : 0xfee75c)
    .addFields(
      {
        name: "Usuário Discord",
        value: `<@${ctx.userId}> (\`${ctx.userTag}\`)`,
        inline: false,
      },
      { name: "Nick Minecraft", value: `\`${nick}\``, inline: true },
      { name: "Ticket", value: `<#${ctx.ticketChannelId}>`, inline: true },
      { name: "VIPs", value: lines, inline: false }
    )
    .setTimestamp(new Date());

  if (note) embed.setFooter({ text: note });
  return embed;
}

// Função pública chamada quando o pagamento é confirmado.
// Não trava: tudo acontece em background; erros são logados.
export async function startVipDelivery(client, ticket, channel) {
  try {
    const deliverables = getDeliverableItems(ticket.items);
    const ctx = {
      userId: ticket.userId,
      userTag: ticket.userTag || "",
      ticketChannelId: channel.id,
      deliverables,
    };
    const key = `${ctx.userId}:${ctx.ticketChannelId}`;
    if (activeRequests.has(key)) return;
    activeRequests.add(key);

    if (deliverables.length === 0) {
      // Ex.: VIP Personalizado — entrega manual pela equipe
      await sendLog(client, {
        embeds: [
          buildLogEmbed({
            ctx,
            nick: "—",
            results: [],
            note: "Sem grupo automático — entrega manual",
          }),
        ],
      });
      activeRequests.delete(key);
      return;
    }

    const user = await client.users.fetch(ctx.userId).catch(() => null);
    if (!user) {
      activeRequests.delete(key);
      return;
    }
    if (!ctx.userTag) ctx.userTag = user.tag;

    let dm;
    try {
      dm = await user.createDM();
    } catch (err) {
      console.warn(
        `Não consegui abrir DM com ${user.tag}: ${err.message}. Pedindo no ticket.`
      );
      await channel
        .send(
          `<@${ctx.userId}> não consegui te chamar no privado. ` +
            `Me responda **aqui** com o seu **nick do Minecraft** para ativar o VIP.`
        )
        .catch(() => {});
      const fallbackCollector = channel.createMessageCollector({
        filter: (m) => m.author.id === ctx.userId && !m.author.bot,
        time: NICK_WAIT_MS,
        max: 1,
      });
      // Reaproveita o mesmo fluxo via canal do ticket
      fallbackCollector.on("collect", async (m) => {
        await awaitNickAndDeliver(client, channel, ctx);
        // dispara como se fosse o "msg" coletado
        channel.emit("messageCreate", m);
      });
      return;
    }

    const list = deliverables.map((d) => `• **${d.label}**`).join("\n");
    await dm
      .send(
        `🎉 **Pagamento confirmado!**\n\n` +
          `Para liberar o seu VIP no servidor, me envie agora o seu **nick do Minecraft** ` +
          `(somente letras, números e \`_\`, de 3 a 16 caracteres).\n\n` +
          `Itens comprados:\n${list}\n\n` +
          `_Você pode responder esta mensagem a qualquer momento nas próximas 24 horas._`
      )
      .catch(async (err) => {
        console.warn(`DM bloqueada para ${user.tag}: ${err.message}`);
        await channel
          .send(
            `<@${ctx.userId}> seu privado está fechado. ` +
              `Me responda aqui com o seu **nick do Minecraft** pra ativar o VIP.`
          )
          .catch(() => {});
      });

    await awaitNickAndDeliver(client, dm, ctx);
  } catch (err) {
    console.error("Falha ao iniciar entrega de VIP:", err);
  }
}
