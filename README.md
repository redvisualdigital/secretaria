# Secretária RedVisual
Motor das mensagens automáticas de WhatsApp (Uazapi) ligado à agenda (Firestore).
Roda pelo GitHub Actions a cada 5 min, o dia todo. As mensagens só saem na janela definida em `config/secretaria` (Firestore do cliente).
O log não mostra nome, telefone nem texto de cliente.
- `vars.ESSENCE_TESTE`: finais de 8 dígitos liberados (vazio = todas as clientes).
- Liga/desliga e limites: documento `config/secretaria` no Firestore do cliente.
