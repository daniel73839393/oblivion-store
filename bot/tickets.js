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
import { createPixPayment, getPaymentStatus } from "./mercadopago.js";
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

// Polling de verificação automática de pagamento (canalId -> handle)
const paymentPollers = new Map();
const POLL_INTERVAL_MS = 15 * 1000; // checa a cada 15s
const POLL_FIRST_CHECK_MS = 5 * 1000; // 1ª checagem 5s depois de gerar o PIX
const POLL_MAX_DURATION_MS = 35 * 60 * 1000; // para após 35min (PIX expira em 30)

function stopPaymentPoller(channelId) {
  const handle = paymentPollers.get(channelId);
  if (handle) {
    if (handle.firstCheck) clearTimeout(handle.firstCheck);
    if (handle.interval) clearInterval(handle.interval);
    if (handle.timeout) clearTimeout(handle.timeout);
    paymentPollers.delete(channelId);
  }
}

async function checkAndConfirmPayment(channel, paymentId, userId) {
  try {
    const tickets = readJSON(TICKETS_FILE, {});
    const ticket = tickets[channel.id];

    // Se o ticket sumiu, foi fechado, ou já confirmado, encerra
    if (!ticket || !ticket.open || ticket.mpApproved) {
      stopPaymentPoller(channel.id);
      return;
    }

    const status = await getPaymentStatus(paymentId);
    if (!status.approved) return; // continua tentando

    // Pagamento aprovado pelo MP! Marca, libera o botão e PARA o polling.
    // (O ticket NÃO fecha sozinho — o cliente clica em "Confirmar e Encerrar".)
    ticket.mpApproved = true;
    ticket.mpApprovedAt = Date.now();
    writeJSON(TICKETS_FILE, tickets);
    stopPaymentPoller(channel.id);

    const embed = new EmbedBuilder()
      .setTitle("✅ Pagamento Recebido!")
      .setColor(0x57f287)
      .setDescription(
        `🎉 Confirmamos o seu pagamento via **Mercado Pago**!\n\n` +
          `🎮 A equipe foi notificada e vai te entregar o seu **VIP** em instantes.\n\n` +
          `Quando receber o VIP, clique em **Confirmar e Encerrar** abaixo pra fechar o ticket.\n\n` +
          `Obrigado pela compra! 💜`
      )
      .setFooter({ text: "Oblivion Store © 2026" });

    const mentions = [`<@${userId}>`];
    if (STAFF_ROLE_ID) mentions.push(`<@&${STAFF_ROLE_ID}>`);

    await channel.send({
      content: mentions.join(" "),
      embeds: [embed],
      components: [buildPostPaymentActionsRow()],
    });
  } catch (err) {
    console.error("Erro no poller de pagamento:", err.message);
  }
}

function startPaymentPoller(channel, paymentId, userId) {
  // Se já existe um poller pra esse canal, para o anterior
  stopPaymentPoller(channel.id);

  const handle = {};

  // 1ª checagem rápida (5s após gerar o PIX) — pega quem pagou na hora
  handle.firstCheck = setTimeout(
    () => checkAndConfirmPayment(channel, paymentId, userId),
    POLL_FIRST_CHECK_MS
  );

  // Depois checa a cada 15s
  handle.interval = setInterval(
    () => checkAndConfirmPayment(channel, paymentId, userId),
    POLL_INTERVAL_MS
  );

  handle.timeout = setTimeout(
    () => stopPaymentPoller(channel.id),
    POLL_MAX_DURATION_MS
  );

  paymentPollers.set(channel.id, handle);
}

export const TICKET_CLOSE_ID = "ticket_close";
export const TICKET_CONFIRM_PAY_ID = "ticket_confirm_pay";

// Cria um ticket de pagamento já aprovado pela staff para um VIP Personalizado.
// Diferente do fluxo normal, este ticket nasce com o pedido finalizado e o PIX gerado
// no preço definido pela equipe.
export async function createCustomVipTicket({ guild, user, request, finalPrice, approvedBy }) {
  const tickets = readJSON(TICKETS_FILE, {});

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: user.id,
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
    user.username
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "user";

  const channel = await guild.channels.create({
    name: `vip-personalizado-${safeName}`,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    topic: `VIP Personalizado — ${user.tag}`,
  });

  const vipLabel = request.title
    ? `VIP Personalizado — ${request.title}`
    : "VIP Personalizado";

  let mpEmbed = null;
  let mpFile = null;
  let mpPaymentId = null;
  let pixCopyPaste = null;

  try {
    const pix = await createPixPayment({
      amount: finalPrice,
      description: `Oblivion Store - ${vipLabel}`,
      payerEmail: `discord-${user.id}@oblivion.store`,
      payerFirstName: user.globalName || user.username || "Cliente",
      externalReference: `custom-${request.id}`,
    });

    mpPaymentId = pix.paymentId;
    pixCopyPaste = pix.qrCode;

    const built = buildMercadoPagoEmbed({
      vipLabel,
      originalPrice: finalPrice,
      discountPercent: 0,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
      paymentId: pix.paymentId,
      ticketUrl: pix.ticketUrl,
    });
    mpEmbed = built.embed;
    mpFile = built.file;
  } catch (err) {
    console.error("Erro ao gerar pagamento do VIP Personalizado:", err);
    mpEmbed = new EmbedBuilder()
      .setTitle("⚠️ Erro ao gerar pagamento")
      .setColor(0xff5555)
      .setDescription(
        `Não consegui gerar o QR Code do PIX automaticamente.\n` +
          `**Valor:** ${formatBRL(finalPrice)}\n\n` +
          `A equipe vai te ajudar manualmente neste ticket. Erro: \`${err.message}\``
      );
  }

  tickets[channel.id] = {
    userId: user.id,
    items: ["personalizado"],
    couponCode: null,
    couponApplied: false,
    discountPercent: 0,
    price: finalPrice,
    finalized: true,
    open: true,
    createdAt: Date.now(),
    mpPaymentId,
    pixCopyPaste,
    customRequestId: request.id,
    customTitle: request.title,
    approvedBy: approvedBy?.id || null,
  };
  writeJSON(TICKETS_FILE, tickets);

  const requestSummary = new EmbedBuilder()
    .setTitle("💎 VIP Personalizado — Pedido Aprovado")
    .setColor(COLOR)
    .setDescription(
      `Olá <@${user.id}>! ✨\n\n` +
        `Seu pedido de **VIP Personalizado** foi **aprovado** pela equipe.\n\n` +
        `**Título:** ${request.title}\n` +
        `**Descrição:**\n${request.description}\n\n` +
        `**Valor combinado:** ${formatBRL(finalPrice)}\n\n` +
        `Pague o PIX abaixo para liberar o seu VIP. Assim que o pagamento cair, ` +
        `o bot detecta automaticamente e libera o botão de confirmação.`
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  await channel.send({
    content: STAFF_ROLE_ID
      ? `<@${user.id}> <@&${STAFF_ROLE_ID}>`
      : `<@${user.id}>`,
    embeds: [requestSummary],
  });

  await channel.send({
    content: `<@${user.id}> seu pedido foi aprovado! Pague o PIX abaixo:`,
    embeds: mpEmbed ? [mpEmbed] : [],
    files: mpFile ? [mpFile] : [],
  });

  if (pixCopyPaste) {
    await channel.send({
      content: `\`\`\`\n${pixCopyPaste}\n\`\`\``,
    });
  }

  await channel.send({
    content:
      mpPaymentId
        ? "👆 Toque no código acima pra copiar. Assim que o pagamento cair, o bot **detecta automaticamente** e libera o botão de confirmação."
        : "Use os botões abaixo:",
    components: [buildTicketActionsRow()],
  });

  if (mpPaymentId) {
    startPaymentPoller(channel, mpPaymentId, user.id);
  }

  return channel;
}

// Painel inicial: SEM botão de confirmar (evita que o cliente clique antes de pagar)
function buildTicketActionsRow() {
  return new ActionRowBuilder().addComponents(
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

// Painel pós-pagamento: liberado APÓS o MP confirmar — agora o botão é seguro
function buildPostPaymentActionsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CONFIRM_PAY_ID)
      .setLabel("Confirmar e Encerrar")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
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
      // Guarda pra enviar em mensagem separada (facilita o copiar/colar no celular)
      ticket.pixCopyPaste = pix.qrCode;
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
    files: mpFile ? [mpFile] : [],
  });

  // Envia o "Copia e Cola" SOZINHO numa mensagem separada,
  // sem nenhum texto junto, pra evitar que o usuário copie a mensagem inteira por engano.
  if (ticket.pixCopyPaste) {
    await interaction.channel.send({
      content: `\`\`\`\n${ticket.pixCopyPaste}\n\`\`\``,
    });
  }

  // Botões de ação ficam na última mensagem do ticket
  await interaction.channel.send({
    content:
      subtotal > 0
        ? "👆 Toque no código acima pra copiar. Assim que o pagamento cair, o bot **detecta automaticamente** e libera o botão de confirmação."
        : "Use os botões abaixo:",
    components: [buildTicketActionsRow()],
  });

  // Inicia a verificação automática (consulta MP a cada 30s)
  if (mpPaymentId) {
    startPaymentPoller(interaction.channel, mpPaymentId, interaction.user.id);
  }
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
  const isStaffOverride = isStaff || hasManage;

  if (!isOwner && !isStaffOverride) {
    return interaction.reply({
      content: "❌ Apenas o dono do ticket ou a equipe pode confirmar o pagamento.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Cliente: o botão SÓ aparece depois do MP confirmar (mpApproved = true).
  // Mesmo assim, revalida no MP por segurança antes de fechar.
  if (isOwner && !isStaffOverride) {
    if (!ticket.mpApproved) {
      return interaction.reply({
        content:
          "❌ O pagamento ainda **não foi recebido** pelo Mercado Pago. " +
          "Assim que cair, o botão será liberado automaticamente.",
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
    stopPaymentPoller(interaction.channel.id);

    const embed = new EmbedBuilder()
      .setTitle("✅ Atendimento Encerrado")
      .setColor(0x57f287)
      .setDescription(
        `Obrigado pela compra! 💜\n\n` +
          `🔒 Este ticket será fechado em **10 segundos**.`
      )
      .setFooter({ text: "Oblivion Store © 2026" });

    await interaction.reply({
      content: `<@${ticket.userId}>`,
      embeds: [embed],
    });

    setTimeout(() => {
      interaction.channel.delete().catch((err) =>
        console.error("Erro ao deletar canal após confirmação:", err)
      );
    }, 10000);
    return;
  }

  // Caminho da staff (override manual, sem checar MP)
  ticket.paymentConfirmed = true;
  ticket.paymentConfirmedAt = Date.now();
  ticket.paymentConfirmedBy = interaction.user.id;
  ticket.open = false;
  ticket.closedAt = Date.now();
  writeJSON(TICKETS_FILE, tickets);
  clearCart(ticket.userId);
  stopPaymentPoller(interaction.channel.id);

  const confirmEmbed = new EmbedBuilder()
    .setTitle("✅ Pagamento Confirmado pela Equipe")
    .setColor(0x57f287)
    .setDescription(
      `Confirmado manualmente por <@${interaction.user.id}>.\n\n` +
        `🎮 Seu **VIP** será liberado em instantes.\n` +
        `🔒 Este ticket será fechado em **10 segundos**.\n\n` +
        `Obrigado pela compra! 💜`
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  await interaction.reply({
    content: `<@${ticket.userId}>`,
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
  stopPaymentPoller(interaction.channel.id);

  await interaction.reply({
    content: "🔒 Este ticket será fechado em 5 segundos...",
  });

  setTimeout(() => {
    interaction.channel.delete().catch((err) =>
      console.error("Erro ao deletar canal de ticket:", err)
    );
  }, 5000);
}
