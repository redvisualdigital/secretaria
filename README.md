# Secretária RedVisual
Motor das mensagens automáticas de WhatsApp (Uazapi) ligado à agenda (Firestore).
Roda pelo GitHub Actions a cada 15 min, das 08:00 às 20:59 (Brasília).
- `vars.ESSENCE_TESTE`: finais de 8 dígitos liberados (vazio = todas as clientes).
- Liga/desliga e limites: documento `config/secretaria` no Firestore do cliente.
