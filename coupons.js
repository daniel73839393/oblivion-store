// Sistema de Cupons de Streamers
// - Cada usuário pode resgatar um mesmo cupom 1x a cada 30 dias
// - Admins podem cadastrar/remover cupons
import {
  EmbedBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} from "discord.js";
import { readJSON, writeJSON } from "./storage.js";
import { buildMercadoPagoEmbed, formatBRL } from "./payment.js";
import { createPixPayment } from "./mercadopago.js";

const COUPONS_FILE = "coupons.json";
const REDEMPTIONS_FILE = "redemptions.json";
const TICKETS_FILE = "tickets.json";
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const COUPON_DISCOUNT_PERCENT = 10;
const COLOR = 0x9966cc;

export const COUPON_BUTTON_ID = "coupon_redeem";
export const COUPON_MODAL_ID = "coupon_modal";
export const COUPON_INPUT_ID = "coupon_code";

const loadCoupons = () => readJSON(COUPONS_FILE, {});
const saveCoupons = (c) => writeJSON(COUPONS_FILE, c);
const loadRedemptions = () => readJSON(REDEMPTIONS_FILE, {});
const saveRedemptions = (r) => writeJSON(REDEMPTIONS_FILE, r);

function isAdmin(message) {
  return message.member?.permissions?.has(PermissionFlagsBits.Administrator);
}

export function formatRemaining(ms) {
  const totalHours = Math.ceil(ms / (60 * 60 * 1000));
  if (totalHours >= 24) {
    const days = Math.ceil(totalHours / 24);
    return `${days} dia(s)`;
  }
  return `${totalHours} hora(s)`;
}

// Verifica se um cupom existe e se o usuário pode resgatar agora
export function validateCouponForUser(code, userId) {
  const coupons = loadCoupons();
  const coupon = coupons[code];
  if (!coupon) {
    return { ok: false, error: "❌ Cupom inválido ou inexistente." };
  }
  const redemptions = loadRedemptions();
  const last = (redemptions[userId] || {})[code];
  const now = Date.now();
  if (last && now - last < COOLDOWN_MS) {
    const remaining = COOLDOWN_MS - (now - last);
    return {
      ok: false,
      error: `⏳ Você já resgatou este cupom recentemente. Tente novamente em **${formatRemaining(remaining)}**.`,
    };
  }
  return { ok: true, coupon };
}

// Marca o resgate do cupom (consome o cooldown de 30 dias)
export function commitCouponRedemption(code, userId) {
  const redemptions = loadRedemptions();
  const userRedemptions = redemptions[userId] || {};
  userRedemptions[code] = Date.now();
  redemptions[userId] = userRedemptions;
  saveRedemptions(redemptions);
}

// Botão "Resgatar Cupom" dentro do ticket -> abre o modal
export async function showCouponModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(COUPON_MODAL_ID)
    .setTitle("🎟️ Resgatar Cupom de Streamer");

  const input = new TextInputBuilder()
    .setCustomId(COUPON_INPUT_ID)
    .setLabel("Código do cupom")
    .setPlaceholder("Ex: GAULES")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(40)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// Submissão do modal de cupom dentro de um ticket
export async function handleCouponModalSubmit(interaction) {
  const code = interaction.fields
    .getTextInputValue(COUPON_INPUT_ID)
    .toUpperCase()
    .trim();

  const validation = validateCouponForUser(code, interaction.user.id);
  if (!validation.ok) {
    return interaction.reply({
      content: validation.error,
      flags: MessageFlags.Ephemeral,
    });
  }
  const coupon = validation.coupon;

  commitCouponRedemption(code, interaction.user.id);

  // Verifica se este canal é um ticket com preço
  const tickets = readJSON(TICKETS_FILE, {});
  const ticket = tickets[interaction.channel.id];
  const ticketHasPrice =
    ticket && typeof ticket.price === "number" && ticket.price > 0;

  const embed = new EmbedBuilder()
    .setTitle("🎟️ Cupom resgatado!")
    .setColor(COLOR)
    .setDescription(
      `<@${interaction.user.id}> resgatou um cupom neste ticket.\n\n` +
        `**Código:** \`${code}\`\n` +
        `**Streamer:** ${coupon.streamer}\n` +
        `🎁 **Recompensa:** ${coupon.reward}\n\n` +
        (ticketHasPrice
          ? `💸 **Desconto de ${COUPON_DISCOUNT_PERCENT}%** aplicado ao valor do pedido!\n`
          : `_Aplique a recompensa antes de finalizar a compra._\n`) +
        `_Próximo resgate deste cupom: em 30 dias._`
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  const replyEmbeds = [embed];
  let replyFile = null;

  if (ticketHasPrice) {
    // Atualiza ticket e gera novo PIX com o valor com desconto
    ticket.couponApplied = true;
    ticket.discountPercent = COUPON_DISCOUNT_PERCENT;
    ticket.couponCode = code;
    writeJSON(TICKETS_FILE, tickets);

    const finalPrice =
      ticket.price * (1 - COUPON_DISCOUNT_PERCENT / 100);
    const vipLabel = `Pedido com ${ticket.items?.length ?? 1} item(ns)`;

    try {
      const pix = await createPixPayment({
        amount: finalPrice,
        description: `Oblivion Store - ${vipLabel} (cupom ${code})`,
        payerEmail: `discord-${interaction.user.id}@oblivion.store`,
        payerFirstName:
          interaction.user.globalName ||
          interaction.user.username ||
          "Cliente",
        externalReference: `ticket-${interaction.channel.id}-coupon`,
      });

      ticket.mpPaymentId = pix.paymentId;
      writeJSON(TICKETS_FILE, tickets);

      const built = buildMercadoPagoEmbed({
        vipLabel,
        originalPrice: ticket.price,
        discountPercent: COUPON_DISCOUNT_PERCENT,
        qrCode: pix.qrCode,
        qrCodeBase64: pix.qrCodeBase64,
        paymentId: pix.paymentId,
        ticketUrl: pix.ticketUrl,
      });
      replyEmbeds.push(built.embed);
      replyFile = built.file;
    } catch (err) {
      console.error("Erro ao gerar novo PIX após cupom:", err);
      replyEmbeds.push(
        new EmbedBuilder()
          .setTitle("⚠️ Erro ao gerar novo pagamento")
          .setColor(0xff5555)
          .setDescription(
            `Cupom aplicado, mas não consegui gerar o novo QR Code automaticamente.\n` +
              `**Novo valor:** ${formatBRL(finalPrice)}\n\n` +
              `A equipe vai te ajudar manualmente. Erro: \`${err.message}\``
          )
      );
    }
  }

  await interaction.reply({
    embeds: replyEmbeds,
    files: replyFile ? [replyFile] : [],
  });
}

// !addcupom <CÓDIGO> <streamer> <recompensa em várias palavras>
export async function handleAddCupom(message, args) {
  if (!isAdmin(message)) {
    return message.reply("❌ Apenas administradores podem usar este comando.");
  }
  const code = (args[0] || "").toUpperCase().trim();
  const streamer = args[1];
  const reward = args.slice(2).join(" ");

  if (!code || !streamer || !reward) {
    return message.reply(
      "❌ Uso: `!addcupom <CÓDIGO> <streamer> <recompensa>`\n" +
        "Exemplo: `!addcupom GAULES gaules 1000 coins de bônus`"
    );
  }

  const coupons = loadCoupons();
  coupons[code] = {
    streamer,
    reward,
    createdAt: Date.now(),
    createdBy: message.author.id,
  };
  saveCoupons(coupons);

  return message.reply(
    `✅ Cupom **${code}** criado para o streamer **${streamer}**.`
  );
}

// !rmcupom <CÓDIGO>
export async function handleRmCupom(message, args) {
  if (!isAdmin(message)) {
    return message.reply("❌ Apenas administradores podem usar este comando.");
  }
  const code = (args[0] || "").toUpperCase().trim();
  if (!code) return message.reply("❌ Uso: `!rmcupom <CÓDIGO>`");

  const coupons = loadCoupons();
  if (!coupons[code]) return message.reply("❌ Cupom não encontrado.");

  delete coupons[code];
  saveCoupons(coupons);
  return message.reply(`✅ Cupom **${code}** removido.`);
}

// !cupons - lista todos os cupons disponíveis
export async function handleListCupons(message) {
  const coupons = loadCoupons();
  const entries = Object.entries(coupons);

  const embed = new EmbedBuilder()
    .setTitle("🎟️ Cupons de Streamers Disponíveis")
    .setColor(COLOR)
    .setFooter({ text: "Oblivion Store © 2026" });

  if (entries.length === 0) {
    embed.setDescription("Nenhum cupom disponível no momento.");
  } else {
    embed.setDescription(
      entries
        .map(
          ([code, c]) =>
            `**\`${code}\`** — Streamer: **${c.streamer}**\n🎁 ${c.reward}`
        )
        .join("\n\n") +
        "\n\n_Para resgatar, abra um ticket pela loja e clique em **Resgatar Cupom**._"
    );
  }

  return message.reply({ embeds: [embed] });
}
