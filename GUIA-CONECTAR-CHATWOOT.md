# Guia: conectar o sistema de fluxos ao Chatwoot

Passo a passo para colocar o sistema no ar e ligá-lo ao Chatwoot da Renovi.
Siga na ordem; cada parte diz **onde** a ação acontece:

- 🟦 **Meta** (Gerenciador do WhatsApp)
- 🟩 **Chatwoot**
- 🟪 **Railway** (onde o sistema fica hospedado)
- 🟧 **Painel do sistema** (as abas Fluxos, Disparar, Acompanhamento e Configuração)

Tempo total: cerca de 1 hora, sem contar a aprovação dos templates pela Meta.

---

## Como as peças se conversam

```
            envia mensagens (API)                 entrega no WhatsApp
 SISTEMA  ───────────────────────────►  CHATWOOT  ──────────────────────►  PACIENTE
 (Railway) ◄───────────────────────────            ◄──────────────────────
            avisa cada resposta (webhook)          paciente responde / toca no botão
```

- O **sistema** decide o que mandar e manda pela API do Chatwoot.
- O **Chatwoot** entrega no WhatsApp e, a cada resposta do paciente, avisa o sistema pelo **webhook**.
- Por isso o sistema precisa estar **publicado na internet e ligado 24h**. No computador (localhost) dá para montar e testar fluxos, mas o Chatwoot não consegue avisar as respostas.

---

## Antes de começar: checklist

- [ ] Seu usuário no Chatwoot é **administrador**. Sem isso, não aparecem as telas de Integrações e Etiquetas. Se não for, peça para quem administra.
- [ ] A caixa de entrada do WhatsApp no Chatwoot é da **API oficial (WhatsApp Cloud)**. Templates e botões só funcionam nela.
- [ ] Você tem uma conta na **Railway** (railway.com) com o plano **Hobby**. O plano grátis desliga o sistema e não serve.
- [ ] Os fluxos foram **exportados** do painel do computador (botão **⬇ Exportar** em cada fluxo).

---

## Parte 1 — 🟩 Pegar os 4 dados do Chatwoot

Anote cada um; você vai usar na Parte 3.

| Dado | Onde encontrar | Exemplo |
|---|---|---|
| **Endereço do Chatwoot** | O começo do endereço no navegador, até antes de `/app` | `https://chat.empresa.com.br` |
| **Account ID** | O número que aparece na URL depois de `/accounts/` | `.../app/accounts/`**`3`**`/dashboard` → `3` |
| **Token de acesso** | Clique na sua foto (canto inferior esquerdo) → **Configurações do perfil** → role até **Token de acesso** → copiar | `aB3dE5fG...` |
| **Inbox ID** | **Configurações → Caixas de entrada** → clique na caixa do WhatsApp → o número no fim da URL | `.../settings/inboxes/`**`7`** → `7` |

> ⚠️ **O token funciona como uma senha.** Quem tiver ele consegue mandar mensagens em nome da empresa. Não mande por e-mail ou grupo; cole direto na Railway (Parte 3).
>
> As mensagens enviadas pelo sistema aparecem no Chatwoot como enviadas pelo **dono do token**. Se preferir que apareça outro nome (ex.: "Renovi Automático"), crie um usuário para isso no Chatwoot e use o token dele.

---

## Parte 2 — 🟩 Criar as etiquetas no Chatwoot

O sistema marca as conversas com etiquetas. Crie-as antes, para que apareçam com cor e possam ser usadas como filtro.

**Configurações → Etiquetas → Adicionar etiqueta.** Crie, exatamente com estes nomes:

| Etiqueta | Quando o sistema coloca |
|---|---|
| `atendimento-humano` | Paciente pediu ajuda, foi para o bloco 🙋 Atendente ou errou as opções 3 vezes (a conversa fica **aberta** para a equipe) |
| `fluxo-concluido` | Fluxo terminou e não tem etiqueta própria configurada |
| `aguardando-liberacao` | Fim da Etapa 1 (quando configurado no fluxo, veja a Parte 8) |
| `acesso-liberado` | Fim da Etapa 2 (quando configurado no fluxo, veja a Parte 8) |

Use só letras minúsculas e hífen, sem espaço e sem acento. O sistema já converte o que você digitar no painel para esse formato, mas os nomes no Chatwoot precisam bater.

---

## Parte 3 — 🟪 Publicar o sistema na Railway

### 3.1 Enviar o sistema

Pelo terminal do VS Code, dentro da pasta `fluxos-chatwoot\fluxos-chatwoot` (o Claude pode rodar esses comandos com você):

```bash
npx @railway/cli login     # abre o navegador: clique em "Autorizar"
npx @railway/cli init      # cria o projeto (dê o nome: fluxos-renovi)
npx @railway/cli up        # envia a pasta; a Railway monta o sistema sozinha
```

A Railway usa o `Dockerfile` do projeto. A pasta `data` (seus fluxos locais) e o arquivo `.env` **não** são enviados; isso é proposital.

### 3.2 Configurar as variáveis

No site da Railway: abra o projeto → clique no serviço → aba **Variables** → **New Variable**. Crie uma por uma:

| Nome | Valor |
|---|---|
| `CHATWOOT_URL` | Endereço do Chatwoot (Parte 1), **sem barra no final** |
| `CHATWOOT_ACCOUNT_ID` | Account ID (Parte 1) |
| `CHATWOOT_API_TOKEN` | Token de acesso (Parte 1) |
| `CHATWOOT_INBOX_ID` | Inbox ID (Parte 1) |
| `ADMIN_USER` | Usuário para entrar no painel (ex.: `renovi`) |
| `ADMIN_PASSWORD` | Senha forte para o painel |
| `WEBHOOK_TOKEN` | Um código aleatório longo (veja abaixo) |
| `BUTTON_MODE` | `botoes` |

Para gerar o `WEBHOOK_TOKEN`, rode no terminal e copie o resultado:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

> **Não crie** a variável `PORT`; a Railway define sozinha.
>
> Variáveis opcionais (só se precisar mudar o padrão): `DISPATCH_DELAY_MS` (pausa entre pacientes no disparo, padrão 1500), `STEP_DELAY_MS` (pausa entre mensagens seguidas, padrão 1200), `MEDIA_DELAY_MS` (pausa extra depois de uma mídia, padrão 2500), `HANDOFF_KEYWORDS` (palavras que mandam para o atendente, padrão `atendente,falar com atendente`).

### 3.3 Criar o volume (o passo mais importante)

Sem o volume, **fluxos, mídias e o andamento dos pacientes se perdem toda vez que o sistema reinicia.**

1. No canvas do projeto na Railway, clique com o botão direito (ou `Ctrl+K`) → **Volume** / **Add Volume**.
2. Ligue o volume ao serviço do sistema.
3. **Mount path:** `/app/data`

### 3.4 Gerar o endereço público

Serviço → **Settings** → **Networking** → **Generate Domain**.
Você recebe algo como `https://fluxos-renovi.up.railway.app`, já com https.

> Opcional: para usar `fluxos.renovisaude.com.br`, clique em **Custom Domain** e peça para quem cuida do domínio criar o registro CNAME que a Railway mostrar.

Depois de mudar variáveis ou o volume, a Railway reinicia o sistema sozinha. Espere ficar **Active** (verde).

---

## Parte 4 — 🟧 Testar a conexão

1. Abra o endereço da Parte 3.4 e entre com `ADMIN_USER` e `ADMIN_PASSWORD`.
2. No topo à direita deve aparecer **"Chatwoot conectado · caixa #…"**.
3. Aba **Configuração** → **Testar conexão**. Deve aparecer: `✓ OK — caixa “Nome da caixa” (Channel::Whatsapp …)`.
4. Ainda na aba Configuração, **copie a URL do webhook**. Ela termina com `/webhook/chatwoot?token=...`.

Se der erro, veja a tabela **Problemas comuns** no fim deste guia.

---

## Parte 5 — 🟩 Ligar o webhook no Chatwoot

É isso que faz o sistema "ouvir" as respostas dos pacientes.

1. **Configurações → Integrações → Webhooks → Configurar → Adicionar novo webhook**.
2. **URL:** cole a URL copiada na Parte 4 (com o `?token=...` no final).
3. **Eventos:** marque **Mensagem criada** (`message_created`). Os outros podem ficar desmarcados.
4. Salvar.

---

## Parte 6 — 🟦 Templates da Meta

O WhatsApp só deixa a empresa **iniciar** conversa (ou falar com quem não respondeu nas últimas 24h) usando um **template aprovado**.

1. No **Gerenciador do WhatsApp** → **Modelos de mensagem** → **Criar modelo**.
2. Categoria **Utilidade**, idioma **Português (BR)**, nome só com minúsculas e `_` (ex.: `onboarding_inicio`).
3. Use `{{1}}` onde vai o nome do paciente e preencha o exemplo pedido pela Meta.
4. Botão do tipo **Resposta rápida** (ex.: `Receber orientação`).
5. Aguarde a aprovação.

Recomendado: crie também um template de segurança para a Etapa 2 (ex.: `acesso_liberado`), para os pacientes que passarem das 24h.

Se um template aprovado não aparecer no painel (aba Disparar → **Carregar templates do Chatwoot**), sincronize os templates nas configurações da caixa do WhatsApp no Chatwoot ou digite o nome e o idioma à mão.

---

## Parte 7 — 🟧 Colocar os fluxos no sistema publicado

1. Aba **Fluxos** → **⬆ Importar fluxo** → escolha o arquivo `.json` exportado do computador.
2. Repita para cada fluxo. As mídias (vídeos, imagens, PDFs) vão junto, dentro do arquivo.
3. Abra cada fluxo e clique em **▶ Testar** para conferir.

---

## Parte 8 — 🟧 Etiquetas da Etapa 1 e da Etapa 2

Para a equipe saber quem está esperando liberação e quem já foi liberado:

**Etapa 1** (fluxo → **⚙ Configurações**):
- ➕ Etiqueta ao concluir: `aguardando-liberacao`

**Etapa 2** (fluxo → **⚙ Configurações**):
- ➕ Etiqueta ao concluir: `acesso-liberado`
- ➖ Remover etiquetas ao concluir: `aguardando-liberacao`

Resultado: quando o paciente termina a Etapa 2, a etiqueta `aguardando-liberacao` sai e entra `acesso-liberado`. As outras etiquetas que a conversa já tinha são mantidas.

> Os campos das **⚙ Configurações** valem quando o fluxo termina numa saída **sem conexão**. Se você usar blocos **✅ Finalizar**, cada um tem seus próprios campos ➕/➖; o que ficar vazio no bloco usa o das Configurações.
>
> Caminhos que **não** devem receber `aguardando-liberacao` (ex.: "Preciso de ajuda", "Não") precisam terminar num bloco **🙋 Atendente** ou num **✅ Finalizar** com etiqueta própria; senão recebem a etiqueta padrão do fluxo.

---

## Parte 9 — 🟧 Primeiro teste de verdade (com o seu número)

Antes de qualquer paciente:

1. Mande uma mensagem do **seu celular** para o WhatsApp da empresa. Assim a sua conversa aparece no Chatwoot.
2. Aba **Disparar** → **💬 Conversas do Chatwoot** → marque a **sua** conversa.
3. Escolha o fluxo, modo **Automático** e, se pedir, o template.
4. **🚀 Disparar** e acompanhe no celular:
   - [ ] As mensagens chegam na ordem certa (vídeo/imagem antes do texto seguinte).
   - [ ] O nome aparece no lugar de `{{primeiro_nome}}`.
   - [ ] Os botões aparecem e, ao tocar, a próxima mensagem chega.
   - [ ] No Chatwoot, a conversa ganha a **nota interna** com as respostas e a **etiqueta** certa.
   - [ ] Teste também o caminho "Preciso de ajuda": a conversa deve ficar **aberta** com `atendimento-humano`.
5. Na aba **Acompanhamento**, o seu número aparece com o status certo.

Se tudo bater, pode disparar para os pacientes.

---

## Problemas comuns

| O que aparece | Causa provável | Como resolver |
|---|---|---|
| Topo do painel: "⚠️ Configure o .env" | Falta alguma variável | Confira as 4 variáveis `CHATWOOT_*` na Railway (Parte 3.2) |
| Testar conexão: erro **401** | Token errado ou expirado | Copie o token de novo no Chatwoot e atualize `CHATWOOT_API_TOKEN` |
| Testar conexão: erro **404** | Account ID ou Inbox ID errado | Confira os números na URL do Chatwoot (Parte 1) |
| Lista de conversas vazia na aba Disparar | Filtro "Abertas" sem conversas, ou Inbox ID de outra caixa | Troque o filtro para "Todas"; confira o `CHATWOOT_INBOX_ID` |
| Paciente toca no botão e nada acontece | Webhook não configurado ou URL sem o `?token=` | Refaça a Parte 5 com a URL completa da aba Configuração |
| Fluxo parado em "Aguardando resposta" | O paciente ainda não respondeu o template, ou o webhook não chega | Confira a Parte 5; peça para o paciente tocar no botão do template |
| Disparo com erro em "Ver erros" | Paciente fora das 24h sem template, ou template com nome/idioma errado | Use o modo Automático com template; confira nome e idioma exatos |
| Mensagens saem como "1, 2, 3" em vez de botões | `BUTTON_MODE` está `texto` | Mude para `botoes` (API oficial) |
| Fluxos sumiram depois de um reinício | Volume não criado ou em outro caminho | Crie o volume em `/app/data` (Parte 3.3) e importe os fluxos de novo |
| Etiqueta não aparece colorida no Chatwoot | Etiqueta não criada em Configurações → Etiquetas | Crie com o mesmo nome (Parte 2) |

---

## Resumo rápido

1. 🟩 Pegar endereço, Account ID, token e Inbox ID.
2. 🟩 Criar as etiquetas.
3. 🟪 `railway login` → `init` → `up`; variáveis; volume em `/app/data`; gerar domínio.
4. 🟧 Entrar no painel → **Testar conexão** → copiar URL do webhook.
5. 🟩 Webhook com **Mensagem criada**.
6. 🟦 Templates aprovados na Meta.
7. 🟧 Importar os fluxos e configurar as etiquetas das Etapas 1 e 2.
8. 🟧 Teste com o seu número → depois, pacientes.
