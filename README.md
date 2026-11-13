# EcoTire

Sistema web de telemetria e navegação preventiva para reduzir material particulado (PM2.5 e PM10)
gerado pelo desgaste de pneus em veículos eletrificados. Trabalho em grupo de Sistemas Computacionais (SCOM), Unesp.

O projeto é independente: roda em qualquer computador com Node.js, sem depender do Bolt.

## Rodar no seu computador

No Windows, o jeito mais rápido: dê dois cliques em **Iniciar EcoTire.bat**. Ele instala as dependências na primeira vez
e sobe o app em http://localhost:5173. Pelo VS Code:

1. Instale o [Node.js LTS atual](https://nodejs.org) (22.12 ou mais novo; versões anteriores não rodam o Vite 8) e o [VS Code](https://code.visualstudio.com).
2. Abra esta pasta no VS Code (Arquivo > Abrir Pasta).
3. Abra o terminal (Ctrl + ') e rode:

   ```bash
   npm install
   npm run dev
   ```

4. Abra o endereço que aparecer (normalmente http://localhost:5173).

Sem o arquivo `.env`, o app abre em **modo demonstração**: tudo funciona, mas os dados ficam só no navegador e não há login.

## Ligar o banco de dados e o login (Supabase)

1. Crie uma conta gratuita em https://supabase.com e um projeto novo (região São Paulo).
2. No projeto, abra **SQL Editor**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**.
3. Em **Project Settings > API**, copie a *Project URL* e a chave *anon public*.
4. Copie `.env.example` para `.env` e preencha os dois valores.
5. Pare e rode `npm run dev` de novo. A tela de login aparece.

Para a apresentação: em **Authentication > Sign In / Providers > Email**, desligue *Confirm email* se quiser que a conta
funcione na hora, sem precisar clicar no link do e-mail. Em **Authentication > URL Configuration**, coloque em *Site URL*
o endereço onde o app está publicado.

O arquivo `.env` não vai para o GitHub (está no `.gitignore`). A chave *anon* é pública por natureza; quem protege os
dados são as regras RLS do `schema.sql`: cada usuário só lê e altera as próprias viagens e veículos.

## Publicar na internet (grátis, GitHub Pages)

1. Dê dois cliques em **Publicar no GitHub.bat**. Ele salva o código em github.com/akavirto123/ecotire e publica o site.
2. Só na primeira vez: no GitHub, abra o repositório > **Settings > Pages** e escolha **Deploy from a branch**,
   branch **gh-pages**, pasta **/ (root)**.
3. O app fica em https://akavirto123.github.io/ecotire/ (GPS e acelerômetro funcionam, porque é HTTPS).

O site é gerado no seu computador com o seu `.env`, então já sai ligado ao Supabase. A chave usada é a
*publishable*, que pode ficar pública: quem protege os dados são as regras RLS do `schema.sql`.
No Supabase, em **Authentication > URL Configuration**, coloque `https://akavirto123.github.io/ecotire/` em *Site URL*.

## O que o app faz

| Requisito da proposta | Onde está |
| --- | --- |
| Captura de sensores (GPS + acelerômetro) | `src/hooks/useLiveTrip.ts` |
| Cálculo de emissão em tempo real (massa e velocidade) | `src/lib/emissions.ts` |
| Alertas de zonas sensíveis, sonoro e visual | `src/lib/risk.ts`, `src/lib/alerts.ts` |
| Persistência de dados, com login | `src/lib/db.ts`, `src/hooks/useAuth.tsx`, `supabase/schema.sql` |
| Navegação no celular e painel no computador | `src/App.tsx` (layout responsivo) |
| Portabilidade (navegadores modernos, PWA) | Vite + `public/manifest.webmanifest` |

O que o EcoTire faz e Waze / Google Maps não fazem:

- **Saúde do pneu e economia em R$.** Quanto do jogo de pneus já foi gasto, a vida útil projetada no seu estilo e
  quanto a condução suave já economizou. `src/lib/insights.ts`
- **Treinador por voz e replay 3D.** Dicas faladas quando a emissão sobe e, no fim, colunas 3D no mapa mostrando em
  que trecho você mais emitiu. `src/hooks/useLiveTrip.ts`, `src/components/Map3D.tsx`
- **Frota e modo passageiro.** Quem cria a frota recebe um código para convidar; todos veem as notas da semana e só
  o gestor vê quem está na rua agora e onde (a posição é apagada ao fim da viagem). Marcando "estou de passageiro",
  a viagem é registrada sem contar para nota, pneu ou ranking.
- **Mapa de calor da comunidade.** Cada viagem com GPS soma, sem identificação, o PM2.5 emitido em células de ~110 m;
  o botão "Mapa de calor" mostra onde mais se emite.
- **Calibragem e rodízio.** Lembretes a cada 30 dias e a cada 10 mil km monitorados (referências; vale o manual).
- **Foto de perfil** no ranking e na frota (reduzida no próprio aparelho para 96 px).
- **Ranking semanal.** Eco-Score médio da semana ponderado pelos km, só viagens com GPS e mínimo de 5 km; a pessoa
  escolhe um apelido e se quer aparecer. Limitação conhecida: as viagens são gravadas pelo próprio aparelho, então
  alguém com conhecimento técnico conseguiria forjar a nota. Para competição a sério, o cálculo teria de ir para o servidor.
- **Níveis e conquistas.** Pontos por km com Eco-Score alto e por respeitar a velocidade em zonas de escolas e hospitais.
- **IA local, sem custo.** Um modelo de aprendizado de máquina (regressão ridge) treina no próprio navegador com as
  suas viagens e prevê o PM2.5 de cada rota para o seu jeito de dirigir. Não usa serviço pago nem envia dados.
  `src/lib/ai.ts`
- **Horário escolar.** Na entrada e saída de alunos (dias úteis), emitir ao lado de escola pesa o dobro na escolha da rota.

Outros recursos próprios:

- **Rota de menor impacto de particulado.** Compara até 3 rotas pelo PM2.5 estimado e pelo quanto dele é emitido
  junto a escolas e hospitais (Índice de Exposição Sensível), e não por tempo ou combustível. `src/lib/routing.ts`
- **Alerta preditivo.** O aviso sai com cerca de 20 s de antecedência (a distância cresce com a velocidade), por voz,
  som e vibração, com a velocidade recomendada para chegar à zona sem frear forte. `src/lib/risk.ts`
- **Zonas de risco de quatro fontes.** Escolas e hospitais, piso irregular e obras (OpenStreetMap), e zonas reportadas
  pelos próprios usuários no mapa.
- **Efeito do pavimento.** Dentro de trecho de piso irregular a emissão estimada sobe 30%.
- **Simulador de percurso.** Percorre a rota no mapa 3D com os alertas tocando, para demonstrar sem sair de casa.
- **3D em todo o app.** Mapa com prédios, rota animada e zonas em relevo (MapLibre GL + OpenFreeMap); roda completa
  (pneu, aro, disco e pinça) que solta partículas conforme a emissão e carro-conceito realista na garagem, com
  iluminação de estúdio (Three.js).
- **Painel enxuto.** Abre só com Eco-Score, nível e três números; pneu, conquistas, emissões e histórico ficam em
  cartões que expandem ao toque.
- **Tour guiado** na primeira abertura (botão "?" no topo para rever).

## Identidade visual

A identidade "Borracha" vem da lateral de um pneu: preto fosco, letras largas (Archivo expandida) em relevo tom sobre
tom, divisores de banda de rodagem e barras de progresso em segmentos, como indicador de desgaste. O laranja é a cor
de destaque padrão; o botão de paleta no topo troca para Oceano, Floresta ou Ametista (`src/lib/theme.ts`, `src/index.css`).

## Carros 3D por tipo

Hoje todos os veículos usam o mesmo carro-conceito realista e só a pintura muda. Para ter um modelo por carroceria,
coloquem arquivos `.glb` em `public/models` com os nomes `hatch.glb`, `sedan.glb`, `suv.glb` e `pickup.glb`: o app passa
a usá-los automaticamente (centraliza e ajusta o tamanho). Confiram a licença de cada modelo antes de publicar.

## Créditos

- Modelo 3D do carro e da roda: "Car Concept", Khronos Group, a partir de modelo de domínio público de Unity Fan, licença
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Foi comprimido e as texturas com logotipos foram removidas.
  Se o app for publicado, mantenham este crédito.
- Tipografia: Archivo (SIL Open Font License), via Fontsource.
- Mapas: © OpenStreetMap, OpenFreeMap.

## Modelo de emissão (resumo)

```
PM2.5 (mg) = 10,7 mg/km × 0,42 × (massa total / 1400 kg) × f(velocidade) × f(aceleração) × f(pavimento) × distância
PM10 = PM2.5 × (0,60 / 0,42)
```

- 10,7 mg/km de TSP, 60% PM10 e 42% PM2.5: ordem de grandeza do EMEP/EEA Guidebook 2019 para desgaste de pneus de
  automóveis. **Confiram esses números na fonte antes de citar no relatório.**
- Os fatores de massa, velocidade, aceleração e pavimento são simplificações do grupo. O app mostra **estimativas**,
  não medições.
- `npm test` roda os testes do modelo e dos alertas (`src/lib/model.test.ts`).

## Serviços externos usados (todos gratuitos, sem chave)

| Serviço | Para quê |
| --- | --- |
| OpenFreeMap | mapa vetorial 3D |
| OSRM (router.project-osrm.org) | cálculo de rotas |
| Nominatim (OpenStreetMap) | busca de endereços |
| Blocos vetoriais do OpenFreeMap | escolas, hospitais e ruas sem pavimento (fonte principal, rápida) |
| Overpass API | complemento: obras e piso irregular detalhado (costuma ser lento) |

São servidores públicos de demonstração, com limite de uso. Servem para o trabalho; para uso real em escala seria
preciso contratar ou hospedar esses serviços.

## Estrutura

```
src/
  App.tsx                 layout, abas e orquestração
  components/             mapa 3D, pneu 3D, login, painéis
  hooks/                  login, viagem ao vivo, zonas de risco
  lib/                    modelo de emissão, rotas, zonas, alertas, banco
supabase/schema.sql       tabelas e regras de segurança
```
