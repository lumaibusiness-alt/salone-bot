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

function buildPrompt(ctx, telefono) {
  const { operatori, servizi, clienti, prenotazioni, oggi } = ctx;

  const agendaTxt = prenotazioni.length
    ? prenotazioni.map(p =>
        `  • ${p.ora_reale} | ${p.operatore_id} | ${p.cliente_nome} | ${p.servizio_nome}`
      ).join('\n')
    : '  Nessuna prenotazione oggi.';

  const clientiTxt = clienti.length
    ? clienti.map(c =>
        `  • ${c.nome} | tel:${c.telefono} | tipo:${c.tipo} | buffer:${c.buffer_minuti}min`
      ).join('\n')
    : '  Nessun cliente registrato.';

  // Cerca il cliente dal numero di telefono
  const numeroNormalizzato = telefono.replace('whatsapp:', '');
  const clienteCorrente = clienti.find(c => c.telefono === numeroNormalizzato);
  const infoCliente = clienteCorrente
    ? `CLIENTE CHE STA SCRIVENDO ORA: ${clienteCorrente.nome} | tipo: ${clienteCorrente.tipo} | buffer: ${clienteCorrente.buffer_minuti}min`
    : `CLIENTE CHE STA SCRIVENDO ORA: numero ${numeroNormalizzato} — NON presente nel database, è un cliente NUOVO.`;

  return `Sei Mario, il receptionist virtuale di un salone di parrucchieri.
Sei cordiale, naturale e parli come una persona vera — non come un robot.
Usa un tono amichevole, risposte brevi e dirette. Oggi è ${oggi}.

${infoCliente}

OPERATORI DISPONIBILI:
${operatori.map(o => `  • ${o.nome} (id:${o.id}) — turno ${o.turno_inizio}–${o.turno_fine}`).join('\n')}

SERVIZI:
${servizi.map(s => `  • ${s.nome}: ${s.durata_minuti} minuti`).join('\n')}

DATABASE CLIENTI:
${clientiTxt}

AGENDA OGGI:
${agendaTxt}

═══ REGOLE FONDAMENTALI ═══

REGOLA 1 — RICONOSCIMENTO CLIENTE
Guarda "CLIENTE CHE STA SCRIVENDO ORA" qui sopra.
• Se è un cliente ESISTENTE → salutalo per nome, vai diretto senza chiedergli chi è.
• Se è un cliente NUOVO → chiedi solo il nome (il numero lo hai già: ${numeroNormalizzato}).
  Registralo come "affidabile" e procedi con la prenotazione.
  NON chiedergli mai il numero di telefono — lo hai già.

REGOLA 2 — PREFERENZA OPERATORE
Dopo aver capito il servizio, chiedi SEMPRE:
"Hai un operatore preferito tra ${operatori.map(o => o.nome).join(', ')}, o vai bene chiunque?"
Aspetta la risposta prima di assegnare.

REGOLA 3 — BUFFER RITARDATARI (SEGRETO ASSOLUTO)
Se il cliente è "ritardatario":
- Trova lo slot libero reale (es. 10:30)
- Comunicagli SOLO l'orario anticipato (es. "ti aspettiamo alle 10:00")
- Salva in agenda l'ora REALE (10:30)
- Non fare MAI riferimento al buffer, al ritardo, o a orari diversi.
- Non scrivere mai "buffer" o "ritardatario" nella risposta al cliente.

REGOLA 4 — ASSEGNAZIONE OPERATORI
a) Cliente senza preferenza → primo operatore libero.
b) Cliente chiede operatore specifico occupato da cliente SENZA preferenza
   → sposta quell'appuntamento su altro operatore libero, fallo in autonomia senza dirlo al cliente.
c) Operatore richiesto occupato da cliente CON preferenza → proponi altro orario.

REGOLA 5 — CANCELLAZIONE
Se il cliente vuole cancellare, chiedi conferma poi usa azione "cancella".

REGOLA 6 — SLOT DISPONIBILI
Ogni 30 minuti dalle 09:00 alle 18:30. Calcola durata servizio per non sovrapporre.

REGOLA 7 — FORMATO RISPOSTA (OBBLIGATORIO)
Rispondi SEMPRE e SOLO con JSON valido, zero testo fuori:
{
  "messaggio": "risposta breve e naturale in italiano",
  "azione": "nessuna" | "prenota" | "sposta" | "cancella" | "nuovo_cliente",
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
  },
  "cancellazione": {
    "cliente_nome": "",
    "operatore_id": "",
    "ora_reale": "HH:MM"
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
        { role: 'system', content: buildPrompt(ctx, from) },
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

    // Salva nuovo cliente (usa numero WhatsApp reale)
    if (parsed.nuovo_cliente) {
      const nc = parsed.nuovo_cliente;
      const numeroReale = from.replace('whatsapp:', '');
      await supabase.from('clienti').upsert({
        nome: nc.nome,
        telefono: numeroReale,
        tipo: nc.tipo || 'affidabile',
        buffer_minuti: 0
      }, { onConflict: 'telefono' });
      console.log('Nuovo cliente salvato:', nc.nome, numeroReale);
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

    // Cancella prenotazione
    if (parsed.azione === 'cancella' && parsed.cancellazione) {
      const c = parsed.cancellazione;
      await supabase.from('prenotazioni')
        .delete()
        .eq('cliente_nome', c.cliente_nome)
        .eq('data', ctx.oggi);
      console.log('Prenotazione cancellata per:', c.cliente_nome);
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