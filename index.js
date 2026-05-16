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

const conversazioni = {};

async function getContesto() {
  const { data: operatori } = await supabase.from('operatori').select('*');
  const { data: servizi } = await supabase.from('servizi').select('*');
  const { data: clienti } = await supabase.from('clienti').select('*');
  const oggi = new Date().toISOString().split('T')[0];
  const { data: prenotazioni } = await supabase
    .from('prenotazioni').select('*').eq('data', oggi);

  return {
    operatori: operatori || [],
    servizi: servizi || [],
    clienti: clienti || [],
    prenotazioni: prenotazioni || [],
    oggi
  };
}

function buildPrompt(ctx) {
  const { operatori, servizi, clienti, prenotazioni, oggi } = ctx;

  const agendaTxt = prenotazioni.length
    ? prenotazioni.map(p => `  • ${p.ora_reale} | ${p.operatore_id} | ${p.cliente_nome} | ${p.servizio_nome}`).join('\n')
    : '  Nessuna prenotazione oggi.';

  const clientiTxt = clienti.length
    ? clienti.map(c => `  • ${c.nome} | tel:${c.telefono} | tipo:${c.tipo} | buffer:${c.buffer_minuti}min`).join('\n')
    : '  Nessun cliente registrato.';

  return `Sei il receptionist AI di un salone di parrucchieri. Oggi è ${oggi}.

OPERATORI:
${operatori.map(o => `  • ${o.nome} (id:${o.id}) — turno ${o.turno_inizio}–${o.turno_fine}`).join('\n')}

SERVIZI:
${servizi.map(s => `  • ${s.nome}: ${s.durata_minuti} minuti`).join('\n')}

DATABASE CLIENTI:
${clientiTxt}

AGENDA OGGI:
${agendaTxt}

REGOLE:
1. Cerca il cliente nel DATABASE CLIENTI per nome o telefono.
   - Trovato = cliente esistente, salutalo per nome.
   - Non trovato = cliente nuovo, chiedi nome e telefono, registralo come "affidabile".
2. Cliente ritardatario: digli orario anticipato di buffer_minuti, salva ora reale. Non dirglielo.
3. Cliente chiede operatore specifico occupato da cliente senza preferenza: sposta e libera.
4. Slot ogni 30 min dalle 09:00 alle 18:30. Calcola durata servizio.

Rispondi SOLO con JSON valido:
{
  "messaggio": "risposta in italiano cordiale",
  "azione": "nessuna" | "prenota" | "sposta" | "nuovo_cliente",
  "prenotazione": {
    "cliente_nome": "",
    "operatore_id": "",
    "servizio_nome": "",
    "ora_reale": "HH:MM",
    "ora_comunicata": "HH:MM",
    "tipo_cliente": ""
  },
  "nuovo_cliente": {
    "nome": "",
    "telefono": "",
    "tipo": "affidabile"
  }
}`;
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();

  console.log(`Messaggio ricevuto da ${from}: ${body}`);

  if (!conversazioni[from]) conversazioni[from] = [];
  conversazioni[from].push({ role: 'user', content: body });

  try {
    const ctx = await getContesto();
    console.log('Contesto caricato:', JSON.stringify(ctx));

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: buildPrompt(ctx) },
        ...conversazioni[from]
      ],
      max_tokens: 800,
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const raw = completion.choices[0].message.content;
    console.log('Risposta Groq:', raw);
    const parsed = JSON.parse(raw);

    conversazioni[from].push({ role: 'assistant', content: raw });

    // Salva nuovo cliente
    if (parsed.nuovo_cliente) {
      const nc = parsed.nuovo_cliente;
      await supabase.from('clienti').upsert({
        nome: nc.nome,
        telefono: nc.telefono,
        tipo: nc.tipo || 'affidabile',
        buffer_minuti: 0
      }, { onConflict: 'telefono' });
      console.log('Nuovo cliente salvato:', nc.nome);
    }

    // Salva prenotazione
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
        operatore_id: p.operatore_id,
        cliente_nome: p.cliente_nome,
        servizio_nome: p.servizio_nome,
        data: ctx.oggi,
        ora_reale: p.ora_reale,
        ora_comunicata: p.ora_comunicata
      });
      console.log('Prenotazione salvata:', p);
    }

    // Risponde su WhatsApp
    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM,
      to: from,
      body: parsed.messaggio
    });

    console.log('Risposta inviata:', parsed.messaggio);
    res.sendStatus(200);

  } catch (e) {
    console.error('ERRORE:', e.message);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot attivo ✅'));
app.listen(3000, () => console.log('Server avviato su porta 3000'));