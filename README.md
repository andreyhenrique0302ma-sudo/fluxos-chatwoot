# Fluxos Chatwoot

Painel para criar fluxos de mensagens com botões no WhatsApp (via Chatwoot), disparar para listas de pacientes e acompanhar as respostas.

**Como funciona:** você monta o fluxo (mensagem → botões → próxima mensagem…), dispara para uma lista, e o Chatwoot avisa este sistema (webhook) sempre que o paciente toca num botão. O sistema responde com a próxima etapa. No fim, a conversa ganha uma etiqueta e uma nota interna com as respostas; se o paciente pedir atendente (ou errar 3 vezes), ganha a etiqueta `atendimento-humano` e fica aberta para a equipe.

**Disparo:** na aba Disparar, marque os pacientes direto na lista de conversas do Chatwoot (busca por nome/telefone, filtro por status) — ou cole uma lista `Nome;Telefone`. No modo **Automático**, quem falou nas últimas 24h recebe o fluxo direto e os demais recebem o template da Meta primeiro.

**Editor visual:** cada mensagem é um bloco no canvas. Arraste a bolinha ● de uma saída até outro bloco para conectar (ou solte no vazio para criar um bloco já conectado). Blocos: 💬 Mensagem (envia e segue sozinho), 🔘 Botões (uma saída por botão + uma saída “se digitar em vez de tocar”), ✍️ Pergunta (resposta livre), ✅ Finalizar (mensagem final + etiqueta própria) e 🙋 Atendente (etiqueta `atendimento-humano` + conversa aberta). Saída sem conexão: em Mensagem/Pergunta finaliza o fluxo; em “se digitar” repete as opções.

**Etiquetas:** em ⚙ Configurações do fluxo há ➕ *Etiqueta ao concluir* e ➖ *Remover etiquetas ao concluir* (valem para saídas sem conexão); os blocos ✅ Finalizar e 🙋 Atendente têm os mesmos campos, que têm prioridade quando preenchidos. Ex.: Etapa 2 com ➕ `acesso-liberado` e ➖ `aguardando-liberacao`. As demais etiquetas da conversa são mantidas. Passo a passo de conexão com o Chatwoot: [GUIA-CONECTAR-CHATWOOT.md](GUIA-CONECTAR-CHATWOOT.md).

**Mídias:** qualquer bloco aceita um anexo (📎) — imagem JPG/PNG até 5 MB; vídeo MP4, áudio MP3/OGG/M4A e documentos PDF/Word/Excel até 16 MB. Em imagem, vídeo e documento o texto do bloco vai como legenda; em áudio (o WhatsApp não aceita legenda) e em blocos de botões, a mídia vai primeiro e o texto/botões logo depois. Os arquivos ficam em `data/media` e vão junto no Exportar/Importar.

## 1. Rodar no computador (para testar)

Precisa do Node.js 18 ou mais novo.

```bash
npm install
cp .env.example .env      # e preencha os dados do Chatwoot
npm start                 # abre em http://localhost:3000
```

Onde achar cada dado no Chatwoot:
- **CHATWOOT_ACCOUNT_ID**: número na URL → `/app/accounts/1/...`
- **CHATWOOT_API_TOKEN**: foto do perfil → Configurações do perfil → Token de acesso
- **CHATWOOT_INBOX_ID**: Configurações → Caixas de entrada → abra a do WhatsApp → número no fim da URL

Em localhost você já consegue montar e testar fluxos no simulador, mas o Chatwoot só consegue avisar o sistema quando ele estiver publicado.

## 2. Publicar (obrigatório para funcionar de verdade)

O sistema precisa de um endereço público (https) e precisa ficar ligado o tempo todo. **Não use Vercel** (não mantém os dados nem processo contínuo). Opções:

- **Mesmo servidor do Chatwoot** (melhor, se for self-hosted): `docker build -t fluxos . && docker run -d --restart always -p 3000:3000 --env-file .env -v fluxos-data:/app/data fluxos` e aponte um subdomínio (ex.: `fluxos.renovisaude.com.br`) com HTTPS.
- **Railway / Render**: suba a pasta, configure as variáveis do `.env` no painel e adicione um volume persistente em `/app/data`.

## 3. Ligar no Chatwoot

1. Abra o painel publicado → aba **Configuração** → copie a URL do webhook.
2. Chatwoot → Configurações → Integrações → **Webhooks** → Adicionar → cole a URL → marque **Mensagem criada**.
3. Clique em **Testar conexão** no painel.

## 4. Templates da Meta (importante)

O WhatsApp só deixa a empresa **iniciar** conversa com um template aprovado. Crie no Gerenciador do WhatsApp um template simples, por exemplo:

> Olá, {{1}}! Aqui é da Renovi Saúde. Vamos fazer uma triagem rápida pelo WhatsApp? Leva menos de 2 minutos. [botão: Começar]

Quando o paciente toca em “Começar” (ou responde qualquer coisa), o fluxo começa. Depois disso, as mensagens com botões do fluxo são livres por 24h.

## Limites do WhatsApp

- Até 3 opções → botões. De 4 a 10 → lista (“Ver opções”). Máximo 10.
- Texto do botão: até 20 caracteres (24 em lista).
- Se a caixa do WhatsApp for de API **não oficial**, use `BUTTON_MODE=texto` (as opções viram “1, 2, 3” e o paciente responde com o número).

## Dados

Fica tudo em `data/db.json` (fluxos, pacientes, respostas). Faça backup desse arquivo. A pasta `data` não vai junto ao publicar: para levar fluxos de um painel para outro (ex.: do computador para o sistema publicado), use **⬇ Exportar** no fluxo aberto e **⬆ Importar fluxo** no outro painel — o arquivo leva só o fluxo, sem dados de pacientes. As respostas podem ser exportadas em CSV na aba Acompanhamento.
