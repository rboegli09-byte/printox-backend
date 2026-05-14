/**
 * PRINTOX BACKEND - Production Server
 * ====================================
 * Stripe Checkout mit TWINT + Kreditkarte
 * Webhook-basierte Bestellbestätigung
 * Supabase Datenbankintegration
 */

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://xknknlsppivsnkaszzjm.supabase.co',
  process.env.SUPABASE_SERVICE_KEY // Service Role Key (nicht der publishable!)
);

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Webhook braucht RAW Body (vor JSON-Parser!) ───────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook Signatur-Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Zahlung erfolgreich ───────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Nur wenn wirklich bezahlt (nicht bei "pay later" Methoden)
    if (session.payment_status === 'paid') {
      try {
        const meta = session.metadata;

        // Bestellung in Supabase speichern
        const { error } = await supabase.from('orders').insert({
          type: 'shop',
          customer_name: meta.customer_name,
          customer_email: session.customer_email || meta.customer_email,
          customer_address: meta.address,
          items: JSON.parse(meta.items || '[]'),
          total: session.amount_total / 100, // Stripe gibt Rappen zurück
          payment: session.payment_method_types?.[0] === 'twint' ? 'TWINT' : 'Kreditkarte',
          status: 'new',
          discount: meta.discount || null,
          stripe_session_id: session.id,
        });

        if (error) {
          console.error('Supabase Fehler beim Speichern:', error);
        } else {
          console.log('✅ Bestellung gespeichert:', session.id);
        }
      } catch (err) {
        console.error('Fehler bei Bestellverarbeitung:', err);
      }
    }
  }

  res.json({ received: true });
});

// ── JSON Parser (nach Webhook Route!) ────────────────────────────────────────
app.use(express.json());

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Printox Backend OK ✅', version: '2.0' });
});

// ── Stripe Checkout Session erstellen ────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const {
      cart,           // [{id, name, price, qty, shipping, discount}]
      address,        // "Max Muster, Musterstr. 1, 8000 Zürich"
      customerName,
      customerEmail,
      userDiscount,   // z.B. 0.10 für 10%
      successUrl,
      cancelUrl,
    } = req.body;

    if (!cart || !cart.length) {
      return res.status(400).json({ error: 'Warenkorb ist leer' });
    }

    // ── Server-seitige Preisberechnung ──────────────────────────────────────
    // Zwischensumme mit Produktrabatten
    const subtotal = cart.reduce((sum, item) => {
      const unitPrice = item.discount > 0
        ? item.price * (1 - item.discount / 100)
        : item.price;
      return sum + unitPrice * item.qty;
    }, 0);

    // Versandkosten (gratis ab CHF 100)
    const shipping = subtotal >= 100
      ? 0
      : cart.reduce((sum, item) => sum + (item.shipping || 7.90) * item.qty, 0);

    // Benutzerrabatt (Mitarbeiter/Freunde)
    const discountAmount = userDiscount > 0 ? subtotal * userDiscount : 0;
    const total = subtotal - discountAmount + shipping;

    // Sicherheitscheck: Mindestbetrag CHF 0.50
    if (total < 0.50) {
      return res.status(400).json({ error: 'Betrag zu klein' });
    }

    // ── Stripe Line Items aufbauen ──────────────────────────────────────────
    const lineItems = cart.map(item => {
      const unitPrice = item.discount > 0
        ? item.price * (1 - item.discount / 100)
        : item.price;
      return {
        price_data: {
          currency: 'chf',
          product_data: {
            name: item.name + (item.discount > 0 ? ` (-${item.discount}%)` : ''),
          },
          unit_amount: Math.round(unitPrice * 100), // in Rappen
        },
        quantity: item.qty,
      };
    });

    // Benutzerrabatt als separate Position
    if (discountAmount > 0) {
      lineItems.push({
        price_data: {
          currency: 'chf',
          product_data: { name: `🎁 Rabatt (${Math.round(userDiscount * 100)}%)` },
          unit_amount: -Math.round(discountAmount * 100), // Negativer Betrag
        },
        quantity: 1,
      });
    }

    // Versand als Position
    lineItems.push({
      price_data: {
        currency: 'chf',
        product_data: {
          name: shipping === 0 ? '📦 Versand (Gratis ab CHF 100)' : '📦 Versand (Post CH)',
        },
        unit_amount: Math.round(shipping * 100),
      },
      quantity: 1,
    });

    // ── Checkout Session erstellen ──────────────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'twint'], // TWINT nur wenn von Stripe genehmigt
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
        items: JSON.stringify(cart.map(i => ({
          name: i.name, qty: i.qty, price: i.price
        }))),
        discount: userDiscount > 0 ? Math.round(userDiscount * 100) + '%' : '',
      },
      // Shipping-Adresse anzeigen lassen
      billing_address_collection: 'required',
      locale: 'de',
    });

    res.json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Checkout Session Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Session Status prüfen (nach Rückkehr von Stripe) ─────────────────────────
app.get('/session-status', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Keine Session ID' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      status: session.payment_status,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server starten ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Printox Backend läuft auf Port ${PORT}`);
  console.log(`   Stripe Mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? '🟢 LIVE' : '🟡 TEST'}`);
});
