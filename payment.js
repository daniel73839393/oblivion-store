// Helpers de formatação e embed de pagamento (Mercado Pago PIX)
import { EmbedBuilder, AttachmentBuilder } from "discord.js";

const COLOR = 0x9966cc;

export function formatBRL(value) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// Constrói embed + anexo com o QR Code do Mercado Pago
export function buildMercadoPagoEmbed({
  vipLabel,
  originalPrice,
  discountPercent = 0,
  qrCode,
  qrCodeBase64,
  paymentId,
  ticketUrl,
}) {
  const hasDiscount = discountPercent > 0;
  const finalPrice = originalPrice * (1 - discountPercent / 100);

  const valorLinha = hasDiscount
    ? `~~${formatBRL(originalPrice)}~~  →  **${formatBRL(finalPrice)}**\n🎟️ Desconto de **${discountPercent}%** pelo cupom!`
    : `**${formatBRL(finalPrice)}**`;

  const desc =
    `**Pedido:** ${vipLabel}\n` +
    `**Valor:** ${valorLinha}\n\n` +
    `📲 **Como pagar:**\n` +
    `1️⃣ Abra o app do seu banco\n` +
    `2️⃣ Escolha **PIX → Pagar com QR Code** (escaneie a imagem) ou **PIX Copia e Cola** (use o código abaixo)\n` +
    `3️⃣ Confirme o valor e pague\n\n` +
    `**🔑 PIX Copia e Cola:**\n\`\`\`${qrCode}\`\`\`\n` +
    `_Após o pagamento, a equipe será notificada e seu VIP será liberado neste ticket._`;

  const buffer = Buffer.from(qrCodeBase64, "base64");
  const file = new AttachmentBuilder(buffer, { name: "pix_qrcode.png" });

  const embed = new EmbedBuilder()
    .setTitle("💳 Pagamento via PIX (Mercado Pago)")
    .setColor(COLOR)
    .setDescription(desc)
    .setImage("attachment://pix_qrcode.png")
    .setFooter({ text: `Mercado Pago • Pedido #${paymentId}` });

  if (ticketUrl) {
    embed.setURL(ticketUrl);
  }

  return { embed, file };
}
