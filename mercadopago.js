// Integração com a API do Mercado Pago - cria pagamentos PIX dinâmicos
// Documentação: https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post
import { randomUUID } from "node:crypto";

const MP_API_URL = "https://api.mercadopago.com/v1/payments";

export async function createPixPayment({
  amount,
  description,
  payerEmail,
  payerFirstName,
  externalReference,
}) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "MP_ACCESS_TOKEN não está definido nas variáveis de ambiente."
    );
  }

  const body = {
    transaction_amount: Number(amount.toFixed(2)),
    description,
    payment_method_id: "pix",
    payer: {
      email: payerEmail,
      first_name: payerFirstName || "Cliente",
    },
    external_reference: externalReference,
  };

  const resp = await fetch(MP_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg =
      data?.message ||
      data?.error ||
      `Falha ${resp.status} ao criar pagamento Mercado Pago`;
    throw new Error(msg);
  }

  const tx = data?.point_of_interaction?.transaction_data;
  if (!tx?.qr_code || !tx?.qr_code_base64) {
    throw new Error(
      "Resposta do Mercado Pago não retornou QR Code. Verifique a aplicação."
    );
  }

  return {
    paymentId: data.id,
    qrCode: tx.qr_code, // string PIX copia e cola
    qrCodeBase64: tx.qr_code_base64, // imagem PNG em base64
    ticketUrl: tx.ticket_url || null,
    expiresAt: data.date_of_expiration || null,
  };
}
