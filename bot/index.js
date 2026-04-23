// Bot de Discord - Loja de VIPs (Oblivion Store)
// discord.js v14 - com loja, carrinho, tickets, cupons e pagamento PIX
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Events,
  MessageFlags,
} from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleCreateShoppingTicket,
  finalizeCartInTicket,
  handleCloseTicket,
  handleConfirmPayment,
  getOwnedTicket,
  TICKET_CLOSE_ID,
  TICKET_CONFIRM_PAY_ID,
} from "./tickets.js";

import {
  showCouponModal,
  handleCouponModalSubmit,
  handleAddCupom,
  handleRmCupom,
  handleListCupons,
  validateCouponForUser,
  COUPON_BUTTON_ID,
  COUPON_MODAL_ID,
  COUPON_INPUT_ID,
} from "./coupons.js";

import {
  getCart,
  clearCart,
  addItem,
  removeItem,
  renderCart,
  showCartCouponModal,
  CART_ADD_ID,
  CART_REMOVE_ID,
  CART_BACK_ID,
  CART_CLEAR_ID,
  CART_COUPON_ID,
  CART_FINALIZE_ID,
  CART_COUPON_MODAL_ID,
  CART_COUPON_INPUT_ID,
} from "./cart.js";

import { startKeepAliveServer } from "./keepalive.js";

import {
  handleCreateInfoTicket,
  handleInfoVipSelect,
  handleCustomVipModalSubmit,
  INFO_VIP_SELECT_ID,
  CUSTOM_VIP_MODAL_ID,
} from "./info_ticket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = path.join(__dirname, "assets", "loja_banner.png");

// Lista central de VIPs - facilita manutenção e expansão futura
// O campo "perks" é exibido no painel "Ver Benefícios" — edite com a lista real de cada VIP.
const VIPS = [
  {
    label: "Aurelium",
    value: "aurelium",
    emoji: "✨",
    description: "VIP Aurelium",
    perks: "_(Configure os benefícios deste VIP no arquivo `bot/index.js`)_",
  },
  {
    label: "Elysium",
    value: "elysium",
    emoji: "🌌",
    description: "VIP Elysium",
    perks: "_(Configure os benefícios deste VIP no arquivo `bot/index.js`)_",
  },
  {
    label: "Luminar",
    value: "luminar",
    emoji: "💡",
    description: "VIP Luminar",
    perks: "_(Configure os benefícios deste VIP no arquivo `bot/index.js`)_",
  },
  {
    label: "Arcanjo",
    value: "arcanjo",
    emoji: "😇",
    description: "VIP Arcanjo",
    perks: "_(Configure os benefícios deste VIP no arquivo `bot/index.js`)_",
  },
  {
    label: "Dragon",
    value: "dragon",
    emoji: "🐉",
    description: "VIP Dragon",
    perks: "_(Configure os benefícios deste VIP no arquivo `bot/index.js`)_",
  },
  {
    label: "Personalizado",
    value: "personalizado",
    emoji: "💎",
    description: "VIP Personalizado - R$ 60,00",
    price: 60.0,
    perks: "_(Configure os benefícios deste VIP no arquivo `bot/index.js`)_",
  },
];

const BTN_BUY_ID     = "shop_buy";
const BTN_INFO_ID    = "shop_info";
const BTN_TERMS_ID   = "shop_terms";
const BTN_SUPPORT_ID = "shop_support";
const BTN_HELP_ID    = "shop_help";

const COLOR = 0x9966cc;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- Embeds & componentes da loja ----------
function buildLojaEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🛒 Central de Vendas — Oblivion Store")
    .setDescription(
      "**Bem-vindo à loja oficial da Oblivion!** ✨\n" +
        "Aqui você adquire seus **VIPs exclusivos**, libera benefícios " +
        "no servidor e ainda pode usar **cupons de streamers** para ganhar desconto.\n\n" +
        "⚠️ **Fique atento na hora da compra para não escolher o VIP errado!**\n\n" +
        "Em caso de dúvida sobre o VIP correto ou qualquer outro assunto, " +
        "clique em **Suporte** ou **Dúvidas** abaixo.\n\n" +
        "🛒 **Clique em `Fazer Compras` para escolher seu VIP.**"
    )
    .setImage("attachment://loja_banner.png")
    .setFooter({ text: "Oblivion Store © 2026" });
}

function buildLojaButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_BUY_ID)
      .setLabel("Fazer Compras")
      .setEmoji("🛒")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(BTN_INFO_ID)
      .setLabel("Ver Benefícios")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN_TERMS_ID)
      .setLabel("Termos")
      .setEmoji("📜")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN_SUPPORT_ID)
      .setLabel("Suporte")
      .setEmoji("🛟")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN_HELP_ID)
      .setLabel("Dúvidas")
      .setEmoji("❓")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ---------- Embeds informativos (botões secundários) ----------
function buildTermsEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📜 Termos de Compra")
    .setDescription(
      "**Ao realizar uma compra na Oblivion Store você concorda que:**\n\n" +
        "• Todos os VIPs são **virtuais** e fornecidos dentro do servidor.\n" +
        "• **Não há reembolso** após a entrega do VIP.\n" +
        "• O pagamento deve ser feito **somente** pela chave PIX informada no ticket.\n" +
        "• A entrega do VIP ocorre após a confirmação do pagamento pela equipe.\n" +
        "• Cupons de streamers podem ser resgatados **1 vez a cada 30 dias** por usuário.\n" +
        "• Tentativas de fraude resultam em **banimento permanente**."
    )
    .setFooter({ text: "Oblivion Store © 2026" });
}

function buildSupportEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🛟 Suporte")
    .setDescription(
      "Precisa falar com a equipe?\n\n" +
        "🛒 Para **comprar um VIP**, clique em **Fazer Compras** e finalize seu pedido.\n" +
        "💬 Para **outros assuntos**, abra um ticket pelo canal de atendimento " +
        "do servidor ou marque um membro da equipe.\n\n" +
        "_A equipe responde de segunda a domingo, das 10h às 23h._"
    )
    .setFooter({ text: "Oblivion Store © 2026" });
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("❓ Dúvidas Frequentes")
    .setDescription(
      "**Como compro um VIP?**\n" +
        "Clique em **Fazer Compras**, adicione os VIPs ao pedido e clique em **Finalizar** para abrir um ticket.\n\n" +
        "**Como funciona o cupom de streamer?**\n" +
        "Dentro do carrinho ou do ticket, clique em **Cupom** e digite o código. " +
        "Cada cupom pode ser usado **1x a cada 30 dias** e dá **10% de desconto** no pedido.\n\n" +
        "**Como pago?**\n" +
        "Após finalizar, o bot mostra o valor total e a chave **PIX** no ticket. " +
        "Envie o comprovante no próprio ticket.\n\n" +
        "**Em quanto tempo recebo o VIP?**\n" +
        "Assim que a equipe confirmar o pagamento — geralmente em poucos minutos."
    )
    .setFooter({ text: "Oblivion Store © 2026" });
}

// ---------- Eventos ----------
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const raw = message.content.trim();
  if (!raw.startsWith("!")) return;

  const [cmd, ...args] = raw.split(/\s+/);
  const cmdLower = cmd.toLowerCase();

  try {
    switch (cmdLower) {
      case "!loja": {
        const banner = new AttachmentBuilder(BANNER_PATH, {
          name: "loja_banner.png",
        });
        await message.channel.send({
          embeds: [buildLojaEmbed()],
          components: [buildLojaButtonsRow()],
          files: [banner],
        });
        return;
      }

      case "!cupons":
        return handleListCupons(message);

      case "!addcupom":
        return handleAddCupom(message, args);

      case "!rmcupom":
        return handleRmCupom(message, args);
    }
  } catch (err) {
    console.error(`Erro ao processar comando ${cmdLower}:`, err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---------- BOTÕES ----------
    if (interaction.isButton()) {
      // Botões da loja
      switch (interaction.customId) {
        case BTN_BUY_ID: {
          // Cria o ticket já com o carrinho dentro
          await handleCreateShoppingTicket(interaction, VIPS);
          return;
        }

        case BTN_INFO_ID: {
          // Cria um canal temporário pra ver benefícios dos VIPs
          await handleCreateInfoTicket(interaction, VIPS);
          return;
        }

        case BTN_TERMS_ID:
          await interaction.reply({
            embeds: [buildTermsEmbed()],
            flags: MessageFlags.Ephemeral,
          });
          return;

        case BTN_SUPPORT_ID:
          await interaction.reply({
            embeds: [buildSupportEmbed()],
            flags: MessageFlags.Ephemeral,
          });
          return;

        case BTN_HELP_ID:
          await interaction.reply({
            embeds: [buildHelpEmbed()],
            flags: MessageFlags.Ephemeral,
          });
          return;

        // ---------- BOTÕES DO CARRINHO (dentro do ticket) ----------
        case CART_BACK_ID: {
          // Voltar = cancela o pedido fechando o ticket
          if (!getOwnedTicket(interaction.channel.id, interaction.user.id)) {
            return interaction.reply({
              content: "❌ Apenas o dono do ticket pode usar este botão.",
              flags: MessageFlags.Ephemeral,
            });
          }
          await handleCloseTicket(interaction);
          return;
        }

        case CART_CLEAR_ID: {
          if (!getOwnedTicket(interaction.channel.id, interaction.user.id)) {
            return interaction.reply({
              content: "❌ Apenas o dono do ticket pode usar este botão.",
              flags: MessageFlags.Ephemeral,
            });
          }
          const cart = getCart(interaction.user.id);
          cart.items = [];
          cart.couponCode = null;
          await interaction.update(renderCart(cart, VIPS));
          return;
        }

        case CART_COUPON_ID: {
          if (!getOwnedTicket(interaction.channel.id, interaction.user.id)) {
            return interaction.reply({
              content: "❌ Apenas o dono do ticket pode usar este botão.",
              flags: MessageFlags.Ephemeral,
            });
          }
          await showCartCouponModal(interaction);
          return;
        }

        case CART_FINALIZE_ID: {
          if (!getOwnedTicket(interaction.channel.id, interaction.user.id)) {
            return interaction.reply({
              content: "❌ Apenas o dono do ticket pode usar este botão.",
              flags: MessageFlags.Ephemeral,
            });
          }
          const cart = getCart(interaction.user.id);
          await finalizeCartInTicket(interaction, cart, VIPS);
          clearCart(interaction.user.id);
          return;
        }
      }

      // Botões do ticket
      if (interaction.customId === TICKET_CLOSE_ID) {
        await handleCloseTicket(interaction);
        return;
      }
      if (interaction.customId === TICKET_CONFIRM_PAY_ID) {
        await handleConfirmPayment(interaction);
        return;
      }
      if (interaction.customId === COUPON_BUTTON_ID) {
        await showCouponModal(interaction);
        return;
      }
    }

    // ---------- SELECT MENUS ----------
    if (interaction.isStringSelectMenu()) {
      // Seleção de VIP no canal de "Ver Benefícios"
      if (interaction.customId === INFO_VIP_SELECT_ID) {
        await handleInfoVipSelect(interaction, VIPS);
        return;
      }

      // Adicionar / remover produto do carrinho (apenas o dono do ticket)
      if (
        interaction.customId === CART_ADD_ID ||
        interaction.customId === CART_REMOVE_ID
      ) {
        if (!getOwnedTicket(interaction.channel.id, interaction.user.id)) {
          return interaction.reply({
            content: "❌ Apenas o dono do ticket pode usar este menu.",
            flags: MessageFlags.Ephemeral,
          });
        }
        const value = interaction.values[0];
        if (interaction.customId === CART_ADD_ID) {
          addItem(interaction.user.id, value);
        } else {
          removeItem(interaction.user.id, value);
        }
        const cart = getCart(interaction.user.id);
        await interaction.update(renderCart(cart, VIPS));
        return;
      }
    }

    // ---------- MODALS ----------
    if (interaction.isModalSubmit()) {
      // Pedido de VIP Personalizado
      if (interaction.customId === CUSTOM_VIP_MODAL_ID) {
        await handleCustomVipModalSubmit(interaction);
        return;
      }

      // Cupom dentro do carrinho
      if (interaction.customId === CART_COUPON_MODAL_ID) {
        if (!getOwnedTicket(interaction.channel.id, interaction.user.id)) {
          return interaction.reply({
            content: "❌ Apenas o dono do ticket pode aplicar um cupom aqui.",
            flags: MessageFlags.Ephemeral,
          });
        }
        const code = interaction.fields
          .getTextInputValue(CART_COUPON_INPUT_ID)
          .toUpperCase()
          .trim();

        const validation = validateCouponForUser(code, interaction.user.id);
        if (!validation.ok) {
          await interaction.reply({
            content: validation.error,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const cart = getCart(interaction.user.id);
        cart.couponCode = code;
        await interaction.update(renderCart(cart, VIPS));
        return;
      }

      // Cupom dentro do ticket
      if (interaction.customId === COUPON_MODAL_ID) {
        await handleCouponModalSubmit(interaction);
        return;
      }
    }
  } catch (err) {
    console.error("Erro ao processar interação:", err);
    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction
        .reply({
          content: "❌ Ocorreu um erro ao processar sua ação.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
});

// ---------- Login ----------
if (!process.env.TOKEN) {
  console.error("❌ Variável de ambiente TOKEN não definida.");
  process.exit(1);
}

startKeepAliveServer();
client.login(process.env.TOKEN);
