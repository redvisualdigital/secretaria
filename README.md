# Secretária RedVisual
Motor das mensagens automáticas de WhatsApp (Uazapi) ligado à agenda (Firestore).
Roda pelo GitHub Actions para todas as clientes (Lyslie, Carol): cada execução fica ligada ~5h40 rodando o motor a cada ~2 min. Ajustes (textos, liga/desliga, modo teste) ficam em `config/secretaria` de cada cliente, editáveis pela agenda. Com a secretária desligada, o motor continua ligando o site à agenda.
O log não mostra nome, telefone nem texto de cliente.
- `vars.ESSENCE_TESTE`: finais de 8 dígitos liberados (vazio = todas as clientes).
- Liga/desliga e limites: documento `config/secretaria` no Firestore do cliente.
