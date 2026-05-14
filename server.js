/**
 * PRINTOX BACKEND - Production Server v2.1
 * Stripe Checkout mit TWINT + Kreditkarte
 */

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://xknknlsppivsnkaszzjm.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Webhook - RAW body vor JSON Parser!
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      try {
        const meta = session.metadata || {};
        const { error } = await supabase.from('orders').insert({
          type: 'shop',
          customer_name: meta.customer_name || '',
          customer_email: session.customer_email || meta.customer_email || '',
          customer_address: meta.address || '',
          items: JSON.parse(meta.items || '[]'),
          total: (session.amount_total || 0) / 100,
          payment: 'Kreditkarte / TWINT ✓',
          status: 'new',
          discount: meta.discount || null,
          stripe_session_id: session.id,
        });
        if (error) console.error('Supabase Fehler:', error);
        else console.log('✅ Bestellung gespeichert:', session.id);
      } catch (err) {
        console.error('Fehler:', err);
      }
    }
  }
  res.json({ received: true });
});

// JSON Parser
app.use(express.json());

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'Printox Backend OK ✅', version: '2.1' });
});

// Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { cart, address, customerName, customerEmail, userDiscount, successUrl, cancelUrl } = req.body;

    if (!cart || !cart.length) {
      return res.status(400).json({ error: 'Warenkorb ist leer' });
    }

    // Server-seitige Preisberechnung
    const subtotal = cart.reduce((sum, item) => {
      const unitPrice = item.discount > 0 ? item.price * (1 - item.discount / 100) : item.price;
      return sum + unitPrice * item.qty;
    }, 0);

    const shipping = subtotal >= 100
      ? 0
      : cart.reduce((sum, item) => sum + (item.shipping || 7.90) * item.qty, 0);

    const discountAmount = userDiscount > 0 ? subtotal * userDiscount : 0;

    // Line Items - NUR positive Beträge!
    const lineItems = [];

    // Produkte mit bereits eingerechneten Rabatten
    cart.forEach(item => {
      const unitPrice = item.discount > 0 ? item.price * (1 - item.discount / 100) : item.price;
      const finalPrice = userDiscount > 0 ? unitPrice * (1 - userDiscount) : unitPrice;

      lineItems.push({
        price_data: {
          currency: 'chf',
          product_data: {
            name: item.name + (item.discount > 0 || userDiscount > 0 ? ' (inkl. Rabatt)' : ''),
          },
          unit_amount: Math.max(1, Math.round(finalPrice * 100)), // mind. 1 Rappen
        },
        quantity: item.qty,
      });
    });

    // Versand (0 = gratis)
    if (shipping > 0) {
      lineItems.push({
        price_data: {
          currency: 'chf',
          product_data: { name: '📦 Versand (Post CH)' },
          unit_amount: Math.round(shipping * 100),
        },
        quantity: 1,
      });
    } else {
      lineItems.push({
        price_data: {
          currency: 'chf',
          product_data: { name: '📦 Versand (Gratis ab CHF 100)' },
          unit_amount: 0,
        },
        quantity: 1,
      });
    }

    // Zahlungsmethoden (TWINT wird automatisch hinzugefügt sobald genehmigt)
    const paymentMethods = ['card'];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: paymentMethods,
      line_items: lineItems,
      mode: 'payment',
      currency: 'chf',
      customer_email: customerEmail || undefined,
      success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl,
      metadata: {
        customer_name: customerName || '',
        customer_email: customerEmail || '',
        address: address || '',
        items: JSON.stringify(cart.map(i => ({ name: i.name, qty: i.qty, price: i.price }))),
        discount: userDiscount > 0 ? Math.round(userDiscount * 100) + '%' : '',
      },
      locale: 'de',
    });

    res.json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Checkout Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Session Status
app.get('/session-status', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    res.json({
      status: session.payment_status,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Printox Backend Port ${PORT}`);
  console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? '🟢 LIVE' : '🟡 TEST'}`);
});
