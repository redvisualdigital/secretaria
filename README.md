# Secretária RedVisual
Motor das mensagens automáticas de WhatsApp (Uazapi) ligado à agenda (Firestore).
Roda pelo GitHub Actions: cada execução fica ligada ~5h40 rodando o motor a cada 2 min; o cron (a cada 20 min) só reinicia o ciclo. As mensagens só saem na janela definida em `config/secretaria` (Firestore do cliente).
O log não mostra nome, telefone nem texto de cliente.
- `vars.ESSENCE_TESTE`: finais de 8 dígitos liberados (vazio = todas as clientes).
- Liga/desliga e limites: documento `config/secretaria` no Firestore do cliente.
