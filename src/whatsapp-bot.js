require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Client } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.json());

let sock;

// === Connexion PostgreSQL ===
const db = new Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
});

db.connect()
    .then(() => console.log('✅ Connecté à PostgreSQL'))
    .catch((err) => {
        console.error('❌ Erreur PostgreSQL:', err);
        process.exit(1);
    });

// === Variables de suivi des conversations ===
const clientStates = new Map(); // État des conversations par numéro
const activeQuestions = new Map(); // Questions en cours par numéro

// === États possibles d'un client ===
const STATES = {
    INITIAL: 'initial',
    WAITING_RESPONSE: 'waiting_response',
    SURVEY_SENT: 'survey_sent',
    QUESTIONS_MODE: 'questions_mode'
};

// === Fonction pour raccourcir un lien via TinyURL ===
async function shortenTinyUrl(longUrl) {
    try {
        const resp = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
        return resp.data;
    } catch (e) {
        console.error('❌ Erreur TinyURL, lien normal utilisé');
        return longUrl;
    }
}

// === Fonction pour récupérer les données d'un client ===
async function getClientByPhone(numero) {
    try {
        const result = await db.query(
            'SELECT * FROM client WHERE numero_whatsapp = $1',
            [numero]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('❌ Erreur récupération client:', err);
        return null;
    }
}

async function getSurveyIdClient(numero) {
  try {
    const clean = cleanPhoneNumber(numero); // Assure-toi d’unifier le format
    const result = await db.query(
      'SELECT survey_id FROM client WHERE numero_whatsapp = $1',
      [clean]
    );

    if (result.rows.length > 0) {
      return result.rows[0].survey_id;
    } else {
      console.warn(`⚠️ Aucun survey_id trouvé pour le numéro ${clean}`);
      return null;
    }
  } catch (err) {
    console.error('❌ Erreur lors de la récupération du survey_id :', err);
    return null;
  }
}

// === Fonction pour récupérer les questions d'un survey depuis Spring Boot ===
async function getQuestionsForSurvey(surveyId) {
    try {
        const response = await axios.get(`http://localhost:8080/api/clients/questions/${surveyId}`);
        return response.data;
    } catch (error) {
        console.error('❌ Erreur récupération questions:', error.message);
        return [];
    }
}

// === Fonction pour sauvegarder une réponse ===
async function saveResponse(numeroWhatsapp, questionId, questionText, reponse) {
    try {
        await db.query(
            `INSERT INTO reponse_client (numero_whatsapp, question_id, question_text, reponse, recu_le) 
             VALUES ($1, $2, $3, $4, NOW())`,
            [numeroWhatsapp, questionId, questionText, reponse]
        );
        console.log(`✅ Réponse sauvegardée pour ${numeroWhatsapp}: "${reponse}"`);
        return true;
    } catch (err) {
        console.error('❌ Erreur sauvegarde réponse:', err);
        return false;
    }
}

// === Fonction pour vérifier si le client a répondu au questionnaire LimeSurvey ===
async function checkSurveyResponse(client) {
    try {
        // Vérifier dans LimeSurvey si le token a une réponse complète
        // Cette fonction peut être adaptée selon votre API LimeSurvey
        // Pour l'instant, on considère comme non répondu pour tester le workflow
        return false; // Forcer le mode questions pour tester
    } catch (error) {
        console.error('❌ Erreur vérification réponse survey:', error);
        return false;
    }
}

// === Fonction pour mettre à jour le statut du client ===
async function updateClientStatus(numeroWhatsapp, statut) {
    try {
        await db.query(
            'UPDATE client SET statut = $1 WHERE numero_whatsapp = $2',
            [statut, numeroWhatsapp]
        );
        console.log(`✅ Statut mis à jour pour ${numeroWhatsapp}: ${statut}`);
    } catch (err) {
        console.error('❌ Erreur mise à jour statut:', err);
    }
}

// === Fonction pour nettoyer et uniformiser les numéros de téléphone ===
// Nettoie un numéro de téléphone
function cleanPhoneNumber(numero) {
    if (!numero) return '';

    let clean = numero.replace('@s.whatsapp.net', '');     // retire suffixe WhatsApp
    clean = clean.replace(/[\s\-\.]/g, '');                 // supprime espaces, tirets, points
    clean = clean.replace(/^(\+|0)/, '');                   // retire + ou 0 au début

    if (!clean.startsWith('212')) {
        clean = '212' + clean;
    }

    return clean;
}

// Envoie un message WhatsApp à un numéro donné
async function sendWhatsAppMessage(sockInstance, numero, message) {
    if (!numero || !message) return false;

    const clean = cleanPhoneNumber(numero);
    const jid = `${clean}@s.whatsapp.net`;

    try {
        await sockInstance.sendMessage(jid, { text: message });
        console.log(`✅ WhatsApp envoyé à ${jid}: "${message.substring(0, 50)}..."`);
        return true;
    } catch (e) {
        console.error(`❌ Envoi échoué à ${jid} :`, e.message);
        return false;
    }
}

// === Étape 1: Envoi du message initial ===
async function sendInitialMessage(client) {
    const message = `👋 Bonjour ${client.prenom},\n\nJ'espère que vous allez bien ! Nous aimerions avoir votre avis sur notre service.`;
    
    // Nettoyer le numéro de façon uniforme
    const cleanNumber = cleanPhoneNumber(client.numero_whatsapp || client.numeroWhatsapp);
    
    const success = await sendWhatsAppMessage(sock, cleanNumber, message);
    
    if (success) {
        // Marquer l'état comme "en attente de réponse"
        clientStates.set(cleanNumber, {
            state: STATES.WAITING_RESPONSE,
            client: client,
            timestamp: Date.now()
        });
        
        console.log(`⏰ En attente de réponse de ${client.prenom} (${cleanNumber})`);
        console.log(`⏰ Timer de 2 minutes démarré - envoi automatique du survey si pas de réponse`);
        
        // Programmer l'envoi du survey après 2 minutes si pas de réponse
        setTimeout(() => {
            checkAndSendSurvey(client, cleanNumber);
        }, 2 * 60 * 1000); // 2 minutes
    }
    
    return success;
}

// === Étape 3: Envoi du lien du questionnaire ===
async function sendSurveyLink(client, cleanNumber = null) {
    const numero = cleanNumber || cleanPhoneNumber(client.numero_whatsapp || client.numeroWhatsapp);
    const shortLink = await shortenTinyUrl(client.survey_link || client.surveyLink);
    const message = `📝 Merci ! Voici le lien de notre questionnaire :\n\n${shortLink}\n\nCela ne prendra que quelques minutes.`;
    
    const success = await sendWhatsAppMessage(sock, numero, message);
    
    if (success) {
        clientStates.set(numero, {
            state: STATES.SURVEY_SENT,
            client: client,
            timestamp: Date.now()
        });
        
        console.log(`📝 Survey envoyé à ${client.prenom}, vérification dans 5 minutes`);
        
        // Vérifier après 5 minutes si le client a répondu au questionnaire
        setTimeout(() => {
            checkSurveyResponseAndStartQuestions(client, numero);
        }, 1 * 60 * 1000); // 5 minutes
    }
    
    return success;
}

// === Fonction pour vérifier et envoyer le survey si pas de réponse après 2min ===
async function checkAndSendSurvey(client, cleanNumber = null) {
    const numero = cleanNumber || cleanPhoneNumber(client.numero_whatsapp || client.numeroWhatsapp);
    const clientState = clientStates.get(numero);
    
    // Si le client n'a pas encore répondu au message initial
    if (clientState && clientState.state === STATES.WAITING_RESPONSE) {
        console.log(`⏰ Client ${client.prenom} (${numero}) n'a pas répondu dans les 2 minutes`);
        console.log(`📝 Envoi automatique du survey...`);
        await sendSurveyLink(client, numero);
    } else {
        console.log(`✅ Client ${client.prenom} (${numero}) a déjà répondu ou changé d'état`);
    }
}

// === Étape 4: Vérifier la réponse au questionnaire et commencer les questions ===
async function checkSurveyResponseAndStartQuestions(client, cleanNumber = null) {
    const numero = cleanNumber || cleanPhoneNumber(client.numero_whatsapp || client.numeroWhatsapp);
    const hasResponded = await checkSurveyResponse(client);
    
    if (!hasResponded) {
        console.log(`📋 Client ${client.prenom} n'a pas répondu au questionnaire LimeSurvey`);
        console.log(`🔄 Début des questions individuelles...`);
        await startIndividualQuestions(client, numero);
    } else {
        console.log(`✅ Client ${client.prenom} a répondu au questionnaire LimeSurvey`);
        await updateClientStatus(numero, 'Répondu');
        clientStates.delete(numero);
    }
}

async function startIndividualQuestions(client, cleanNumber = null) {
    try {
        const numero = cleanNumber || cleanPhoneNumber(client.numero_whatsapp || client.numeroWhatsapp);

        // ✅ Récupérer le surveyId via la fonction dédiée
        const surveyId = client.survey_id || client.surveyId || await getSurveyIdClient(numero);

        if (!surveyId) {
            console.error(`❌ Aucun surveyId trouvé pour le client ${client.prenom} (${numero})`);
            await sendWhatsAppMessage(sock, numero, "❌ Désolé, aucune question disponible pour le moment.");
            return;
        }

        console.log(`🔍 Récupération des questions pour survey ID: ${surveyId}`);
        const questions = await getQuestionsForSurvey(surveyId);

        if (!questions || questions.length === 0) {
            console.log(`❌ Aucune question trouvée pour le survey ${surveyId}`);
            await sendWhatsAppMessage(sock, numero, "❌ Désolé, aucune question disponible pour le moment.");
            return;
        }

        console.log(`📋 ${questions.length} questions trouvées pour ${client.prenom}`);

        // ✅ Initialiser l'état des questions pour ce client
        activeQuestions.set(numero, {
            questions: questions,
            currentIndex: 0,
            responses: []
        });

        clientStates.set(numero, {
            state: STATES.QUESTIONS_MODE,
            client: client
        });

        // ✅ Envoyer le message d'introduction
        const introMessage = `📋 Nous allons vous poser ${questions.length} questions courtes.\n\nRépondez simplement par message à chaque question.`;
        await sendWhatsAppMessage(sock, numero, introMessage);

        // ✅ Envoyer la première question après 2 secondes
        setTimeout(() => {
            sendNextQuestion(numero);
        }, 2000);
    } catch (error) {
        console.error('❌ Erreur dans startIndividualQuestions:', error.message);
    }
}


// === Fonction pour envoyer la prochaine question ===
async function sendNextQuestion(numeroWhatsapp) {
    const questionState = activeQuestions.get(numeroWhatsapp);
    const clientState = clientStates.get(numeroWhatsapp);
    
    if (!questionState || !clientState) {
        console.log(`❌ État manquant pour ${numeroWhatsapp}`);
        return;
    }
    
    const { questions, currentIndex } = questionState;
    
    if (currentIndex >= questions.length) {
        // Toutes les questions ont été posées
        console.log(`🎉 Toutes les questions répondues pour ${numeroWhatsapp}`);
        const message = "🎉 Merci beaucoup pour vos réponses ! Nous apprécions votre temps et vos commentaires.";
        await sendWhatsAppMessage(sock, numeroWhatsapp, message);
        
        // Nettoyer les états
        activeQuestions.delete(numeroWhatsapp);
        clientStates.delete(numeroWhatsapp);
        
        // Mettre à jour le statut du client
        await updateClientStatus(numeroWhatsapp, 'Répondu');
        return;
    }
    
    const currentQuestion = questions[currentIndex];
    const message = `❓ Question ${currentIndex + 1}/${questions.length}:\n\n${currentQuestion.question}`;
    
    console.log(`❓ Envoi question ${currentIndex + 1}/${questions.length} to ${numeroWhatsapp}`);
    await sendWhatsAppMessage(sock, numeroWhatsapp, message);
}

// === Gestion des messages reçus ===
async function handleIncomingMessage(numero, messageText) {
    // Nettoyer le numéro de façon uniforme
    const cleanNumber = cleanPhoneNumber(numero);
    
    console.log(`📨 Message reçu de ${cleanNumber}: "${messageText}"`);
    
    const clientState = clientStates.get(cleanNumber);
    let client = await getClientByPhone(cleanNumber);
    
    if (!client) {
        console.log(`❌ Client non trouvé pour le numéro ${cleanNumber}`);
        const message = "❌ Désolé, votre numéro n'est pas dans notre base de données.";
        await sendWhatsAppMessage(sock, cleanNumber, message);
        return;
    }
    
    console.log(`🔍 État actuel du client ${client.prenom}: ${clientState ? clientState.state : 'AUCUN'}`);
    
    // Si le client est en mode questions individuelles
    if (clientState && clientState.state === STATES.QUESTIONS_MODE) {
        console.log(`📝 Traitement réponse en mode questions pour ${client.prenom}`);
        const questionState = activeQuestions.get(cleanNumber);
        
        if (questionState) {
            const currentQuestion = questionState.questions[questionState.currentIndex];
            
            console.log(`💾 Sauvegarde réponse: Q${currentQuestion.qid} = "${messageText}"`);
            
            // Sauvegarder la réponse
            await saveResponse(
                cleanNumber,
                currentQuestion.qid,
                currentQuestion.question,
                messageText
            );
            
            // Passer à la question suivante
            questionState.currentIndex++;
            activeQuestions.set(cleanNumber, questionState);
            
            // Attendre 1 seconde puis envoyer la prochaine question
            setTimeout(() => {
                sendNextQuestion(cleanNumber);
            }, 1000);
        }
        return;
    }
    
    // Si le client était en attente de réponse au message initial
    if (clientState && clientState.state === STATES.WAITING_RESPONSE) {
        console.log(`✅ Client ${client.prenom} a répondu au message initial - envoi immédiat du survey`);
        // Utiliser le client de l'état qui a toutes les infos (y compris survey_id)
        await sendSurveyLink(clientState.client);
        return;
    }
    
    // Si le client répond sans être dans un workflow actif
    if (!clientState) {
        console.log(`💬 Message hors workflow de ${client.prenom}`);
        const message = "👋 Merci pour votre message ! Si vous souhaitez participer à notre questionnaire, utilisez la commande appropriée.";
        await sendWhatsAppMessage(sock, cleanNumber, message);
    }
}

// === API pour démarrer le workflow pour tous les clients non répondus ===
app.post('/start-workflow', async (req, res) => {
    try {
        console.log('🚀 Récupération des clients non répondus...');
        
        // Utiliser le bon endpoint
        const response = await axios.get('http://localhost:8080/api/clients/non-respondus');
        const nonRespondusClients = response.data;
        
        console.log(`📋 ${nonRespondusClients.length} clients non répondus trouvés`);
        
        if (nonRespondusClients.length === 0) {
            return res.json({
                message: "Aucun client non répondu trouvé",
                success: 0,
                total: 0
            });
        }
        
        let successCount = 0;
        
        for (const client of nonRespondusClients) {
            console.log(`📤 Envoi à: ${client.prenom} (${client.numeroWhatsapp})`);
            const success = await sendInitialMessage(client);
            if (success) successCount++;
            
            // Attendre 2 secondes entre chaque envoi
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const result = {
            message: `Workflow démarré pour ${successCount}/${nonRespondusClients.length} clients`,
            success: successCount,
            total: nonRespondusClients.length,
            clients: nonRespondusClients.map(c => ({
                nom: c.nom,
                prenom: c.prenom,
                numero: c.numeroWhatsapp
            }))
        };
        
        console.log('✅ Workflow terminé:', result);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Erreur lors du démarrage du workflow:', error.message);
        res.status(500).json({ 
            error: 'Erreur lors du démarrage du workflow',
            details: error.message 
        });
    }
});

// === API pour envoyer un message à un client spécifique ===
app.post('/send-whatsapp-reminder', async (req, res) => {
    const { numero, prenom, link } = req.body;
    
    if (!numero || !link || !prenom) {
        return res.status(400).json({
            error: "Données manquantes",
            required: ["numero", "prenom", "link"]
        });
    }
    
    // Récupérer le client depuis la BD pour avoir toutes les infos
    let client = await getClientByPhone(numero);
    
    if (!client) {
        // Si client pas trouvé, créer un objet minimal
        client = {
            numero_whatsapp: numero,
            prenom: prenom,
            survey_link: link,
            survey_id: null // Sera récupéré plus tard si nécessaire
        };
    }
    
    console.log(`📤 Démarrage workflow pour: ${prenom} (${numero})`);
    
    // Démarrer le workflow avec le message initial
    const success = await sendInitialMessage(client);
    
    if (success) {
        res.json({
            message: "Workflow WhatsApp démarré avec succès",
            client: {
                prenom: prenom,
                numero: numero
            }
        });
    } else {
        res.status(500).json({
            error: "Échec d'envoi du message initial"
        });
    }
});

// === API pour vérifier l'état des clients actifs ===
app.get('/active-clients', (req, res) => {
    const activeClients = [];
    
    for (const [numero, state] of clientStates.entries()) {
        activeClients.push({
            numero: numero,
            prenom: state.client.prenom,
            state: state.state,
            timestamp: new Date(state.timestamp).toISOString()
        });
    }
    
    const activeQuestionClients = [];
    for (const [numero, questionState] of activeQuestions.entries()) {
        activeQuestionClients.push({
            numero: numero,
            currentIndex: questionState.currentIndex,
            totalQuestions: questionState.questions.length
        });
    }
    
    res.json({
        activeClients: activeClients,
        activeQuestions: activeQuestionClients,
        total: activeClients.length
    });
});

// === Initialisation de WhatsApp ===
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: true,
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async ({ connection, qr }) => {
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('📲 Scanne le QR code WhatsApp');
        }
        
        if (connection === 'open') {
            console.log('✅ WhatsApp connecté !');
        }
        
        if (connection === 'close') {
            console.log('❌ Déconnecté. Redémarre le script...');
            process.exit(1);
        }
    });
    
    // Écouter les messages entrants
    sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages;
        
        for (const message of messages) {
            // Ignorer les messages envoyés par le bot lui-même
            if (message.key.fromMe) continue;
            
            // Vérifier si c'est un message texte
            if (message.message?.conversation || message.message?.extendedTextMessage?.text) {
                const messageText = message.message.conversation || message.message.extendedTextMessage.text;
                const senderNumber = message.key.remoteJid;
                
                await handleIncomingMessage(senderNumber, messageText);
            }
        }
    });
}

// === Lancement serveur Express + WhatsApp ===
app.listen(process.env.PORT || 3001, () => {
    console.log(`🚀 Bot WhatsApp API démarré sur http://localhost:${process.env.PORT || 3001}`);
    console.log(`📋 Endpoints disponibles:`);
    console.log(`   POST /start-workflow - Démarre le workflow pour tous les clients non répondus`);
    console.log(`   POST /send-whatsapp-reminder - Envoie le workflow à un client spécifique`);
    console.log(`   GET  /active-clients - Voir les clients en cours de traitement`);
});

startWhatsApp();