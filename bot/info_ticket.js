// Ticket de informações dos VIPs
// - Cria um canal privado temporário onde o usuário escolhe um VIP
// - O bot mostra os benefícios desse VIP
// - O canal se fecha sozinho após 5 minutos
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { readJSON, writeJSON } from "./storage.js";
import { createCustomVipTicket } from "./tickets.js";
import { formatBRL } from "./payment.js";

const COLOR = 0x9966cc;
const AUTO_CLOSE_MS = 5 * 60 * 1000; // 5 minutos
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;
const CUSTOM_VIP_CHANNEL_ID = process.env.CUSTOM_VIP_CHANNEL_ID || null;

export const INFO_VIP_SELECT_ID = "info_vip_select";
export const CUSTOM_VIP_MODAL_ID = "custom_vip_modal";
export const CUSTOM_VIP_TITLE_ID = "custom_vip_title";
export const CUSTOM_VIP_DESC_ID = "custom_vip_desc";
export const CUSTOM_VIP_BUDGET_ID = "custom_vip_budget";
export const CUSTOM_VIP_CONTACT_ID = "custom_vip_contact";

// Botão e modal usados pela staff para aprovar um pedido
export const CUSTOM_VIP_APPROVE_PREFIX = "custom_vip_approve:";
export const CUSTOM_VIP_REJECT_PREFIX = "custom_vip_reject:";
export const CUSTOM_VIP_APPROVE_MODAL_PREFIX = "custom_vip_approve_modal:";
export const CUSTOM_VIP_PRICE_INPUT_ID = "custom_vip_price";

const CUSTOM_VIP_FILE = "custom_vip_requests.json";

// Mantém referência dos canais de info abertos por usuário (1 por vez)
const openInfoChannels = new Map();

export async function handleCreateInfoTicket(interaction, VIPS) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: "❌ Esse recurso só funciona dentro de um servidor.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Se já existir um canal de info aberto pra esse usuário, manda ele pra lá
  const existingId = openInfoChannels.get(interaction.user.id);
  if (existingId) {
    const existing = guild.channels.cache.get(existingId);
    if (existing) {
      return interaction.reply({
        content: `❌ Você já tem uma janela de benefícios aberta: <#${existingId}>`,
        flags: MessageFlags.Ephemeral,
      });
    }
    openInfoChannels.delete(interaction.user.id);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [PermissionFlagsBits.SendMessages],
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
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const safeName =
    interaction.user.username
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "user";

  let channel;
  try {
    channel = await guild.channels.create({
      name: `info-${safeName}`,
      type: ChannelType.GuildText,
      parent: interaction.channel?.parentId ?? undefined,
      permissionOverwrites: overwrites,
      topic: `Benefícios dos VIPs — ${interaction.user.tag}`,
    });
  } catch (err) {
    console.error("Erro ao criar canal de info:", err);
    return interaction.editReply({
      content:
        "❌ Não consegui criar o canal. Verifique se eu tenho a permissão **Gerenciar Canais**.",
    });
  }

  openInfoChannels.set(interaction.user.id, channel.id);

  const intro = new EmbedBuilder()
    .setTitle("📋 Benefícios dos VIPs")
    .setColor(COLOR)
    .setDescription(
      `Olá <@${interaction.user.id}>! 👋\n\n` +
        "Selecione um **VIP** no menu abaixo para ver tudo que ele oferece.\n\n" +
        "⏳ Este canal será **fechado automaticamente em 5 minutos**."
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(INFO_VIP_SELECT_ID)
      .setPlaceholder("Selecione um VIP para ver os benefícios...")
      .addOptions(
        VIPS.map((v) => ({
          label: v.label,
          value: v.value,
          description: v.description,
          emoji: v.emoji,
        }))
      )
  );

  await channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [intro],
    components: [selectRow],
  });

  await interaction.editReply({
    content: `✅ Canal aberto em <#${channel.id}>! Ele fecha em 5 minutos.`,
  });

  // Auto-fecha em 5 minutos
  setTimeout(async () => {
    openInfoChannels.delete(interaction.user.id);
    try {
      const ch = guild.channels.cache.get(channel.id);
      if (ch) await ch.delete("Auto-fechamento (5 minutos)");
    } catch (err) {
      console.error("Erro ao auto-fechar canal de info:", err);
    }
  }, AUTO_CLOSE_MS);
}

export async function handleInfoVipSelect(interaction, VIPS) {
  const value = interaction.values[0];
  const vip = VIPS.find((v) => v.value === value);
  if (!vip) {
    return interaction.reply({
      content: "❌ VIP inválido.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // VIP Personalizado abre um modal para o usuário descrever o que deseja
  if (vip.value === "personalizado") {
    return showCustomVipModal(interaction, vip);
  }

  const priceLine =
    typeof vip.price === "number"
      ? `**Preço:** R$ ${vip.price.toFixed(2).replace(".", ",")}\n\n`
      : "";

  const embed = new EmbedBuilder()
    .setTitle(`${vip.emoji} VIP ${vip.label} — Benefícios`)
    .setColor(COLOR)
    .setDescription(
      priceLine +
        "**O que está incluído:**\n" +
        vip.perks +
        "\n\n_Para comprar, volte na loja e clique em **Fazer Compras**._"
    )
    .setFooter({ text: "Oblivion Store © 2026" });

  await interaction.reply({ embeds: [embed] });
}

async function showCustomVipModal(interaction, vip) {
  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_VIP_MODAL_ID)
    .setTitle(`${vip.emoji} VIP Personalizado`);

  const titleInput = new TextInputBuilder()
    .setCustomId(CUSTOM_VIP_TITLE_ID)
    .setLabel("Nome / título do VIP desejado")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setPlaceholder("Ex.: VIP Phoenix")
    .setRequired(true);

  const descInput = new TextInputBuilder()
    .setCustomId(CUSTOM_VIP_DESC_ID)
    .setLabel("Descreva os benefícios que deseja")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1500)
    .setPlaceholder(
      "Liste tudo o que você gostaria que esse VIP tivesse (cargos, comandos, kits, etc.)"
    )
    .setRequired(true);

  const budgetInput = new TextInputBuilder()
    .setCustomId(CUSTOM_VIP_BUDGET_ID)
    .setLabel("Orçamento (opcional)")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(50)
    .setPlaceholder("Ex.: até R$ 80,00")
    .setRequired(false);

  const contactInput = new TextInputBuilder()
    .setCustomId(CUSTOM_VIP_CONTACT_ID)
    .setLabel("Contato adicional (opcional)")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setPlaceholder("Discord, e-mail, etc.")
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(budgetInput),
    new ActionRowBuilder().addComponents(contactInput)
  );

  await interaction.showModal(modal);
}

export async function handleCustomVipModalSubmit(interaction) {
  const title = interaction.fields.getTextInputValue(CUSTOM_VIP_TITLE_ID).trim();
  const description = interaction.fields
    .getTextInputValue(CUSTOM_VIP_DESC_ID)
    .trim();
  const budget = (
    interaction.fields.getTextInputValue(CUSTOM_VIP_BUDGET_ID) || ""
  ).trim();
  const contact = (
    interaction.fields.getTextInputValue(CUSTOM_VIP_CONTACT_ID) || ""
  ).trim();

  const now = new Date();
  const requestId = `cv_${now.getTime()}_${interaction.user.id}`;

  // Atualiza a memória (persistência em arquivo JSON)
  const all = readJSON(CUSTOM_VIP_FILE, []);
  const record = {
    id: requestId,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    title,
    description,
    budget: budget || null,
    contact: contact || null,
    createdAt: now.toISOString(),
    status: "pendente",
  };
  all.push(record);
  writeJSON(CUSTOM_VIP_FILE, all);

  // Embed com as informações do pedido
  const embed = new EmbedBuilder()
    .setTitle("💎 Novo pedido de VIP Personalizado")
    .setColor(COLOR)
    .setThumbnail(interaction.user.displayAvatarURL())
    .setDescription(
      `Um novo pedido de **VIP Personalizado** foi enviado.\n\n` +
        `**Título:** ${title}\n` +
        `**Descrição:**\n${description}` +
        (budget ? `\n\n**Orçamento:** ${budget}` : "") +
        (contact ? `\n\n**Contato:** ${contact}` : "")
    )
    .addFields(
      { name: "👤 Usuário", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
      { name: "🆔 ID do Usuário", value: interaction.user.id, inline: true },
      {
        name: "🕒 Horário",
        value: `<t:${Math.floor(now.getTime() / 1000)}:F>`,
        inline: false,
      },
      { name: "📌 ID do Pedido", value: requestId, inline: false }
    )
    .setFooter({ text: "Oblivion Store © 2026 — Pedido de VIP Personalizado" })
    .setTimestamp(now);

  // Botões de aprovação para a staff
  const staffActions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_VIP_APPROVE_PREFIX}${requestId}`)
      .setLabel("Aprovar e gerar pagamento")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_VIP_REJECT_PREFIX}${requestId}`)
      .setLabel("Recusar pedido")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
  );

  // Envia para o canal especializado e marca os admins
  let deliveredToChannel = false;
  if (CUSTOM_VIP_CHANNEL_ID && interaction.guild) {
    try {
      const channel = await interaction.guild.channels
        .fetch(CUSTOM_VIP_CHANNEL_ID)
        .catch(() => null);
      if (channel && channel.isTextBased()) {
        const mention = STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}>` : "@here";
        const sent = await channel.send({
          content: `${mention} novo pedido de **VIP Personalizado** recebido!`,
          embeds: [embed],
          components: [staffActions],
          allowedMentions: STAFF_ROLE_ID
            ? { roles: [STAFF_ROLE_ID] }
            : { parse: ["everyone"] },
        });
        record.staffMessageId = sent.id;
        record.staffChannelId = sent.channelId;
        // regrava com a referência da mensagem
        const updated = readJSON(CUSTOM_VIP_FILE, []);
        const idx = updated.findIndex((r) => r.id === requestId);
        if (idx >= 0) {
          updated[idx] = record;
          writeJSON(CUSTOM_VIP_FILE, updated);
        }
        deliveredToChannel = true;
      }
    } catch (err) {
      console.error("Erro ao enviar pedido de VIP personalizado:", err);
    }
  }

  const confirmationLines = [
    "✅ **Pedido de VIP Personalizado enviado!**",
    "",
    `**Título:** ${title}`,
    `**Descrição:**\n${description}`,
  ];
  if (budget) confirmationLines.push(`**Orçamento:** ${budget}`);
  if (contact) confirmationLines.push(`**Contato:** ${contact}`);
  confirmationLines.push("", `**ID do pedido:** \`${requestId}\``);
  if (deliveredToChannel) {
    confirmationLines.push("A equipe foi avisada e responderá em breve.");
  } else {
    confirmationLines.push(
      "_O pedido foi salvo, mas o canal de pedidos ainda não está configurado. Avise a equipe._"
    );
  }

  await interaction.reply({
    content: confirmationLines.join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- Aprovação / recusa do pedido pela staff ----------

function isStaff(interaction) {
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  if (
    STAFF_ROLE_ID &&
    interaction.member?.roles?.cache?.has(STAFF_ROLE_ID)
  ) {
    return true;
  }
  return false;
}

function findRequest(requestId) {
  const all = readJSON(CUSTOM_VIP_FILE, []);
  const idx = all.findIndex((r) => r.id === requestId);
  if (idx < 0) return { all, idx: -1, request: null };
  return { all, idx, request: all[idx] };
}

// Mostra modal pedindo o valor final do VIP
export async function handleCustomVipApproveButton(interaction) {
  const requestId = interaction.customId.slice(CUSTOM_VIP_APPROVE_PREFIX.length);
  if (!isStaff(interaction)) {
    return interaction.reply({
      content: "❌ Apenas a equipe pode aprovar este pedido.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { request } = findRequest(requestId);
  if (!request) {
    return interaction.reply({
      content: "❌ Pedido não encontrado.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (request.status !== "pendente") {
    return interaction.reply({
      content: `ℹ️ Este pedido já está com status **${request.status}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`${CUSTOM_VIP_APPROVE_MODAL_PREFIX}${requestId}`)
    .setTitle("Aprovar VIP Personalizado");

  const priceInput = new TextInputBuilder()
    .setCustomId(CUSTOM_VIP_PRICE_INPUT_ID)
    .setLabel("Valor final em R$ (ex.: 75,00)")
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(20)
    .setPlaceholder("Ex.: 75,00")
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));
  await interaction.showModal(modal);
}

function parseBRLPrice(raw) {
  if (!raw) return NaN;
  const cleaned = raw
    .replace(/[^\d,.\-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

// Recebe o preço e abre o ticket de pagamento para o usuário
export async function handleCustomVipApproveModal(interaction) {
  const requestId = interaction.customId.slice(
    CUSTOM_VIP_APPROVE_MODAL_PREFIX.length
  );
  if (!isStaff(interaction)) {
    return interaction.reply({
      content: "❌ Apenas a equipe pode aprovar este pedido.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { all, idx, request } = findRequest(requestId);
  if (!request) {
    return interaction.reply({
      content: "❌ Pedido não encontrado.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (request.status !== "pendente") {
    return interaction.reply({
      content: `ℹ️ Este pedido já está com status **${request.status}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const rawPrice = interaction.fields
    .getTextInputValue(CUSTOM_VIP_PRICE_INPUT_ID)
    .trim();
  const finalPrice = parseBRLPrice(rawPrice);
  if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
    return interaction.reply({
      content: "❌ Valor inválido. Use o formato `75,00`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const member = await guild.members.fetch(request.userId).catch(() => null);
  if (!member) {
    return interaction.editReply({
      content: "❌ O usuário do pedido não está mais no servidor.",
    });
  }

  let ticketChannel;
  try {
    ticketChannel = await createCustomVipTicket({
      guild,
      user: member.user,
      request,
      finalPrice,
      approvedBy: interaction.user,
    });
  } catch (err) {
    console.error("Erro ao criar ticket de VIP Personalizado:", err);
    return interaction.editReply({
      content: `❌ Não consegui criar o ticket: \`${err.message}\``,
    });
  }

  // Atualiza o pedido na memória
  all[idx] = {
    ...request,
    status: "aprovado",
    finalPrice,
    approvedBy: interaction.user.id,
    approvedAt: new Date().toISOString(),
    ticketChannelId: ticketChannel.id,
  };
  writeJSON(CUSTOM_VIP_FILE, all);

  // Atualiza a mensagem original na staff (remove os botões e marca como aprovado)
  try {
    const original = interaction.message;
    if (original) {
      const oldEmbed = original.embeds?.[0];
      const newEmbed = oldEmbed
        ? EmbedBuilder.from(oldEmbed)
            .setTitle("💎 Pedido de VIP Personalizado — APROVADO")
            .setColor(0x57f287)
        : null;
      const fields = [
        {
          name: "✅ Aprovado por",
          value: `<@${interaction.user.id}>`,
          inline: true,
        },
        {
          name: "💰 Valor final",
          value: formatBRL(finalPrice),
          inline: true,
        },
        {
          name: "🎟️ Ticket de pagamento",
          value: `<#${ticketChannel.id}>`,
          inline: false,
        },
      ];
      if (newEmbed) newEmbed.addFields(fields);

      await original.edit({
        content: `✅ Pedido aprovado por <@${interaction.user.id}>.`,
        embeds: newEmbed ? [newEmbed] : original.embeds,
        components: [],
      });
    }
  } catch (err) {
    console.error("Erro ao atualizar mensagem original do pedido:", err);
  }

  await interaction.editReply({
    content: `✅ Pedido aprovado! Ticket de pagamento criado em <#${ticketChannel.id}> para <@${request.userId}>.`,
  });
}

export async function handleCustomVipRejectButton(interaction) {
  const requestId = interaction.customId.slice(CUSTOM_VIP_REJECT_PREFIX.length);
  if (!isStaff(interaction)) {
    return interaction.reply({
      content: "❌ Apenas a equipe pode recusar este pedido.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { all, idx, request } = findRequest(requestId);
  if (!request) {
    return interaction.reply({
      content: "❌ Pedido não encontrado.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (request.status !== "pendente") {
    return interaction.reply({
      content: `ℹ️ Este pedido já está com status **${request.status}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  all[idx] = {
    ...request,
    status: "recusado",
    rejectedBy: interaction.user.id,
    rejectedAt: new Date().toISOString(),
  };
  writeJSON(CUSTOM_VIP_FILE, all);

  try {
    const original = interaction.message;
    if (original) {
      const oldEmbed = original.embeds?.[0];
      const newEmbed = oldEmbed
        ? EmbedBuilder.from(oldEmbed)
            .setTitle("💎 Pedido de VIP Personalizado — RECUSADO")
            .setColor(0xed4245)
            .addFields({
              name: "❌ Recusado por",
              value: `<@${interaction.user.id}>`,
              inline: true,
            })
        : null;
      await original.edit({
        content: `❌ Pedido recusado por <@${interaction.user.id}>.`,
        embeds: newEmbed ? [newEmbed] : original.embeds,
        components: [],
      });
    }
  } catch (err) {
    console.error("Erro ao atualizar mensagem original do pedido:", err);
  }

  await interaction.reply({
    content: `❌ Pedido recusado.`,
    flags: MessageFlags.Ephemeral,
  });
}
