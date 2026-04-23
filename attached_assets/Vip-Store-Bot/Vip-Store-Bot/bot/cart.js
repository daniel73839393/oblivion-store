// Sistema de Carrinho de Compras
// - Estado em memória por usuário
// - Renderiza painéis "Selecione um produto" + "Pedido"
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { formatBRL } from "./payment.js";

const COLOR = 0x9966cc;

export const CART_ADD_ID = "cart_add";
export const CART_REMOVE_ID = "cart_remove";
export const CART_BACK_ID = "cart_back";
export const CART_CLEAR_ID = "cart_clear";
export const CART_COUPON_ID = "cart_coupon";
export const CART_FINALIZE_ID = "cart_finalize";
export const CART_COUPON_MODAL_ID = "cart_coupon_modal";
export const CART_COUPON_INPUT_ID = "cart_coupon_code";

export const COUPON_DISCOUNT_PERCENT = 10;

// Carrinhos em memória, por usuário
const carts = new Map();

export function getCart(userId) {
  let cart = carts.get(userId);
  if (!cart) {
    cart = { items: [], couponCode: null };
    carts.set(userId, cart);
  }
  return cart;
}

export function clearCart(userId) {
  carts.delete(userId);
}

export function addItem(userId, vipValue) {
  const cart = getCart(userId);
  cart.items.push(vipValue);
}

export function removeItem(userId, vipValue) {
  const cart = getCart(userId);
  const idx = cart.items.indexOf(vipValue);
  if (idx >= 0) cart.items.splice(idx, 1);
}

// Resumo de quantidades, linhas formatadas, subtotal e qtd. sem preço
export function calcTotals(cart, VIPS) {
  const counts = {};
  for (const v of cart.items) counts[v] = (counts[v] || 0) + 1;

  let subtotal = 0;
  let semPreco = 0;
  const lines = [];
  for (const [val, qty] of Object.entries(counts)) {
    const vip = VIPS.find((v) => v.value === val);
    if (!vip) continue;
    if (typeof vip.price === "number") {
      const lineTotal = vip.price * qty;
      subtotal += lineTotal;
      lines.push(
        `${vip.emoji} **${vip.label}** x${qty} — ${formatBRL(lineTotal)}`
      );
    } else {
      semPreco += qty;
      lines.push(
        `${vip.emoji} **${vip.label}** x${qty} — _Sob consulta_`
      );
    }
  }

  const discountedTotal = cart.couponCode
    ? subtotal * (1 - COUPON_DISCOUNT_PERCENT / 100)
    : subtotal;

  return { counts, lines, subtotal, semPreco, discountedTotal };
}

export function renderCart(cart, VIPS) {
  const { counts, lines, subtotal, semPreco, discountedTotal } = calcTotals(
    cart,
    VIPS
  );
  const totalCount = cart.items.length;

  // Painel 1 - Seleção de produto
  const productEmbed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("📦 Selecione um produto!!")
    .setDescription(
      "⚠️ **Fique atento na hora de adicionar seu produto** para que " +
        "não coloque os itens errados!! Em caso de dúvida, clique em **Dúvidas** na loja.\n\n" +
        "_Escolha um produto para adicionar ao pedido._\n" +
        "_Selecionar novamente adiciona outra unidade._"
    );

  // Painel 2 - Resumo do pedido
  let totalText;
  if (subtotal > 0) {
    if (cart.couponCode) {
      totalText = `~~${formatBRL(subtotal)}~~ → **${formatBRL(discountedTotal)}**\n🎟️ Cupom \`${cart.couponCode}\` aplicado (-${COUPON_DISCOUNT_PERCENT}%)`;
    } else {
      totalText = `**${formatBRL(subtotal)}**`;
    }
  } else {
    totalText = "—";
  }
  if (semPreco > 0) {
    totalText += `\n_+ ${semPreco} item(s) sob consulta_`;
  }

  const cartEmbed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(
      `🧾 Pedido (${totalCount} ${totalCount === 1 ? "item" : "itens"})`
    )
    .setDescription(
      totalCount === 0 ? "_Seu pedido está vazio_" : lines.join("\n")
    )
    .addFields({ name: "📝 Total:", value: totalText })
    .setFooter({ text: "Oblivion Store © 2026" });

  // Componentes
  const productSelect = new StringSelectMenuBuilder()
    .setCustomId(CART_ADD_ID)
    .setPlaceholder("Selecione um produto...")
    .addOptions(
      VIPS.map((v) => ({
        label: v.label,
        value: v.value,
        description:
          typeof v.price === "number"
            ? `R$ ${v.price.toFixed(2).replace(".", ",")}`
            : "Sob consulta",
        emoji: v.emoji,
      }))
    );

  const components = [
    new ActionRowBuilder().addComponents(productSelect),
  ];

  if (totalCount > 0) {
    const removeOptions = Object.entries(counts).map(([val, qty]) => {
      const vip = VIPS.find((v) => v.value === val);
      return {
        label: vip.label,
        value: val,
        description: `Quantidade atual: ${qty}`,
        emoji: vip.emoji,
      };
    });
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(CART_REMOVE_ID)
          .setPlaceholder("Remover uma unidade...")
          .addOptions(removeOptions)
      )
    );
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CART_BACK_ID)
        .setLabel("Voltar")
        .setEmoji("◀️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(CART_CLEAR_ID)
        .setLabel("Limpar")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(totalCount === 0),
      new ButtonBuilder()
        .setCustomId(CART_COUPON_ID)
        .setLabel("Cupom")
        .setEmoji("🎟️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(totalCount === 0),
      new ButtonBuilder()
        .setCustomId(CART_FINALIZE_ID)
        .setLabel("Finalizar")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
        .setDisabled(totalCount === 0)
    )
  );

  return { embeds: [productEmbed, cartEmbed], components };
}

export async function showCartCouponModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(CART_COUPON_MODAL_ID)
    .setTitle("🎟️ Aplicar Cupom de Streamer");

  const input = new TextInputBuilder()
    .setCustomId(CART_COUPON_INPUT_ID)
    .setLabel("Código do cupom")
    .setPlaceholder("Ex: GAULES")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(40)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}
