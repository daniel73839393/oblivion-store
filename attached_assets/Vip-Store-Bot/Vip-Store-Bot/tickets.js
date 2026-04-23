// Sistema de Tickets - cria canais privados onde acontece a compra
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { readJSON, writeJSON } from "./storage.js";
import { buildMercadoPagoEmbed, formatBRL } from "./payment.js";
import { createPixPayment } from "./mercadopago.js";
import {
  calcTotals,
  renderCart,
  getCart,
  clearCart,
  COUPON_DISCOUNT_PERCENT,
} from "./cart.js";
import { commitCouponRedemption } from "./coupons.js";

const TICKETS_FILE = "tickets.json";
const COLOR = 0x9966cc;

const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;

export const TICKET_CLOSE_ID = "ticket_close";
export const TICKET_CONFIRM_PAY_ID = "ticket_confirm_pay";

function buildTicketActionsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CONFIRM_PAY_ID)
      .setLabel("Confirmar Pagamento")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("coupon_redeem")
      .setLabel("Resgatar Cupom")
      .setEmoji("🎟️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_ID)
      .setLabel("Fechar Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

// Retorna o ticket aberto do usuário neste canal, se ele for o dono
export function getOwnedTicket(channelId, userId) {
  const tickets = readJSON(TICKETS_FILE, {});
  const t = tickets[channelId];
  if (!t || !t.open || t.userId !== userId) return null;
  return t;
}

// Cria um ticket vazio onde o usuário monta o carrinho
export async function handleCreateShoppingTicket(interaction, VIPS) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: "❌ A loja só funciona dentro de um servidor.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const tickets = readJSON(TICKETS_FILE, {});
  const existing = Object.entries(tickets).find(
    ([, t]) => t.userId === interaction.user.id && t.open
  );
  if (existing) {
    return interaction.reply({
      content: `❌ Você já tem um ticket aberto: <#${existing[0]}>`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Permissões: ninguém vê, exceto o usuário, o bot e (opcionalmente) o staff
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  if (STAFF_ROLE_ID) {
    overwrites.push({
      id: STAFF_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  const safeName =
    interaction.user.username
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "user";
  const channelName = `ticket-${safeName}`;

  let channel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: interaction.channel?.parentId ?? undefined,
      permissionOverwrites: overwrites,
      topic: `Carrinho de ${interaction.user.tag}`,
    });
  } catch (err) {
    console.error("Erro ao criar canal de ticket:", err);
    return interaction.editReply({
      content:
        "❌ Não consegui criar o canal do ticket. Verifique se eu tenho a permissão **Gerenciar Canais**.",
    });
  }

  tickets[channel.id] = {
    userId: interaction.user.id,
    items: [],
    couponCode: null,
    couponApplied: false,
    discountPercent: 0,
    price: 0,
    finalized: false,
    open: true,
    createdAt: Date.now(),
  };
  writeJSON(TICKETS_FILE, tickets);

  // Inicia o carrinho em memória deste usuário
  clearCart(interaction.user.id);
  const cart = getCart(interaction.user.id);

  const welcomeEmbed = new EmbedBuilder()
    .setTitle("📩 Ticket de Compra Aberto")
    .setColor(COLOR)
    .setDescription(
      `Olá <@${interaction.user.id}>! 🛒\n\n` +
        "Use o menu logo abaixo para **adicionar os VIPs** que deseja comprar.\n" +
        "Quando estiver pronto, clique em **Finalizar** para gerar o pagamento via **PIX**.\n\n" +
        "🎟️ Possui um cupom de streamer? Clique em **Cupom** para aplicar **10% de desconto**.\n" +
        "❌ Quer cancelar? Clique em **Voltar** para fechar este ticket."
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  await channel.send({
    content: STAFF_ROLE_ID
      ? `<@&${STAFF_ROLE_ID}> — novo carrinho de <@${interaction.user.id}>`
      : `<@${interaction.user.id}>`,
    embeds: [welcomeEmbed],
  });

  // Mensagem do carrinho (será atualizada nas interações)
  await channel.send(renderCart(cart, VIPS));

  await interaction.editReply({
    content: `✅ Seu ticket foi criado em <#${channel.id}>! Escolha seus VIPs por lá.`,
  });
}

// Finaliza o pedido dentro do ticket: troca o carrinho pelo resumo + pagamento
export async function finalizeCartInTicket(interaction, cart, VIPS) {
  const tickets = readJSON(TICKETS_FILE, {});
  const ticket = tickets[interaction.channel.id];

  if (!ticket || ticket.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ Apenas o dono do ticket pode finalizar.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (cart.items.length === 0) {
    return interaction.reply({
      content: "❌ Adicione ao menos um item antes de finalizar.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { lines, subtotal, semPreco } = calcTotals(cart, VIPS);
  const finalPrice = cart.couponCode
    ? subtotal * (1 - COUPON_DISCOUNT_PERCENT / 100)
    : subtotal;

  // Substitui o carrinho pelo "✅ Pedido Finalizado" (sem componentes)
  const orderEmbed = new EmbedBuilder()
    .setTitle("✅ Pedido Finalizado")
    .setColor(COLOR)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Oblivion Store © 2026" });

  await interaction.update({
    embeds: [orderEmbed],
    components: [],
  });

  // Gera o pagamento via Mercado Pago (somente se houver valor a cobrar)
  let mpEmbed = null;
  let mpFile = null;
  let mpPaymentId = null;

  if (subtotal > 0) {
    try {
      const vipLabel =
        cart.items.length === 1
          ? VIPS.find((v) => v.value === cart.items[0])?.label || "Pedido"
          : `Pedido com ${cart.items.length} itens`;

      const pix = await createPixPayment({
        amount: finalPrice,
        description: `Oblivion Store - ${vipLabel}`,
        payerEmail: `discord-${interaction.user.id}@oblivion.store`,
        payerFirstName:
          interaction.user.globalName ||
          interaction.user.username ||
          "Cliente",
        externalReference: `ticket-${interaction.channel.id}`,
      });

      mpPaymentId = pix.paymentId;

      const built = buildMercadoPagoEmbed({
        vipLabel,
        originalPrice: subtotal,
        discountPercent: cart.couponCode ? COUPON_DISCOUNT_PERCENT : 0,
        qrCode: pix.qrCode,
        qrCodeBase64: pix.qrCodeBase64,
        paymentId: pix.paymentId,
        ticketUrl: pix.ticketUrl,
      });
      mpEmbed = built.embed;
      mpFile = built.file;
    } catch (err) {
      console.error("Erro ao gerar pagamento Mercado Pago:", err);
      mpEmbed = new EmbedBuilder()
        .setTitle("⚠️ Erro ao gerar pagamento")
        .setColor(0xff5555)
        .setDescription(
          `Não consegui gerar o QR Code do PIX automaticamente.\n` +
            `**Valor:** ${formatBRL(finalPrice)}\n\n` +
            `A equipe vai te ajudar manualmente neste ticket. Erro: \`${err.message}\``
        );
    }
  }

  // Persiste tudo só depois que o pagamento foi gerado com sucesso
  ticket.items = cart.items;
  ticket.price = subtotal;
  ticket.couponApplied = !!cart.couponCode;
  ticket.couponCode = cart.couponCode || null;
  ticket.discountPercent = cart.couponCode ? COUPON_DISCOUNT_PERCENT : 0;
  ticket.finalized = true;
  ticket.mpPaymentId = mpPaymentId;
  writeJSON(TICKETS_FILE, tickets);

  // Cupom só é "queimado" no cooldown ao finalizar
  if (cart.couponCode) {
    commitCouponRedemption(cart.couponCode, interaction.user.id);
  }

  // Embeds adicionais
  const followupEmbeds = [];
  if (mpEmbed) followupEmbeds.push(mpEmbed);
  if (semPreco > 0) {
    followupEmbeds.push(
      new EmbedBuilder()
        .setColor(COLOR)
        .setTitle("💬 Itens sob consulta")
        .setDescription(
          `Há **${semPreco}** item(ns) sem preço fixo no seu pedido. ` +
            `A equipe irá te informar o valor neste ticket antes da finalização.`
        )
    );
  }

  await interaction.channel.send({
    content: `<@${interaction.user.id}> seu pedido foi finalizado! ${
      subtotal > 0 ? "Pague o PIX abaixo:" : "Aguarde o atendimento da equipe."
    }`,
    embeds: followupEmbeds,
    components: [buildTicketActionsRow()],
    files: mpFile ? [mpFile] : [],
  });
}

// Confirma o pagamento (cliente OU staff) e fecha o ticket sozinho em 10s
export async function handleConfirmPayment(interaction) {
  const tickets = readJSON(TICKETS_FILE, {});
  const ticket = tickets[interaction.channel.id];

  if (!ticket) {
    return interaction.reply({
      content: "❌ Este canal não é um ticket válido.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!ticket.finalized) {
    return interaction.reply({
      content:
        "❌ Você precisa **finalizar o pedido** antes de confirmar o pagamento.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (ticket.paymentConfirmed) {
    return interaction.reply({
      content: "ℹ️ Este pagamento já foi confirmado. O ticket vai fechar em instantes.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const isOwner = ticket.userId === interaction.user.id;
  const isStaff =
    STAFF_ROLE_ID && interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);
  const hasManage = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );

  if (!isOwner && !isStaff && !hasManage) {
    return interaction.reply({
      content: "❌ Apenas o dono do ticket ou a equipe pode confirmar o pagamento.",
      flags: MessageFlags.Ephemeral,
    });
  }

  ticket.paymentConfirmed = true;
  ticket.paymentConfirmedAt = Date.now();
  ticket.paymentConfirmedBy = interaction.user.id;
  ticket.open = false;
  ticket.closedAt = Date.now();
  writeJSON(TICKETS_FILE, tickets);
  clearCart(ticket.userId);

  const confirmEmbed = new EmbedBuilder()
    .setTitle("✅ Pagamento Confirmado!")
    .setColor(0x57f287)
    .setDescription(
      `Confirmado por <@${interaction.user.id}>${
        isOwner ? " (cliente)" : " (equipe)"
      }.\n\n` +
        `🎮 Em breve a equipe vai te entregar o seu **VIP**.\n` +
        `🔒 Este ticket será fechado automaticamente em **10 segundos**.\n\n` +
        `Obrigado pela compra! 💜`
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  const mentions = [`<@${ticket.userId}>`];
  if (STAFF_ROLE_ID && isOwner) mentions.push(`<@&${STAFF_ROLE_ID}>`);

  await interaction.reply({
    content: mentions.join(" "),
    embeds: [confirmEmbed],
  });

  setTimeout(() => {
    interaction.channel.delete().catch((err) =>
      console.error("Erro ao deletar canal após confirmação:", err)
    );
  }, 10000);
}

export async function handleCloseTicket(interaction) {
  const tickets = readJSON(TICKETS_FILE, {});
  const ticket = tickets[interaction.channel.id];

  if (!ticket) {
    return interaction.reply({
      content: "❌ Este canal não é um ticket válido.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const isOwner = ticket.userId === interaction.user.id;
  const hasManage = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );
  const isStaff =
    STAFF_ROLE_ID && interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);

  if (!isOwner && !hasManage && !isStaff) {
    return interaction.reply({
      content: "❌ Você não tem permissão para fechar este ticket.",
      flags: MessageFlags.Ephemeral,
    });
  }

  ticket.open = false;
  ticket.closedAt = Date.now();
  writeJSON(TICKETS_FILE, tickets);
  clearCart(ticket.userId);

  await interaction.reply({
    content: "🔒 Este ticket será fechado em 5 segundos...",
  });

  setTimeout(() => {
    interaction.channel.delete().catch((err) =>
      console.error("Erro ao deletar canal de ticket:", err)
    );
  }, 5000);
}
