require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Memoria conversazioni per numero di telefono
const conversazioni = {};

// ── LEGGE LO STATO AGENDA DA SUPABASE ──
async function getContesto() {
  const { data: operatori } = await supabase.from('operatori').select('*');
  const { data: servizi } = await supabase.from('servizi').select('*');
  const { data: clienti } = await supabase.from('clienti').select('*');
  const oggi = new Date().toISOString().split('T')[0];
  const { data: prenotazioni } = await supabase
    .from('prenotazioni').select('*').eq('data', oggi);

  return { operatori, servizi, clienti, prenotazioni, oggi };
}

// ── PROMPT DI SISTEMA ──
function buildPrompt(ctx) {
  const { operatori, servizi, clienti, prenotazioni, oggi } = ctx;

  const agendaTxt = prenotazioni?.length
    ? prenotazioni.map(p =>
        `  • ${p.ora_reale} | ${p.operatore_id} | ${p.cliente_nome} | ${p.servizio_nome}`
      ).join('\n')
    : '  Nessuna prenotazione oggi.';

  return `Sei il receptionist AI di un salone. Oggi è ${oggi}.

OPERATORI:
${operatori.map(o => `  • ${o.nome} (id:${o.id}) turno ${o.turno_inizio}–${o.turno_fine}`).join('\n')}

SERVIZI:
${servizi.map(s => `  • ${s.nome}: ${s.durata_minuti} min`).join('\n')}

CLIENTI REGISTRATI:
${clienti.map(c => `  • ${c.nome} tel:${c.telefono} tipo:${c.tipo} buffer:${c.buffer_minuti}min`).join('\n')}

AGENDA OGGI:
${agendaTxt}

REGOLE:
1. Cliente ritardatario → comunicagli ora anticipata di buffer_minuti, salva ora reale.
2. Cliente chiede operatore specifico occupato da cliente senza preferenza → sposta e libera.
3. Slot ogni 30 min dalle 09:00 alle 18:30. Calcola durata servizio per non sovrapporre.
4. Rispondi SOLO in JSON:
{
  "messaggio": "testo risposta in italiano",
  "azione": "nessuna|prenota|sposta",
  "prenotazione": {
    "cliente_nome": "",
    "operatore_id": "",
    "servizio_nome": "",
    "ora_reale": "HH:MM",
    "ora_comunicata": "HH:MM",
    "tipo_cliente": ""
  }
}
Il campo prenotazione appare solo se azione è prenota o sposta.`;
}

// ── WEBHOOK TWILIO ──
app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();

  if (!conversazioni[from]) conversazioni[from] = [];
  conversazioni[from].push({ role: 'user', content: body });

  try {
    const ctx = await getContesto();
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: buildPrompt(ctx) },
        ...conversazioni[from]
      ],
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    const raw = completion.choices[0].message.content;
    const parsed = JSON.parse(raw);

    conversazioni[from].push({ role: 'assistant', content: raw });

    // Salva prenotazione su Supabase
    if ((parsed.azione === 'prenota' || parsed.azione === 'sposta') && parsed.prenotazione) {
      const p = parsed.prenotazione;
      if (parsed.azione === 'sposta') {
        await supabase.from('prenotazioni')
          .delete()
          .eq('operatore_id', p.operatore_id)
          .eq('ora_reale', p.ora_reale)
          .eq('data', ctx.oggi);
      }
      await supabase.from('prenotazioni').insert({
        operatore_id:   p.operatore_id,
        cliente_nome:   p.cliente_nome,
        servizio_nome:  p.servizio_nome,
        data:           ctx.oggi,
        ora_reale:      p.ora_reale,
        ora_comunicata: p.ora_comunicata
      });
    }

    // Risponde su WhatsApp
    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM,
      to:   from,
      body: parsed.messaggio
    });

    res.sendStatus(200);
  } catch(e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot attivo ✅'));
app.listen(3000, () => console.log('Server avviato su porta 3000'));