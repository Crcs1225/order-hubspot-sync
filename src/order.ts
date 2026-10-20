import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Order {
  event: string;
  order_id: string;
  created_at: string;
  customer: { email: string; first_name: string; last_name: string; phone: string };
  items: { sku: string; name: string; qty: number; price: number }[];
  currency: string;
  total: number;
}

export function validateOrder(value: unknown): Order {
  const o = value as Order | null;
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const money = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!o || o.event !== 'order.created' || !text(o.order_id) || o.order_id.length > 100 ||
      !text(o.created_at) || !Number.isFinite(Date.parse(o.created_at)) ||
      !o.customer || !text(o.customer.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.customer.email) ||
      !text(o.customer.first_name) || !text(o.customer.last_name) || !text(o.customer.phone) ||
      !Array.isArray(o.items) || o.items.length === 0 ||
      !o.items.every(i => i && text(i.sku) && text(i.name) && Number.isInteger(i.qty) && i.qty > 0 && money(i.price)) ||
      !text(o.currency) || !/^[A-Z]{3}$/.test(o.currency) || !money(o.total)) {
    throw new Error('Invalid order: expected order.created, order ID, date, customer, items, currency and non-negative total.');
  }
  return o;
}

export function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function dealProperties(order: Order, pipeline: string, stage: string) {
  return {
    dealname: `Order ${order.order_id}`, amount: String(order.total),
    closedate: new Date(order.created_at).toISOString(), pipeline, dealstage: stage,
  };
}
