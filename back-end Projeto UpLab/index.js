const express = require("express");
const WebSocket = require("ws");
const admin = require("firebase-admin");

// Firebase
const serviceAccount = require("./encurta-c3642-firebase-adminsdk-fbsvc-e271704e56.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Servidor HTTP e WebSocket
const app = express();
const server = app.listen(8080, () =>
  console.log("Servidor rodando na porta 8080")
);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split("?")[1]);
  const chatId = urlParams.get("chatId");

  if (!chatId) {
    ws.send(JSON.stringify({ error: "chatId não fornecido" }));
    ws.close();
    return;
  }

  ws.chatId = chatId;
  console.log(`Cliente conectado à sala ${chatId}`);

  // 1) Carregar histórico de mensagens
  db.collection("chats")
    .doc(chatId)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .get()
    .then((snapshot) => {
      const messages = snapshot.docs.map((doc) => doc.data());
      ws.send(JSON.stringify(messages));
    })
    .catch((error) => {
      console.error(`Erro ao carregar histórico:`, error);
      ws.send(JSON.stringify({ error: "Erro ao carregar histórico" }));
    });

  // Dentro do ws.on("message")
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.send(JSON.stringify({ error: "JSON inválido" }));
    }

    if (msg.type === "typing" || msg.type === "stopTyping") {
      const { from } = msg;

      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === WebSocket.OPEN &&
          client.chatId === chatId
        ) {
          client.send(
            JSON.stringify({
              type: msg.type,
              from,
            })
          );
        }
      });

      return; // <- ESSENCIAL, evita seguir pro restante do código
    }

    // Mensagem normal
    const {
      from,
      fromName,
      fromPhotoURL,
      text,
      timestamp,
      produtoId,
      produtoNome,
    } = msg;

    if (!from || !text) {
      return ws.send(JSON.stringify({ error: "Mensagem inválida" }));
    }

    try {
      const chatRef = db.collection("chats").doc(chatId);

      await chatRef.set(
        {
          participants: chatId.split("-"),
          produtoId: produtoId || "",
          produtoNome: produtoNome || "",
          lastMessage: text,
          lastMessageTimestamp:
            timestamp || admin.firestore.FieldValue.serverTimestamp(),
          usuariosInfo: {
            [from]: {
              nome: fromName || "Anônimo",
              foto: fromPhotoURL || "",
            },
          },
        },
        { merge: true }
      );

      await chatRef.collection("messages").add({
        from,
        fromName: fromName || "Usuário Anônimo",
        text,
        timestamp: timestamp || admin.firestore.FieldValue.serverTimestamp(),
      });

      // Envia para os outros participantes da sala
      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === WebSocket.OPEN &&
          client.chatId === chatId
        ) {
          client.send(
            JSON.stringify({
              from,
              fromName,
              text,
              timestamp,
            })
          );
        }
      });
    } catch (err) {
      console.error("Erro ao processar mensagem:", err);
      ws.send(JSON.stringify({ error: "Erro interno ao enviar mensagem" }));
    }
  });

  ws.on("close", () => {
    console.log(`Cliente desconectado da sala ${chatId}`);
  });

  ws.on("error", (error) => {
    console.error(`Erro no WebSocket [${chatId}]:`, error);
  });
});

// Health check
app.get("/health", (req, res) => res.status(200).send("Servidor OK"));
