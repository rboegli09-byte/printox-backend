bash

cat << 'EOF'
const express = require('express');
const stripe = require('stripe')('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');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-payment', async (req, res) => {
  try {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'chf',
      payment_method_types: ['card'],
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'OK' }));

app.listen(process.env.PORT || 3000);
EOF
Ausgabe

const express = require('express');
const stripe = require('stripe')('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');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-payment', async (req, res) => {
  try {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'chf',
      payment_method_types: ['card'],
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'OK' }));

app.listen(process.env.PORT || 3000);
